import type { PgClient } from '../db/pg.ts';
import type { Rec } from './types.ts';

type ThreadRow = {
  id: string;
  external_id: string | null;
  topic: string | null;
  created_on: Date | null;
  metadata: unknown;
};

type ParticipantRow = {
  acs_id: string | null;
  display_name: string | null;
  our_user_id: string;
};

type MessageRow = {
  external_message_id: string | null;
  sender_user_id: string | null;
  content: string | null;
  message_type: string | null;
  sent_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  metadata: unknown;
};

function asMeta(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function createdByAcsId(metadata: unknown): string | null {
  const meta = asMeta(metadata);
  return meta?.createdByAcsId ?? null;
}

/**
 * Stream threadvault_* tables as Rec in extract order: each thread, then its
 * participants, then its messages (sent_at ascending so ACS sequence stays intact).
 */
export async function* sourcePostgres(db: PgClient): AsyncIterable<Rec> {
  const threads = await db.query<ThreadRow>(
    `SELECT id, external_id, topic, created_on, metadata
     FROM threadvault_threads
     WHERE external_id IS NOT NULL
     ORDER BY created_on NULLS LAST, id`,
  );

  for (const t of threads.rows) {
    if (!t.external_id) continue;
    yield {
      kind: 'thread',
      ourThreadId: t.id,
      legacyThreadId: t.external_id,
      topic: t.topic || '',
      createdOn: t.created_on ? t.created_on.toISOString() : null,
      createdByAcsId: createdByAcsId(t.metadata),
      deletedOn: null,
      readerAcsId: '',
    };

    const participants = await db.query<ParticipantRow>(
      `SELECT acs_id, display_name, our_user_id
       FROM threadvault_participants
       WHERE thread_id = $1`,
      [t.id],
    );
    for (const p of participants.rows) {
      if (!p.acs_id) continue;
      yield {
        kind: 'participant',
        legacyThreadId: t.external_id,
        acsId: p.acs_id,
        displayName: p.display_name,
        ourUserId: p.our_user_id,
      };
    }

    const messages = await db.query<MessageRow>(
      `SELECT external_message_id, sender_user_id, content, message_type,
              sent_at, edited_at, deleted_at, metadata
       FROM threadvault_messages
       WHERE thread_id = $1
       ORDER BY sent_at ASC, external_message_id ASC`,
      [t.id],
    );
    for (const m of messages.rows) {
      if (!m.external_message_id) continue;
      const metadata = asMeta(m.metadata);
      yield {
        kind: 'message',
        legacyThreadId: t.external_id,
        messageId: m.external_message_id,
        type: m.message_type || 'text',
        sequenceId: '',
        content: m.content,
        // Deliberately null, never metadata.originalSenderAcsId: that names an
        // identity on a resource that may no longer exist. Attribution travels
        // as ourSenderUserId. Reading it here would feed a dead id back into
        // `migrate plan`'s stale count and into the next replay's metadata.
        senderAcsId: null,
        senderDisplayName: null,
        ourSenderUserId: m.sender_user_id,
        createdOn: m.sent_at.toISOString(),
        editedOn: m.edited_at ? m.edited_at.toISOString() : null,
        deletedOn: m.deleted_at ? m.deleted_at.toISOString() : null,
        metadata,
      };
    }
  }
}
