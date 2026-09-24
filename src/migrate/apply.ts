import { createAcs, probeResource } from '../acs/client.ts';
import { isKnownGuid, resolveOriginalSenderUserId } from '../acs/identity.ts';
import { withRetry } from '../acs/retry.ts';
import { log, logError } from '../log.ts';
import { isReplayable, type Rec } from '../mirror/types.ts';

type BufferedParticipant = {
  id: { communicationUserId: string };
  displayName?: string;
};

type BufferedMessage = {
  content: string;
  senderDisplayName: string | undefined;
  metadata: Record<string, string>;
  /** Target-resource identity to send as, if this sender was mapped. */
  senderAcsId: string | null;
};

export type ApplyOpts = {
  connectionString: string;
  sourceStream: AsyncIterable<Rec>;
  targetResourceGuid: string;
  /** Writes nothing unless true. Default is dry-run. */
  commit?: boolean;
  /**
   * old ACS id -> identity on the target resource. Read before minting and
   * mutated in place so the caller can persist it, and a re-run reuses the same
   * identities instead of minting a second orphaned set.
   *
   * Without it the replay mints a throwaway identity for every participant,
   * which means no real user - not even the system user - can open the threads
   * that were just replayed. Losing the map loses the estate.
   */
  identityMap?: Map<string, string>;
};

export type ApplyStats = {
  threads: number;
  participants: number;
  messages: number;
  identitiesMinted: number;
  /** ACS control messages (participantAdded, topicUpdated, ...) not replayed. */
  skipped: number;
};

function replayMetadata(rec: Extract<Rec, { kind: 'message' }>): Record<string, string> {
  const meta: Record<string, string> = rec.metadata ? { ...rec.metadata } : {};
  const ourSender = rec.ourSenderUserId || resolveOriginalSenderUserId({ metadata: rec.metadata });
  if (ourSender) meta.originalSenderUserId = ourSender;
  if (rec.senderAcsId) meta.originalSenderAcsId = rec.senderAcsId;
  meta.originalCreatedOn = rec.createdOn;
  meta.originalMessageId = rec.messageId;
  meta.replayed = 'true';
  return meta;
}

/**
 * Replay a Rec stream onto a target ACS resource.
 *
 * Always restores participants. Always writes originalSenderUserId /
 * originalCreatedOn onto replayed messages. Dry-run unless `commit`.
 */
