import type { PgClient } from '../db/pg.ts';
import type { Rec } from './types.ts';
import { parseAcsId, resolveSentAt, resolveOriginalSenderUserId } from '../acs/identity.ts';
import { createHash } from 'node:crypto';

/**
 * A stable stand-in `our_user_id` for a participant the host has not mapped yet.
 *
 * Must be derived, never random: the participant PK is (thread_id, our_user_id),
 * so a fresh UUID per run makes ON CONFLICT never fire and every re-run adds a
 * duplicate participant row. Derived from the ACS id, re-running is a no-op.
 * Name-based UUIDv5 shape so it is obviously synthetic next to a real host id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The mirror stores our user ids in `uuid` columns, because the domain rule is
 * that attribution is our UUID and never a provider identity.
 *
 * Checked here rather than left to Postgres. The driver answers
 * `invalid input syntax for type uuid: "u-alice-0001"` with no field, no
 * record and no hint that a UUID was ever required - and by then a thread row
 * has already been written, because the backfill is not one transaction.
 */
function requireUuid(value: string, field: string, legacyThreadId: string): string {
  if (UUID.test(value)) return value;
  throw new Error(
    `${field} is not a UUID: ${JSON.stringify(value)} (thread ${legacyThreadId}). ` +
      `The mirror keys attribution on your own user id and stores it as a uuid. ` +
      `Map your ids to UUIDs in the extract, or leave the field null to have a ` +
      `stand-in derived. Re-running after fixing it updates rows rather than ` +
      `duplicating them, so a partial run is safe to repeat.`,
  );
}

