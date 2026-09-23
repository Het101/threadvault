import { createAcs, probeResource } from '../acs/client.ts';
import { resolveOriginalSenderUserId } from '../acs/identity.ts';
import { withRetry } from '../acs/retry.ts';
import { log, logError } from '../log.ts';
import type { Rec } from '../mirror/types.ts';
import type { PgClient } from '../db/pg.ts';

export type ApplyOpts = {
  connectionString: string;
  sourceStream: AsyncIterable<Rec>;
  db?: PgClient; // Optional: If we want to persist minted identities to DB
  targetResourceGuid: string;
};

export async function migrateApply(opts: ApplyOpts) {
  const acs = createAcs(opts.connectionString);
  const probe = await probeResource(opts.connectionString);
  
  if (probe.guid !== opts.targetResourceGuid) {
    throw new Error(`Target GUID mismatch. Expected ${opts.targetResourceGuid}, but target is ${probe.guid}`);
  }

  // Create a migrating system identity to orchestrate the thread creations
  const migrator = await acs.identity.createUser();
  const migratorId = migrator.communicationUserId;
  const migratorChat = await acs.chatFor(migratorId);

  const targetIdCache = new Map<string, string>(); // legacy thread id -> target thread id
  const identityCache = new Map<string, string>(); // legacy acsId -> target acsId

  const getOrMintIdentity = async (oldAcsId: string): Promise<string> => {
    if (identityCache.has(oldAcsId)) return identityCache.get(oldAcsId)!;
    const u = await acs.identity.createUser();
    const newId = u.communicationUserId;
    identityCache.set(oldAcsId, newId);
    return newId;
  };

  let bufferParticipants: any[] = [];
  let bufferMessages: any[] = [];
  let currentLegacyThreadId: string | null = null;
  
  const flushThread = async () => {
    if (!currentLegacyThreadId) return;
    const targetThreadId = targetIdCache.get(currentLegacyThreadId);
    if (!targetThreadId) return;

    log(`Flushing thread ${currentLegacyThreadId} to target ${targetThreadId}`);
    const tc = migratorChat.getChatThreadClient(targetThreadId);

    // 1. Add all buffered participants
    if (bufferParticipants.length > 0) {
      // ACS allows up to 200 participants per add attempt, but let's batch in 50s
      const batchSize = 50;
      for (let i = 0; i < bufferParticipants.length; i += batchSize) {
        const pBatch = bufferParticipants.slice(i, i + batchSize);
        await withRetry(`addParticipants ${targetThreadId}`, () => tc.addParticipants({ participants: pBatch }));
      }
    }

    // 2. Play all buffered messages in sequence
    // Sort by sequenceId (messageId parsing or createdOn fallback if needed)
    // Rec stream normally guarantees chronological order because we extract in order.
    for (const msg of bufferMessages) {
      await withRetry(`sendMessage ${targetThreadId}`, () => tc.sendMessage({
        content: msg.content ?? '',
      }, {
        senderDisplayName: msg.senderDisplayName,
        metadata: msg.metadata || {}
      }));
    }

    bufferParticipants = [];
    bufferMessages = [];
    currentLegacyThreadId = null;
  };

  log(`Starting replay as migrator ${migratorId}`);
  
  try {
    for await (const rec of opts.sourceStream) {
      if (rec.kind === 'thread') {
        await flushThread(); // flush previous thread if any

        currentLegacyThreadId = rec.legacyThreadId;
        log(`Replaying thread ${rec.legacyThreadId}`);
        
        const res = await withRetry(`createThread ${rec.legacyThreadId}`, () => migratorChat.createChatThread({ 
          topic: rec.topic 
        }));
        
        if (res.chatThread?.id) {
          targetIdCache.set(rec.legacyThreadId, res.chatThread.id);
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
          displayName: rec.displayName || undefined
        });
        
      } else if (rec.kind === 'message') {
        if (!currentLegacyThreadId && targetIdCache.has(rec.legacyThreadId)) {
          currentLegacyThreadId = rec.legacyThreadId;
        }

        // We emit the message as the migrator identity, but carry the metadata
        // for `originalSenderUserId` based on source metadata or our mapping
        
        let meta: Record<string, string> = rec.metadata ? { ...rec.metadata } : {};
        if (rec.ourSenderUserId) {
          meta.originalSenderUserId = rec.ourSenderUserId;
        }
        if (rec.senderAcsId) {
          meta.originalSenderAcsId = rec.senderAcsId;
        }
        meta.originalCreatedOn = rec.createdOn;
        meta.originalMessageId = rec.messageId;
        meta.replayed = 'true';

        bufferMessages.push({
          content: rec.content,
          senderDisplayName: rec.senderDisplayName,
          metadata: meta
        });
      }
    }

    // Flush the last thread
    await flushThread();

    log('Migrate apply completed.');
  } finally {
    // Delete the migrator identity if possible
    await acs.identity.deleteUser(migrator).catch(() => undefined);
  }
}