export async function migrateApply(opts: ApplyOpts): Promise<ApplyStats> {
  const probe = await probeResource(opts.connectionString);
  if (!isKnownGuid(probe.guid)) {
    throw new Error(`Could not probe target ACS: ${probe.error ?? 'unknown error'}`);
  }
  if (probe.guid !== opts.targetResourceGuid) {
    throw new Error(
      `Target GUID mismatch. Expected ${opts.targetResourceGuid}, but target is ${probe.guid}`,
    );
  }

  const stats: ApplyStats = {
    threads: 0,
    participants: 0,
    messages: 0,
    identitiesMinted: 0,
    skipped: 0,
  };

  if (!opts.commit) {
    for await (const rec of opts.sourceStream) {
      if (rec.kind === 'thread') stats.threads++;
      else if (rec.kind === 'participant') stats.participants++;
      else if (rec.kind === 'message') {
        if (isReplayable(rec)) stats.messages++;
        else stats.skipped++;
      }
    }
    const skipNote = stats.skipped ? `, skipping ${stats.skipped} ACS control message(s)` : '';
    log(
      `Dry run: would replay ${stats.threads} thread(s), ${stats.participants} participant(s), ` +
        `${stats.messages} message(s)${skipNote}. Pass --commit to write.`,
    );
    return stats;
  }

  const acs = createAcs(opts.connectionString);
  const migrator = await acs.identity.createUser();
  const migratorId = migrator.communicationUserId;
  const migratorChat = await acs.chatFor(migratorId);

  const targetIdCache = new Map<string, string>();
  const identityCache = opts.identityMap ?? new Map<string, string>();

  const getOrMintIdentity = async (oldAcsId: string): Promise<string> => {
    const hit = identityCache.get(oldAcsId);
    if (hit) return hit;
    const u = await withRetry(`createUser ${oldAcsId}`, () => acs.identity.createUser());
    identityCache.set(oldAcsId, u.communicationUserId);
    stats.identitiesMinted++;
    return u.communicationUserId;
  };

  let bufferParticipants: BufferedParticipant[] = [];
  let bufferMessages: BufferedMessage[] = [];
  let currentLegacyThreadId: string | null = null;

  const flushThread = async () => {
    if (!currentLegacyThreadId) return;
    const targetThreadId = targetIdCache.get(currentLegacyThreadId);
    if (!targetThreadId) {
      bufferParticipants = [];
      bufferMessages = [];
      currentLegacyThreadId = null;
      return;
    }

    log(`Flushing thread ${currentLegacyThreadId} to target ${targetThreadId}`);
    const tc = migratorChat.getChatThreadClient(targetThreadId);

    const batchSize = 50;
    for (let i = 0; i < bufferParticipants.length; i += batchSize) {
      const pBatch = bufferParticipants.slice(i, i + batchSize);
      await withRetry(`addParticipants ${targetThreadId}`, () =>
        tc.addParticipants({ participants: pBatch }),
      );
      stats.participants += pBatch.length;
    }

    const onThread = new Set(bufferParticipants.map((p) => p.id.communicationUserId));
    for (const msg of bufferMessages) {
      // Send as the real sender where we have one on this thread, so the ACS
      // sender and the metadata agree. Sending everything as the migrator is
      // exactly the misattribution `doctor` check 3 exists to catch.
      const asSender = msg.senderAcsId && onThread.has(msg.senderAcsId) ? msg.senderAcsId : null;
      const client = asSender
        ? (await acs.chatFor(asSender)).getChatThreadClient(targetThreadId)
        : tc;
      await withRetry(`sendMessage ${targetThreadId}`, () =>
        client.sendMessage(
          { content: msg.content },
          { senderDisplayName: msg.senderDisplayName, metadata: msg.metadata },
        ),
      );
      stats.messages++;
    }

    bufferParticipants = [];
    bufferMessages = [];
    currentLegacyThreadId = null;
  };

  log(`Starting replay as migrator ${migratorId}`);

  try {
    for await (const rec of opts.sourceStream) {
      if (rec.kind === 'thread') {
        await flushThread();
        currentLegacyThreadId = rec.legacyThreadId;
        log(`Replaying thread ${rec.legacyThreadId}`);
        const res = await withRetry(`createThread ${rec.legacyThreadId}`, () =>
          migratorChat.createChatThread({ topic: rec.topic }),
        );
        if (res.chatThread?.id) {
          targetIdCache.set(rec.legacyThreadId, res.chatThread.id);
          stats.threads++;
        } else {
          logError(`Failed to create target thread for ${rec.legacyThreadId}`);
        }
      } else if (rec.kind === 'participant') {
        if (!currentLegacyThreadId && targetIdCache.has(rec.legacyThreadId)) {
          currentLegacyThreadId = rec.legacyThreadId;
        }
        const newAcsId = await getOrMintIdentity(rec.acsId);
        bufferParticipants.push({
          id: { communicationUserId: newAcsId },
          displayName: rec.displayName || undefined,
        });
      } else if (rec.kind === 'message') {
        if (!currentLegacyThreadId && targetIdCache.has(rec.legacyThreadId)) {
          currentLegacyThreadId = rec.legacyThreadId;
        }
        if (!isReplayable(rec)) {
          stats.skipped++;
          continue;
        }
        bufferMessages.push({
          content: rec.content ?? '',
          senderDisplayName: rec.senderDisplayName || undefined,
          metadata: replayMetadata(rec),
          senderAcsId: rec.senderAcsId ? identityCache.get(rec.senderAcsId) ?? null : null,
        });
      }
    }
    await flushThread();
    log(
      `Migrate apply completed. Threads: ${stats.threads}, ` +
        `Participants: ${stats.participants}, Messages: ${stats.messages}, ` +
        `Identities minted: ${stats.identitiesMinted}, Control skipped: ${stats.skipped}`,
    );
    return stats;
  } finally {
    await acs.identity.deleteUser(migrator).catch(() => undefined);
  }
}
