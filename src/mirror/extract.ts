import { asCommunicationUserId } from '../acs/identity.ts';
import { createAcs } from '../acs/client.ts';
import { withRetry } from '../acs/retry.ts';
import { logError } from '../log.ts';
import type { Rec } from './types.ts';

export type ExtractOpts = {
  connectionString: string;
  readerAcsId: string;
  /** If provided, extract only these threads instead of calling listChatThreads. */
  threadIds?: string[];
};

/** Yields raw communication records as extracted from ACS. */
export async function* extractAcs(
  opts: ExtractOpts,
): AsyncGenerator<Rec, void, undefined> {
  const acs = createAcs(opts.connectionString);
  const primaryChat = await acs.chatFor(opts.readerAcsId);

  let threads = new Set(opts.threadIds || []);

  if (!opts.threadIds || opts.threadIds.length === 0) {
    try {
      for await (const t of primaryChat.listChatThreads()) {
        if (t.id) threads.add(t.id);
      }
    } catch (e) {
      logError('listChatThreads failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
  }

  for (const threadId of threads) {
    const tc = primaryChat.getChatThreadClient(threadId);

    // 1. Thread node
    let t: Awaited<ReturnType<typeof tc.getProperties>> | undefined;
    try {
      t = await withRetry(`getThread ${threadId}`, () => tc.getProperties());
    } catch (e) {
      logError(`Cannot get properties for thread ${threadId}`, {
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    yield {
      kind: 'thread',
      ourThreadId: null, // Host mapping takes care of this later
      legacyThreadId: threadId,
      topic: t.topic || '',
      createdOn: t.createdOn ? t.createdOn.toISOString() : null,
      createdByAcsId: asCommunicationUserId(t.createdBy),
      deletedOn: t.deletedOn ? t.deletedOn.toISOString() : null,
      readerAcsId: opts.readerAcsId,
    };

    // 2. Participants
    const participants = await withRetry(`listParticipants ${threadId}`, async () => {
      const out = [];
      for await (const p of tc.listParticipants()) {
        out.push(p);
      }
      return out;
    });

    for (const p of participants) {
      const id = asCommunicationUserId(p.id);
      if (!id) continue;
      yield {
        kind: 'participant',
        legacyThreadId: threadId,
        acsId: id,
        displayName: p.displayName || null,
        ourUserId: null,
      };
    }

    // 3. Messages
    const messages = await withRetry(`listMessages ${threadId}`, async () => {
      const out = [];
      for await (const m of tc.listMessages()) {
        out.push(m);
      }
      return out;
    });

    for (const m of messages) {
      yield {
        kind: 'message',
        legacyThreadId: threadId,
        messageId: m.id,
        type: m.type,
        sequenceId: m.sequenceId,
        content: m.content?.message || null,
        senderAcsId: asCommunicationUserId(m.sender),
        senderDisplayName: m.senderDisplayName || null,
        ourSenderUserId: m.metadata?.originalSenderUserId || null,
        createdOn: m.createdOn ? (m.createdOn instanceof Date ? m.createdOn.toISOString() : new Date(m.createdOn).toISOString()) : new Date().toISOString(),
        editedOn: m.editedOn ? (m.editedOn instanceof Date ? m.editedOn.toISOString() : new Date(m.editedOn).toISOString()) : null,
        deletedOn: m.deletedOn ? (m.deletedOn instanceof Date ? m.deletedOn.toISOString() : new Date(m.deletedOn).toISOString()) : null,
        metadata: m.metadata || null,
      };
    }
  }
}
