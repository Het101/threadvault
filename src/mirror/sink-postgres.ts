import type { PgClient } from '../db/pg.ts';
import type { Rec } from './types.ts';
import { resolveSentAt, resolveOriginalSenderUserId } from '../acs/identity.ts';
import { randomUUID } from 'node:crypto';

/**
 * Upserts a stream of `Rec` rows into the threadvault_* Postgres tables.
 * Safely ignores duplicates (idempotent due to UNIQUE constraints).
 */
export async function sinkPostgres(
  stream: AsyncIterable<Rec>,
  db: PgClient,
): Promise<{ threads: number; participants: number; messages: number }> {
  let stats = { threads: 0, participants: 0, messages: 0 };
  const threadIdCache = new Map<string, string>(); // legacy external id -> threadvault uuid
  const userAcsCache = new Map<string, string>(); // ACS id -> threadvault uuid

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
        ourUserUuid = rec.ourUserId;
      }

      // Standalone identity backfill: mint temporary shadow identities if host sync isn't set up yet
      if (!ourUserUuid) {
        ourUserUuid = randomUUID();
        // Since we don't have resourceGuid explicitly here, we rely on the DB constraints
      }

      const sql = `
        INSERT INTO threadvault_participants (thread_id, our_user_id, acs_id, display_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (thread_id, our_user_id) DO NOTHING;
      `;
      const res = await db.query(sql, [threadUuid, ourUserUuid, rec.acsId, rec.displayName]);
      if (res.rowCount && res.rowCount > 0) stats.participants++;
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

      const originalSenderUserId = resolveOriginalSenderUserId({ metadata: rec.metadata }) || rec.ourSenderUserId;
      const sentAt = resolveSentAt({ createdOn: rec.createdOn, metadata: rec.metadata });

      const sql = `
        INSERT INTO threadvault_messages (
          thread_id, external_message_id, sender_user_id, content, message_type,
          sent_at, edited_at, deleted_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (external_message_id) DO UPDATE SET
          content = EXCLUDED.content,
          edited_at = EXCLUDED.edited_at,
          deleted_at = EXCLUDED.deleted_at;
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
