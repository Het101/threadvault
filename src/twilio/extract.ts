import { createTwilio, type TwilioAuth, type TwilioSession } from './client.ts';
import { poolMap } from '../acs/pool.ts';
import { logError } from '../log.ts';
import type { Rec } from '../mirror/types.ts';

/**
 * Twilio Conversations to the same `Rec` stream `mirror backfill` already
 * consumes. There is no provider abstraction and none is needed: the interface
 * between a source and the rest of this tool is `AsyncIterable<Rec>`, and has
 * been since the first JSONL dump.
 *
 * Field names stay as they are. `senderAcsId` carries a Twilio author, which
 * reads oddly, but the names are byte-compatible with dumps taken before this
 * existed and renaming them would invalidate every one of them. Read it as "the
 * provider's own identifier for the sender".
 */
export type TwilioExtractOpts = {
  auth: TwilioAuth;
  /** Only these conversation SIDs, instead of walking the whole account. */
  conversationSids?: string[];
  /** Conversations walked at once. Messages within one stay in order. */
  concurrency?: number;
  /** Leave message bodies out. See ExtractOpts in mirror/extract.ts. */
  withoutBodies?: boolean;
  /** Injected by tests. */
  session?: TwilioSession;
};

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * How a participant is identified.
 *
 * A chat participant has an `identity`; one reached over SMS or WhatsApp has no
 * identity at all, only a messaging binding address. Both are the provider's
 * name for that person, so both go in the same field — losing the SMS ones
 * would silently drop participants from a mirrored conversation.
 */
export function participantId(p: {
  identity: string | null;
  messaging_binding: { address?: string | null } | null;
  sid: string;
}): string {
  return p.identity?.trim() || p.messaging_binding?.address?.trim() || p.sid;
}

/** Yields records for one conversation, in replay order. */
async function* forConversation(
  session: TwilioSession,
  sid: string,
  opts: TwilioExtractOpts,
): AsyncGenerator<Rec, void, undefined> {
  for await (const p of session.participants(sid)) {
    yield {
      kind: 'participant',
      legacyThreadId: sid,
      acsId: participantId(p),
      displayName: null,
      // Twilio identities are chosen by the application that created them, so
      // they may already be our user id — but they may equally be a phone
      // number or a nickname, and guessing which is how attribution gets lost.
      ourUserId: null,
    };
  }

  for await (const m of session.messages(sid, 100)) {
    yield {
      kind: 'message',
      legacyThreadId: sid,
      messageId: m.sid,
      type: 'text',
      // Twilio's own per-conversation ordinal. Authoritative, unlike a counter
      // kept here, which would renumber on a partial re-read.
      sequenceId: String(m.index),
      content: opts.withoutBodies ? null : (m.body ?? null),
      senderAcsId: m.author,
      senderDisplayName: null,
      ourSenderUserId: null,
      createdOn: toIso(m.date_created) ?? new Date().toISOString(),
      editedOn: toIso(m.date_updated),
      deletedOn: null,
      metadata: null,
      ...(opts.withoutBodies ? { bodiesOmitted: true as const } : {}),
    };
  }
}

/** Walk Twilio Conversations and yield the same records an ACS walk yields. */
export async function* extractTwilio(
  opts: TwilioExtractOpts,
): AsyncGenerator<Rec, void, undefined> {
  const session = opts.session ?? createTwilio(opts.auth);

  const conversations = new Map<string, { topic: string | null; createdOn: string | null }>();
  if (opts.conversationSids?.length) {
    for (const sid of opts.conversationSids) conversations.set(sid, { topic: null, createdOn: null });
  } else {
    try {
      for await (const c of session.conversations(100)) {
        conversations.set(c.sid, {
          topic: c.friendly_name,
          createdOn: toIso(c.date_created),
        });
      }
    } catch (e) {
      logError('listConversations failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
  }

  // Buffered per conversation so that walking several at once never interleaves
  // one conversation's records with another's - the same rule the ACS walk
  // keeps, for the same reason.
  const readerId = opts.auth.accountSid;
  const groups = poolMap(
    [...conversations.keys()],
    Math.max(1, opts.concurrency ?? 4),
    async (sid: string): Promise<Rec[]> => {
      const meta = conversations.get(sid)!;
      const recs: Rec[] = [
        {
          kind: 'thread',
          ourThreadId: null,
          legacyThreadId: sid,
          topic: meta.topic ?? '',
          createdOn: meta.createdOn,
          createdByAcsId: null,
          deletedOn: null,
          // Twilio has no per-user reader: the account credential sees every
          // conversation. Recording the account is honest about what read it.
          readerAcsId: readerId,
        },
      ];
      try {
        for await (const rec of forConversation(session, sid, opts)) recs.push(rec);
      } catch (e) {
        // One unreadable conversation must not end a walk over thousands. Keep
        // what was read, say so, move on.
        logError('conversation partially read', {
          conversationSid: sid,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return recs;
    },
  );

  for await (const recs of groups) {
    for (const rec of recs) yield rec;
  }
}
