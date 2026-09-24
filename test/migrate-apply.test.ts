import { describe, expect, it, vi, beforeEach } from 'vitest';
import { migrateApply } from '../src/migrate/apply.ts';
import type { Rec } from '../src/mirror/types.ts';
import { ReplayLedger } from '../src/migrate/state.ts';

const createdUsers: string[] = [];
const createdThreads: Array<{ topic: string }> = [];
const addedParticipants: Array<{ id: { communicationUserId: string }; displayName?: string }> = [];
const sentMessages: Array<{ content: string; metadata?: Record<string, string> }> = [];

vi.mock('../src/acs/client.ts', () => {
  return {
    probeResource: vi.fn().mockResolvedValue({
      host: 'mock.communication.azure.com',
      guid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    }),
    createAcs: vi.fn().mockImplementation(() => {
      let n = 0;
      return {
        identity: {
          createUser: vi.fn().mockImplementation(async () => {
            n += 1;
            const communicationUserId = `8:acs:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_u${n}`;
            createdUsers.push(communicationUserId);
            return { communicationUserId };
          }),
          deleteUser: vi.fn().mockResolvedValue(undefined),
        },
        chatFor: vi.fn().mockResolvedValue({
          createChatThread: vi.fn().mockImplementation(async (body: { topic: string }) => {
            createdThreads.push(body);
            return { chatThread: { id: `thread-${createdThreads.length}` } };
          }),
          getChatThreadClient: vi.fn().mockReturnValue({
            addParticipants: vi.fn().mockImplementation(async (body: { participants: typeof addedParticipants }) => {
              for (const p of body.participants) addedParticipants.push(p);
            }),
            sendMessage: vi.fn().mockImplementation(async (body: { content: string }, opts?: { metadata?: Record<string, string> }) => {
              sentMessages.push({ content: body.content, metadata: opts?.metadata });
              return { id: `msg-${sentMessages.length}` };
            }),
          }),
        }),
      };
    }),
  };
});

async function* recs(items: Rec[]): AsyncIterable<Rec> {
  for (const item of items) yield item;
}

const fixture: Rec[] = [
  {
    kind: 'thread',
    ourThreadId: null,
    legacyThreadId: '19:old@thread.v2',
    topic: 'Care thread',
    createdOn: '2022-01-01T00:00:00.000Z',
    createdByAcsId: '8:acs:old_sys',
    deletedOn: null,
    readerAcsId: '8:acs:old_sys',
  },
  {
    kind: 'participant',
    legacyThreadId: '19:old@thread.v2',
    acsId: '8:acs:old_sys',
    displayName: 'System',
    ourUserId: 'u-sys',
  },
  {
    kind: 'participant',
    legacyThreadId: '19:old@thread.v2',
    acsId: '8:acs:old_user',
    displayName: 'Patient',
    ourUserId: 'u-user',
  },
  {
    kind: 'message',
    legacyThreadId: '19:old@thread.v2',
    messageId: 'm-1',
    type: 'text',
    sequenceId: '1',
    content: 'lorem ipsum',
    senderAcsId: '8:acs:old_user',
    senderDisplayName: 'Patient',
    ourSenderUserId: 'u-user',
    createdOn: '2022-01-01T12:00:00.000Z',
    editedOn: null,
    deletedOn: null,
    metadata: null,
  },
];

describe('migrateApply', () => {
  beforeEach(() => {
    createdUsers.length = 0;
    createdThreads.length = 0;
    addedParticipants.length = 0;
    sentMessages.length = 0;
  });

  it('dry-run counts records and writes nothing', async () => {
    const stats = await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(fixture),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    expect(stats).toMatchObject({ threads: 1, participants: 2, messages: 1, identitiesMinted: 0, skipped: 0 });
    expect(createdThreads).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  it('refuses when ACS_EXPECT_RESOURCE does not match the probed GUID', async () => {
    await expect(
      migrateApply({
        connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
        sourceStream: recs(fixture),
        targetResourceGuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        commit: true,
      }),
    ).rejects.toThrow(/Target GUID mismatch/);
    expect(createdThreads).toHaveLength(0);
  });

  it('replays participants and stamps originalSenderUserId + originalCreatedOn', async () => {
    const stats = await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(fixture),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
    });
    expect(stats.threads).toBe(1);
    expect(stats.participants).toBe(2);
    expect(stats.messages).toBe(1);
    expect(addedParticipants).toHaveLength(2);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.metadata?.originalSenderUserId).toBe('u-user');
    expect(sentMessages[0]?.metadata?.originalCreatedOn).toBe('2022-01-01T12:00:00.000Z');
    expect(sentMessages[0]?.metadata?.replayed).toBe('true');
    expect(sentMessages[0]?.metadata?.originalSenderAcsId).toBe('8:acs:old_user');
  });
});

