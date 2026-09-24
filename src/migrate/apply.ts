import { createAcs, probeResource } from '../acs/client.ts';
import { isKnownGuid, resolveOriginalSenderUserId } from '../acs/identity.ts';
import { withRetry } from '../acs/retry.ts';
import { log, logError } from '../log.ts';
import { isReplayable, type Rec } from '../mirror/types.ts';
import { ReplayLedger } from './state.ts';

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
   * Record of what this replay has already done — minted identities and
   * per-thread progress. Pass a persisted one to make the replay resumable;
   * omit it and an interrupted run has no way to avoid duplicating everything
   * it already wrote.
   */
  ledger?: ReplayLedger;
};

export type ApplyStats = {
  threads: number;
  participants: number;
  messages: number;
  identitiesMinted: number;
  /** ACS control messages (participantAdded, topicUpdated, ...) not replayed. */
  skipped: number;
  /** Threads a previous run already finished. */
  threadsResumed: number;
  /** Messages a previous run already delivered. */
  messagesAlreadySent: number;
};

/**
 * What one person is called in the ledger.
 *
 * Our own UUID where we have it, because that is the identifier that survives
 * a resource change — the ACS id is the thing that does not. Keying on the ACS
 * id means somebody who was re-minted at some point arrives on the new resource
 * as two different people, which is the misattribution this tool exists to
 * prevent. Falls back to the ACS id for a JSONL extract, which carries no UUID.
 */
function identityKey(ourUserId: string | null, acsId: string): string {
  const ours = ourUserId?.trim();
  return ours ? ours : acsId;
}

/**
 * The target identity to send a message as.
 *
 * Tries our UUID first: `sourcePostgres` deliberately emits a null senderAcsId,
 * so a mirror replay resolved by ACS id alone would find nobody and send every
 * message as the migrator — exactly the wrong-author defect `doctor` check 3
 * reports.
 */
