import { createAcs } from '../acs/client.ts';
import { log } from '../log.ts';
import type { Rec } from '../mirror/types.ts';
import { resolveSentAt, resolveOriginalSenderUserId } from '../acs/identity.ts';

/**
 * rehearse: writes a synthetic thread to the target ACS resource and asserts that:
 * 1. original timestamp renders correctly via our resolver
 * 2. original sender resolves to the right our_user_id
 * 3. a non-system participant can successfully sendMessage
 * 4. participant count matches the source
 */
export async function migrateRehearse(opts: {
  connectionString: string; // The NEW target resource connection string
  systemAcsId: string;
  nonSystemAcsId: string;
  nonSystemOurUserId: string;
  keep?: boolean;
}): Promise<void> {
  const acs = createAcs(opts.connectionString);
  const sysChat = await acs.chatFor(opts.systemAcsId);

  // 1. Create a thread
  const threadRes = await sysChat.createChatThread({ topic: 'Rehearsal Thread' });
  const threadId = threadRes.chatThread?.id;
  if (!threadId) throw new Error('Failed to create rehearsal thread');

  let success = false;
  try {
    // Add participant
    const tc = sysChat.getChatThreadClient(threadId);
    await tc.addParticipants({
      participants: [
        { id: { communicationUserId: opts.systemAcsId } },
        { id: { communicationUserId: opts.nonSystemAcsId } }
      ]
    });

    // Check assertion 4: participant count
    let pCount = 0;
    for await (const p of tc.listParticipants()) {
      pCount++;
    }
    if (pCount !== 2) {
      throw new Error(`Assertion 4 failed: expected 2 participants, found ${pCount}`);
    }

    // Send a message as system but attributed to non-system user
    const originalTime = '2022-01-01T12:00:00Z';
    const msgRes = await tc.sendMessage({
      content: 'Rehearsal message',
    }, {
      metadata: {
        originalSenderUserId: opts.nonSystemOurUserId,
        originalCreatedOn: originalTime,
        replayed: 'true'
      }
    });

    // Read it back
    const msg = await tc.getMessage(msgRes.id);

    // Check assertion 1: timestamp
    const resolvedTime = resolveSentAt({
      createdOn: msg.createdOn?.toISOString(),
      metadata: msg.metadata
    });
    if (new Date(resolvedTime).getTime() !== new Date(originalTime).getTime()) {
      throw new Error(`Assertion 1 failed: timestamp did not resolve to ${originalTime}`);
    }

    // Check assertion 2: sender
    const resolvedSender = resolveOriginalSenderUserId({ metadata: msg.metadata });
    if (resolvedSender !== opts.nonSystemOurUserId) {
      throw new Error(`Assertion 2 failed: sender did not resolve to ${opts.nonSystemOurUserId}`);
    }

    // Check assertion 3: non-system participant can send message
    const nonSysChat = await acs.chatFor(opts.nonSystemAcsId);
    const nonSysTc = nonSysChat.getChatThreadClient(threadId);
    await nonSysTc.sendMessage({
      content: 'I can reply!'
    });

    success = true;
    log('rehearse: all 4 assertions passed.');
  } finally {
    if (!opts.keep && threadId) {
      await sysChat.deleteChatThread(threadId);
      log(`rehearse: cleaned up thread ${threadId}`);
    } else if (threadId) {
      log(`rehearse: kept thread ${threadId}`);
    }
  }

  if (!success) {
    throw new Error('Rehearsal failed.');
  }
}
