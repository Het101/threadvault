import { belongsToResource } from '../acs/identity.ts';
import { createAcs } from '../acs/client.ts';
import { pool } from '../acs/pool.ts';
import { listMessageMeta, listParticipantIds } from '../acs/read.ts';
import { withRetry } from '../acs/retry.ts';
import { logError } from '../log.ts';
import type { DoctorInputs } from './checks.ts';

export type ScanResult = {
  acsParticipants: Map<string, string[]>;
  acsMessages: DoctorInputs['acsMessages'];
  acsThreadIds: Set<string>;
  readerAcsId: string | null;
  unreadable: number;
};

function readersFor(
  users: DoctorInputs['users'],
  resourceGuid: string,
): string[] {
  const onResource = users
    .filter((u) => u.acsId && belongsToResource(u.acsId, resourceGuid))
    .map((u) => u.acsId as string);
  const system = users.find(
    (u) => u.isSystem && u.acsId && belongsToResource(u.acsId, resourceGuid),
  );
  const rest = onResource.filter((id) => id !== system?.acsId);
  return system?.acsId ? [system.acsId, ...rest] : rest;
}

/**
 * Walk ACS. Prefer the system identity, then any other identity on this
 * resource. Known thread ids (from the host DB) are always attempted —
 * `listChatThreads` only returns threads the reader already participates in,
 * which is exactly the set that hides the Forbidden-on-reply defect.
 *
 * Message bodies are discarded at the SDK boundary.
 */
export async function scanAcs(opts: {
  connectionString: string;
  users: DoctorInputs['users'];
  knownThreadIds: string[];
  resourceGuid: string;
  concurrency: number;
}): Promise<ScanResult> {
  const empty: ScanResult = {
    acsParticipants: new Map(),
    acsMessages: [],
    acsThreadIds: new Set(),
    readerAcsId: null,
    unreadable: 0,
  };
  const readers = readersFor(opts.users, opts.resourceGuid);
  if (readers.length === 0) return empty;

  const acs = createAcs(opts.connectionString);
  const primary = readers[0]!;
  const chat = await acs.chatFor(primary);

  const threadIds = new Set<string>(opts.knownThreadIds);
  try {
    for await (const th of chat.listChatThreads()) {
      if (th.id) threadIds.add(th.id);
    }
  } catch (e) {
    logError('listChatThreads failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const acsParticipants = new Map<string, string[]>();
  const acsMessages: DoctorInputs['acsMessages'] = [];
  const acsThreadIds = new Set<string>();
  let unreadable = 0;
  const goodReaders = new Set<string>([primary]);

  await pool([...threadIds], opts.concurrency, async (threadId) => {
    const ordered = [
      ...readers.filter((r) => goodReaders.has(r)),
      ...readers.filter((r) => !goodReaders.has(r)),
    ];
    let opened = false;
    for (const cand of ordered) {
      try {
        const c = await acs.chatFor(cand);
        const tc = c.getChatThreadClient(threadId);
        const participantIds = await withRetry(`listParticipants ${threadId}`, () =>
          listParticipantIds(tc),
        );
        const messages = await withRetry(`listMessages ${threadId}`, () =>
          listMessageMeta(tc, threadId),
        );
        acsParticipants.set(threadId, participantIds);
        acsMessages.push(...messages);
        acsThreadIds.add(threadId);
        goodReaders.add(cand);
        opened = true;
        break;
      } catch {
        /* try the next reader */
      }
    }
    if (!opened) unreadable++;
  });

  return {
    acsParticipants,
    acsMessages,
    acsThreadIds,
    readerAcsId: primary,
    unreadable,
  };
}