function senderIdentity(
  ledger: ReplayLedger,
  rec: Extract<Rec, { kind: 'message' }>,
): string | null {
  const ours = rec.ourSenderUserId?.trim() || resolveOriginalSenderUserId({ metadata: rec.metadata });
  if (ours) {
    const hit = ledger.identities.get(ours);
    if (hit) return hit;
  }
  return rec.senderAcsId ? ledger.identities.get(rec.senderAcsId) ?? null : null;
}

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
 *
 * Resumable when given a persisted ledger: finished threads are skipped
 * entirely and a half-delivered thread continues from the message it reached,
 * so an interrupted replay can be re-run without duplicating the estate.
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
    threadsResumed: 0,
    messagesAlreadySent: 0,
  };

  const ledger = opts.ledger ?? ReplayLedger.ephemeral();

  if (!opts.commit) {
    for await (const rec of opts.sourceStream) {
      if (rec.kind === 'thread') {
        if (ledger.isDone(rec.legacyThreadId)) stats.threadsResumed++;
        else stats.threads++;
      } else if (rec.kind === 'participant') {
        if (!ledger.isDone(rec.legacyThreadId)) stats.participants++;
      } else if (rec.kind === 'message') {
        if (ledger.isDone(rec.legacyThreadId)) stats.messagesAlreadySent++;
        else if (isReplayable(rec)) stats.messages++;
        else stats.skipped++;
      }
    }
    const skipNote = stats.skipped ? `, skipping ${stats.skipped} ACS control message(s)` : '';
    const resumeNote = stats.threadsResumed
      ? ` Skipping ${stats.threadsResumed} thread(s) a previous run already finished.`
      : '';
    log(
      `Dry run: would replay ${stats.threads} thread(s), ${stats.participants} participant(s), ` +
        `${stats.messages} message(s)${skipNote}.${resumeNote} Pass --commit to write.`,
    );
    return stats;
  }

  const acs = createAcs(opts.connectionString);
  const migrator = await acs.identity.createUser();
  const migratorId = migrator.communicationUserId;
  const migratorChat = await acs.chatFor(migratorId);

  const getOrMintIdentity = async (key: string): Promise<string> => {
    const hit = ledger.identities.get(key);
    if (hit) return hit;
    const u = await withRetry(`createUser ${key}`, () => acs.identity.createUser());
    ledger.recordIdentity(key, u.communicationUserId);
    stats.identitiesMinted++;
    return u.communicationUserId;
  };

  let bufferParticipants: BufferedParticipant[] = [];
  let bufferMessages: BufferedMessage[] = [];
  let currentLegacyThreadId: string | null = null;

  const flushThread = async () => {
    const legacyId = currentLegacyThreadId;
    const reset = () => {
      bufferParticipants = [];
      bufferMessages = [];
      currentLegacyThreadId = null;
    };
    if (!legacyId) return reset();

    const progress = ledger.threads.get(legacyId);
    if (!progress) return reset();

    const targetThreadId = progress.target;
    // Messages this thread already delivered on an earlier run. Sending them
    // again is the duplicate-estate failure the ledger exists to prevent.
    const alreadySent = progress.messages;

    log(
      `Flushing thread ${legacyId} to target ${targetThreadId}` +
        (alreadySent ? ` (resuming after ${alreadySent} message(s))` : ''),
    );
    const tc = migratorChat.getChatThreadClient(targetThreadId);

    // Participants are added before any message, so a thread that has already
    // delivered one has its participants in place.
    if (alreadySent === 0) {
      const batchSize = 50;
      for (let i = 0; i < bufferParticipants.length; i += batchSize) {
        const pBatch = bufferParticipants.slice(i, i + batchSize);
        await withRetry(`addParticipants ${targetThreadId}`, () =>
          tc.addParticipants({ participants: pBatch }),
        );
        stats.participants += pBatch.length;
      }
    }

    const onThread = new Set(bufferParticipants.map((p) => p.id.communicationUserId));
    let delivered = alreadySent;
    for (const msg of bufferMessages.slice(alreadySent)) {
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
      delivered++;
      stats.messages++;
      ledger.recordThread(legacyId, { target: targetThreadId, messages: delivered, done: false });
    }

    ledger.recordThread(legacyId, { target: targetThreadId, messages: delivered, done: true });
    reset();
  };

  log(`Starting replay as migrator ${migratorId}`);

  try {
    for await (const rec of opts.sourceStream) {
      if (rec.kind === 'thread') {
        await flushThread();
        if (ledger.isDone(rec.legacyThreadId)) {
          // Already replayed end to end. Do not create it again.
          stats.threadsResumed++;
          log(`Skipping thread ${rec.legacyThreadId} — already replayed`);
          continue;
        }
        currentLegacyThreadId = rec.legacyThreadId;
        log(`Replaying thread ${rec.legacyThreadId}`);

        const resumed = ledger.threads.get(rec.legacyThreadId);
        if (resumed) {
          // Created by an earlier run that died before finishing it. Reuse the
          // thread rather than stranding it and making a second one.
          stats.threads++;
          continue;
        }

        const res = await withRetry(`createThread ${rec.legacyThreadId}`, () =>
          migratorChat.createChatThread({ topic: rec.topic }),
        );
        if (res.chatThread?.id) {
          ledger.recordThread(rec.legacyThreadId, {
            target: res.chatThread.id,
            messages: 0,
            done: false,
          });
          stats.threads++;
        } else {
          logError(`Failed to create target thread for ${rec.legacyThreadId}`);
          currentLegacyThreadId = null;
        }
      } else if (rec.kind === 'participant') {
        if (ledger.isDone(rec.legacyThreadId)) continue;
        if (!currentLegacyThreadId && ledger.threads.has(rec.legacyThreadId)) {
          currentLegacyThreadId = rec.legacyThreadId;
        }
        const newAcsId = await getOrMintIdentity(identityKey(rec.ourUserId, rec.acsId));
        bufferParticipants.push({
          id: { communicationUserId: newAcsId },
          displayName: rec.displayName || undefined,
        });
      } else if (rec.kind === 'message') {
        if (ledger.isDone(rec.legacyThreadId)) {
          stats.messagesAlreadySent++;
          continue;
        }
        if (!currentLegacyThreadId && ledger.threads.has(rec.legacyThreadId)) {
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
          senderAcsId: senderIdentity(ledger, rec),
        });
      }
    }
    await flushThread();
    log(
      `Migrate apply completed. Threads: ${stats.threads}, ` +
        `Participants: ${stats.participants}, Messages: ${stats.messages}, ` +
        `Identities minted: ${stats.identitiesMinted}, Control skipped: ${stats.skipped}` +
        (stats.threadsResumed ? `, Threads already done: ${stats.threadsResumed}` : ''),
    );
    return stats;
  } finally {
    await acs.identity.deleteUser(migrator).catch(() => undefined);
  }
}
