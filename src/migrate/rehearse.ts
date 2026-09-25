import { randomUUID } from 'node:crypto';
import { createAcs, probeResource } from '../acs/client.ts';
import { isKnownGuid } from '../acs/identity.ts';
import { listParticipantIds } from '../acs/read.ts';
import { log } from '../log.ts';
import { resolveSentAt, resolveOriginalSenderUserId } from '../acs/identity.ts';

/**
 * rehearse: writes a synthetic thread to the target ACS resource and asserts that:
 * 1. original timestamp renders correctly via our resolver
 * 2. original sender resolves to the right our_user_id
 * 3. a non-system participant can successfully sendMessage
 * 4. participant count matches the source
 *
 * This writes to ACS — it creates a thread, sends messages and deletes the
 * thread — so it takes the same resource guard as `apply`. Pointing a rehearsal
 * at the wrong resource is how you find out that "it only writes a test thread"
 * still meant writing to production.
 */
export async function migrateRehearse(opts: {
  connectionString: string; // The NEW target resource connection string
  targetResourceGuid: string;
  /** Omit when `mint` is set: two identities are created and then removed. */
  systemAcsId?: string;
  nonSystemAcsId?: string;
  /** The UUID attribution is asserted against. Defaults to a random one. */
  nonSystemOurUserId?: string;
  keep?: boolean;
  /**
   * Create the two identities this needs, then delete them again.
   *
   * A fresh target resource has no identities, and ACS only creates them
   * through the API - there is no portal for it. Without this, rehearsing
   * against a new resource requires writing a script first, which is the one
   * thing a rehearsal is supposed to save you from.
   */
  mint?: boolean;
}): Promise<void> {
  const probe = await probeResource(opts.connectionString);
  if (!isKnownGuid(probe.guid)) {
    throw new Error(`Could not probe target ACS: ${probe.error ?? 'unknown error'}`);
  }
  if (probe.guid !== opts.targetResourceGuid) {
    throw new Error(
      `Target GUID mismatch. Expected ${opts.targetResourceGuid}, but target is ${probe.guid}`,
    );
  }

  const acs = createAcs(opts.connectionString);

  // Tracked separately from the ids in use: only identities this run created
  // may be deleted at the end. One passed in belongs to the caller.
  const minted: { communicationUserId: string }[] = [];
  async function identityFor(given: string | undefined, what: string): Promise<string> {
    if (given) return given;
    if (!opts.mint) {
      throw new Error(`--${what} is required (or pass --mint to create one for this run)`);
    }
    const u = await acs.identity.createUser();
    minted.push(u);
    return u.communicationUserId;
  }

  const systemAcsId = await identityFor(opts.systemAcsId, "system-acs-id");
  const nonSystemAcsId = await identityFor(opts.nonSystemAcsId, "non-system-acs-id");
  const nonSystemOurUserId = opts.nonSystemOurUserId ?? randomUUID();
  if (minted.length) {
    log(`rehearse: minted ${minted.length} identity(ies) for this run; they are removed at the end`);
  }

  const sysChat = await acs.chatFor(systemAcsId);

  // 1. Create a thread
  const threadRes = await sysChat.createChatThread({ topic: 'Rehearsal Thread' });
  const threadId = threadRes.chatThread?.id;
  if (!threadId) throw new Error('Failed to create rehearsal thread');

  try {
    // Add participant
    const tc = sysChat.getChatThreadClient(threadId);
    await tc.addParticipants({
      participants: [
        { id: { communicationUserId: systemAcsId } },
        { id: { communicationUserId: nonSystemAcsId } }
      ]
    });

    // Check assertion 4: participant count
    const pCount = (await listParticipantIds(tc)).length;
    if (pCount !== 2) {
      throw new Error(`Assertion 4 failed: expected 2 participants, found ${pCount}`);
    }

    // Send a message as system but attributed to non-system user
    const originalTime = '2022-01-01T12:00:00Z';
    const msgRes = await tc.sendMessage({
      content: 'Rehearsal message',
    }, {
      metadata: {
        originalSenderUserId: nonSystemOurUserId,
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
    if (resolvedSender !== nonSystemOurUserId) {
      throw new Error(`Assertion 2 failed: sender did not resolve to ${nonSystemOurUserId}`);
    }

    // Check assertion 3: non-system participant can send message
    const nonSysChat = await acs.chatFor(nonSystemAcsId);
    const nonSysTc = nonSysChat.getChatThreadClient(threadId);
    await nonSysTc.sendMessage({
      content: 'I can reply!'
    });

    log('rehearse: all 4 assertions passed.');
  } finally {
    // Only ever the thread this run created. Nothing else in the resource is
    // listed, touched or removed.
    if (!opts.keep && threadId) {
      await sysChat.deleteChatThread(threadId);
      log(`rehearse: cleaned up thread ${threadId}`);
    } else if (threadId) {
      log(`rehearse: kept thread ${threadId}`);
    }
    // Identities go after the thread, and only ones minted here. A failure to
    // remove one must not mask the assertion failure that brought us here.
    for (const u of minted) {
      await acs.identity.deleteUser(u).catch(() => undefined);
    }
    if (minted.length && !opts.keep) {
      log(`rehearse: removed ${minted.length} minted identity(ies)`);
    }
  }
}