describe('migrateApply regressions', () => {
  beforeEach(() => {
    createdUsers.length = 0;
    createdThreads.length = 0;
    addedParticipants.length = 0;
    sentMessages.length = 0;
  });

  const control: Rec = {
    kind: 'message',
    legacyThreadId: '19:old@thread.v2',
    messageId: 'm-ctl',
    type: 'participantAdded',
    sequenceId: '2',
    content: null,
    senderAcsId: '8:acs:old_sys',
    senderDisplayName: null,
    ourSenderUserId: null,
    createdOn: '2022-01-01T12:01:00.000Z',
    editedOn: null,
    deletedOn: null,
    metadata: null,
  };

  it('does not replay ACS control messages as empty text', async () => {
    const stats = await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs([...fixture, control]),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
    });
    expect(stats.skipped).toBe(1);
    expect(stats.messages).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages.some((m) => m.content === '')).toBe(false);
  });

  it('reuses a supplied identity map instead of minting a rival set', async () => {
    const ledger = ReplayLedger.ephemeral();
    ledger.recordIdentity('8:acs:old_sys', '8:acs:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_kept-sys');
    ledger.recordIdentity('8:acs:old_user', '8:acs:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_kept-user');
    const stats = await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(fixture),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
      ledger,
    });
    expect(stats.identitiesMinted).toBe(0);
    expect(addedParticipants.map((p) => p.id.communicationUserId)).toEqual([
      '8:acs:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_kept-sys',
      '8:acs:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_kept-user',
    ]);
  });

  it('records every minted identity in the ledger so the caller can persist it', async () => {
    const ledger = ReplayLedger.ephemeral();
    await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(fixture),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
      ledger,
    });
    expect([...ledger.identities.keys()].sort()).toEqual(['8:acs:old_sys', '8:acs:old_user']);
  });

  it('does not count participants or messages for a thread that failed to create', async () => {
    const orphan: Rec[] = [fixture[1]!, fixture[3]!];
    const stats = await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(orphan),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
    });
    expect(stats).toMatchObject({ threads: 0, participants: 0, messages: 0 });
    expect(sentMessages).toHaveLength(0);
  });
});

describe('migrateApply resume', () => {
  beforeEach(() => {
    createdUsers.length = 0;
    createdThreads.length = 0;
    addedParticipants.length = 0;
    sentMessages.length = 0;
  });

  it('marks a thread done once every message has landed', async () => {
    const ledger = ReplayLedger.ephemeral();
    await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(fixture),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
      ledger,
    });
    expect(ledger.threads.get('19:old@thread.v2')).toEqual({
      target: 'thread-1',
      messages: 1,
      done: true,
    });
  });

  it('re-running a finished replay writes nothing at all', async () => {
    const ledger = ReplayLedger.ephemeral();
    const opts = {
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
      ledger,
    };
    await migrateApply({ ...opts, sourceStream: recs(fixture) });
    createdThreads.length = 0;
    addedParticipants.length = 0;
    sentMessages.length = 0;

    const second = await migrateApply({ ...opts, sourceStream: recs(fixture) });
    // The duplicate-estate failure: without the ledger this creates the whole
    // thing a second time.
    expect(createdThreads).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
    expect(addedParticipants).toHaveLength(0);
    expect(second.threadsResumed).toBe(1);
    expect(second.threads).toBe(0);
  });

  it('resumes a half-delivered thread from the message it reached', async () => {
    const threeMessages: Rec[] = [
      fixture[0]!,
      fixture[1]!,
      fixture[2]!,
      fixture[3]!,
      { ...(fixture[3] as Extract<Rec, { kind: 'message' }>), messageId: 'm-2', content: 'dolor' },
      { ...(fixture[3] as Extract<Rec, { kind: 'message' }>), messageId: 'm-3', content: 'sit' },
    ];
    const ledger = ReplayLedger.ephemeral();
    // An earlier run created the thread and delivered the first message.
    ledger.recordThread('19:old@thread.v2', { target: 'thread-existing', messages: 1, done: false });

    const stats = await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(threeMessages),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      commit: true,
      ledger,
    });

    expect(createdThreads).toHaveLength(0); // reused, not recreated
    expect(sentMessages.map((m) => m.content)).toEqual(['dolor', 'sit']);
    expect(stats.messages).toBe(2);
    // Participants were already added by the earlier run.
    expect(addedParticipants).toHaveLength(0);
    expect(ledger.threads.get('19:old@thread.v2')?.done).toBe(true);
  });

  it('counts already-done work in a dry run instead of promising to redo it', async () => {
    const ledger = ReplayLedger.ephemeral();
    ledger.recordThread('19:old@thread.v2', { target: 'thread-1', messages: 1, done: true });
    const stats = await migrateApply({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      sourceStream: recs(fixture),
      targetResourceGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ledger,
    });
    expect(stats).toMatchObject({ threads: 0, threadsResumed: 1, messages: 0, participants: 0 });
    expect(stats.messagesAlreadySent).toBe(1);
  });
});