export function shadowUserId(acsId: string): string {
  const h = createHash('sha1').update(`threadvault:shadow:${acsId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Upserts a stream of `Rec` rows into the threadvault_* Postgres tables.
 *
 * Re-running is both safe and useful. A second pass refreshes every column the
 * source is authoritative for — attribution above all. The conflict clause used
 * to update only content and the edit/delete stamps, so a mirror taken before
 * identities were known kept its null sender_user_id forever: you could fix the
 * mapping, run it again, and nothing would change. Repair is the point of
 * running it twice.
 */
export async function sinkPostgres(
  stream: AsyncIterable<Rec>,
  db: PgClient,
): Promise<{ threads: number; participants: number; messages: number; identities: number }> {
  const stats = { threads: 0, participants: 0, messages: 0, identities: 0 };
  const threadIdCache = new Map<string, string>(); // legacy external id -> threadvault uuid
  const userAcsCache = new Map<string, string>(); // ACS id -> threadvault uuid
  const identitiesSeen = new Set<string>(); // our_user_id|resource_guid already counted

  // Fetch all known users up front for fast sync
  const knownUsers = await db.query<{ our_user_id: string; acs_id: string }>(
    `SELECT our_user_id, acs_id FROM threadvault_identities`
  );
  for (const row of knownUsers.rows) {
    userAcsCache.set(row.acs_id, row.our_user_id);
  }

  // NOTE: In production we'd do batched upsert.
  // We're iterating serially, which is fine for the ACS iterator speed.
  for await (const rec of stream) {
    if (rec.kind === 'thread') {
      const sql = `
        INSERT INTO threadvault_threads (external_id, topic, created_on, metadata)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (external_id) DO UPDATE SET
          topic = EXCLUDED.topic,
          created_on = EXCLUDED.created_on,
          metadata = EXCLUDED.metadata
        RETURNING id;
      `;
      const res = await db.query<{ id: string }>(sql, [
        rec.legacyThreadId,
        rec.topic,
        rec.createdOn ? new Date(rec.createdOn) : new Date(),
        rec.createdByAcsId ? JSON.stringify({ createdByAcsId: rec.createdByAcsId }) : null,
      ]);
      const uuid = res.rows[0]?.id;
      if (uuid) {
        threadIdCache.set(rec.legacyThreadId, uuid);
      }
      stats.threads++;
    }

    if (rec.kind === 'participant') {
      let threadUuid = threadIdCache.get(rec.legacyThreadId);
      if (!threadUuid) {
        const res = await db.query<{ id: string }>('SELECT id FROM threadvault_threads WHERE external_id = $1', [rec.legacyThreadId]);
        if (res.rows.length === 0) continue;
        const row = res.rows[0];
        if (!row) continue;
        threadUuid = row.id;
        threadIdCache.set(rec.legacyThreadId, threadUuid);
      }

      let ourUserUuid = userAcsCache.get(rec.acsId);
      if (!ourUserUuid && rec.ourUserId) {
        ourUserUuid = requireUuid(rec.ourUserId, 'ourUserId', rec.legacyThreadId);
      }

      // No host mapping for this ACS id yet. Stand in with a derived id so the
      // row is still there to be re-pointed later, and so re-running is a no-op.
      if (!ourUserUuid) ourUserUuid = shadowUserId(rec.acsId);

      const sql = `
        INSERT INTO threadvault_participants (thread_id, our_user_id, acs_id, display_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (thread_id, our_user_id) DO NOTHING;
      `;
      const res = await db.query(sql, [threadUuid, ourUserUuid, rec.acsId, rec.displayName]);
      if (res.rowCount && res.rowCount > 0) stats.participants++;

      // Record who this is on which resource. Nothing else writes this table,
      // so without it the mirror can never map an ACS id back to a person: the
      // cache above starts empty on every run, every participant becomes a
      // fresh shadow, and `doctor` reading the mirror finds nobody to check.
      // The resource GUID is already inside the ACS id, so no extra input is
      // needed to fill it in.
      const parsed = parseAcsId(rec.acsId);
      if (parsed) {
        await db.query(
          `INSERT INTO threadvault_identities (our_user_id, acs_id, resource_guid, display_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (our_user_id, resource_guid) DO UPDATE SET
             acs_id = EXCLUDED.acs_id,
             display_name = COALESCE(EXCLUDED.display_name, threadvault_identities.display_name)`,
          [ourUserUuid, rec.acsId, parsed.resourceGuid, rec.displayName],
        );
        userAcsCache.set(rec.acsId, ourUserUuid);
        // Per identity, not per upsert. One person in three threads is three
        // upserts and one row, and the old count said three.
        const key = `${ourUserUuid}|${parsed.resourceGuid}`;
        if (!identitiesSeen.has(key)) {
          identitiesSeen.add(key);
          stats.identities++;
        }
      }
    }

    if (rec.kind === 'message') {
      let threadUuid = threadIdCache.get(rec.legacyThreadId);
      if (!threadUuid) {
        const res = await db.query<{ id: string }>('SELECT id FROM threadvault_threads WHERE external_id = $1', [rec.legacyThreadId]);
        if (res.rows.length === 0) continue;
        const row = res.rows[0];
        if (!row) continue;
        threadUuid = row.id;
        threadIdCache.set(rec.legacyThreadId, threadUuid);
      }

      const rawSender =
        resolveOriginalSenderUserId({ metadata: rec.metadata }) || rec.ourSenderUserId;
      const originalSenderUserId = rawSender
        ? requireUuid(rawSender, 'ourSenderUserId', rec.legacyThreadId)
        : rawSender;
      const sentAt = resolveSentAt({ createdOn: rec.createdOn, metadata: rec.metadata });

      const sql = `
        INSERT INTO threadvault_messages (
          thread_id, external_message_id, sender_user_id, content, message_type,
          sent_at, edited_at, deleted_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (external_message_id) DO UPDATE SET
          sender_user_id = EXCLUDED.sender_user_id,
          content = EXCLUDED.content,
          message_type = EXCLUDED.message_type,
          sent_at = EXCLUDED.sent_at,
          edited_at = EXCLUDED.edited_at,
          deleted_at = EXCLUDED.deleted_at,
          metadata = EXCLUDED.metadata;
      `;
      const res = await db.query<{id: string}>(sql, [
        threadUuid,
        rec.messageId,
        originalSenderUserId || null,
        rec.content,
        rec.type,
        new Date(sentAt),
        rec.editedOn ? new Date(rec.editedOn) : null,
        rec.deletedOn ? new Date(rec.deletedOn) : null,
        rec.metadata ? JSON.stringify(rec.metadata) : null,
      ]);
      if (res.rowCount && res.rowCount > 0) stats.messages++;
    }
  }

  return stats;
}
