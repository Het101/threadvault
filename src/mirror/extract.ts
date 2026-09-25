import { asCommunicationUserId } from '../acs/identity.ts';
import { createAcs } from '../acs/client.ts';
import { poolMap } from '../acs/pool.ts';
import { withRetry } from '../acs/retry.ts';
import { log, logError } from '../log.ts';
import type { Rec } from './types.ts';

export type ExtractOpts = {
  connectionString: string;
  readerAcsId: string;
  /** If provided, extract only these threads instead of calling listChatThreads. */
  threadIds?: string[];
  /** Threads walked at once. Messages inside a thread always stay serial. */
  concurrency?: number;
  /**
   * Leave message bodies out of the extract entirely.
   *
   * Bodies are the only PHI this tool writes to disk. Without them the
   * extract still carries every thread, participant, identity, timestamp and
   * attribution field, which is everything `migrate plan` and `migrate
   * verify` read - so the analysis can run against a resource whose contents
   * are not allowed to leave it. `migrate apply` refuses such a dump.
   */
  withoutBodies?: boolean;
};

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Yields raw communication records as extracted from ACS. */
export async function* extractAcs(
  opts: ExtractOpts,
): AsyncGenerator<Rec, void, undefined> {
  const acs = createAcs(opts.connectionString);
  const primaryChat = await acs.chatFor(opts.readerAcsId);

  const threads = new Set(opts.threadIds || []);

  if (!opts.threadIds || opts.threadIds.length === 0) {
    try {
      for await (const t of primaryChat.listChatThreads()) {
        if (t.id) threads.add(t.id);
      }
    } catch (e) {
      // Fatal, not empty. Returning here reported "Threads: 0" and exited 0,
      // so a revoked key or an identity with no access looked exactly like a
      // resource with nothing in it - and the caller would believe it.
      // A failure to read any thread is not a finding about the estate.
      throw new Error(
        `Could not list threads for ${opts.readerAcsId}: ` +
          (e instanceof Error ? e.message : String(e)),
        { cause: e },
      );
    }
  }

  /**
   * Everything for one thread, in replay order. Returned as a group so that
   * pooling threads never interleaves one thread's records with another's.
   *
   * A thread that cannot be read is reported and dropped rather than thrown:
   * one unreadable thread must not end a walk over thousands.
   */
  const extractThread = async (threadId: string): Promise<Rec[]> => {
    const out: Rec[] = [];
    const tc = primaryChat.getChatThreadClient(threadId);

    let t: Awaited<ReturnType<typeof tc.getProperties>>;
    try {
      t = await withRetry(`getThread ${threadId}`, () => tc.getProperties());
    } catch (e) {
      logError(`Cannot get properties for thread ${threadId}`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return out;
    }

    out.push({
      kind: 'thread',
      ourThreadId: null, // Host mapping takes care of this later
      legacyThreadId: threadId,
      topic: t.topic || '',
      createdOn: toIso(t.createdOn),
      createdByAcsId: asCommunicationUserId(t.createdBy),
      deletedOn: toIso(t.deletedOn),
      readerAcsId: opts.readerAcsId,
    });

    try {
      const participants = await withRetry(`listParticipants ${threadId}`, async () => {
        const acc = [];
        for await (const p of tc.listParticipants()) acc.push(p);
        return acc;
      });
      for (const p of participants) {
        const id = asCommunicationUserId(p.id);
        if (!id) continue;
        out.push({
          kind: 'participant',
          legacyThreadId: threadId,
          acsId: id,
          displayName: p.displayName || null,
          ourUserId: null,
        });
      }

      const messages = await withRetry(`listMessages ${threadId}`, async () => {
        const acc = [];
        for await (const m of tc.listMessages()) acc.push(m);
        return acc;
      });
      for (const m of messages) {
        out.push({
          kind: 'message',
          legacyThreadId: threadId,
          messageId: m.id,
          type: m.type,
          sequenceId: m.sequenceId,
          content: opts.withoutBodies ? null : m.content?.message || null,
          senderAcsId: asCommunicationUserId(m.sender),
          senderDisplayName: m.senderDisplayName || null,
          ourSenderUserId: m.metadata?.originalSenderUserId || null,
          createdOn: toIso(m.createdOn) ?? new Date().toISOString(),
          editedOn: toIso(m.editedOn),
          deletedOn: toIso(m.deletedOn),
          metadata: m.metadata || null,
          ...(opts.withoutBodies ? { bodiesOmitted: true as const } : {}),
        });
      }
    } catch (e) {
      // Partial thread: keep what was read, say so, move on. Dropping the whole
      // walk over one thread is how an extract becomes a manual job.
      logError(`Incomplete extract for thread ${threadId}`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }

    return out;
  };

  const ids = [...threads];
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  let failed = 0;
  for await (const group of poolMap(ids, concurrency, extractThread)) {
    if (group.length === 0) failed++;
    yield* group;
  }
  if (failed) {
    logError(`${failed} of ${ids.length} thread(s) could not be extracted`);
  } else if (concurrency > 1) {
    log(`Extracted ${ids.length} thread(s) at concurrency ${concurrency}`);
  }
}
