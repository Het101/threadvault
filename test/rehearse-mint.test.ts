import { describe, expect, it, vi, beforeEach } from 'vitest';

const RESOURCE = 'e9002fc6-61dd-4978-8929-878d1590e77e';

/** Everything the run did to the resource, in order. */
const calls: string[] = [];
let userSeq = 0;
let sentMetadata: Record<string, string> = {};

const threadClient = {
  addParticipants: vi.fn().mockImplementation((arg: { participants: { id: unknown }[] }) => {
    calls.push(`addParticipants:${arg.participants.length}`);
    return Promise.resolve();
  }),
  listParticipants: async function* () {
    yield { id: { communicationUserId: 'a' } };
    yield { id: { communicationUserId: 'b' } };
  },
  sendMessage: vi.fn().mockImplementation((_c: unknown, opts?: { metadata?: Record<string, string> }) => {
    calls.push('sendMessage');
    // Echo what was sent, so the assertions test a real round-trip rather
    // than a constant the test chose.
    if (opts?.metadata) sentMetadata = opts.metadata;
    return Promise.resolve({ id: 'm-1' });
  }),
  getMessage: vi.fn().mockImplementation(() =>
    Promise.resolve({
      id: 'm-1',
      createdOn: new Date('2026-09-25T00:00:00Z'),
      metadata: sentMetadata,
    }),
  ),};

vi.mock('../src/acs/client.ts', () => ({
  probeResource: vi.fn().mockResolvedValue({ host: 'dev', guid: RESOURCE }),
  createAcs: vi.fn().mockImplementation(() => ({
    endpoint: 'https://dev',
    identity: {
      createUser: vi.fn().mockImplementation(() => {
        const id = `8:acs:${RESOURCE}_minted-${++userSeq}`;
        calls.push(`createUser:${id}`);
        return Promise.resolve({ communicationUserId: id });
      }),
      deleteUser: vi.fn().mockImplementation((u: { communicationUserId: string }) => {
        calls.push(`deleteUser:${u.communicationUserId}`);
        return Promise.resolve();
      }),
    },
    chatFor: vi.fn().mockImplementation(() =>
      Promise.resolve({
        createChatThread: vi.fn().mockImplementation(() => {
          calls.push('createChatThread');
          return Promise.resolve({ chatThread: { id: '19:new@thread.v2' } });
        }),
        getChatThreadClient: () => threadClient,
        deleteChatThread: vi.fn().mockImplementation((id: string) => {
          calls.push(`deleteChatThread:${id}`);
          return Promise.resolve();
        }),
      }),
    ),
  })),
}));

const { migrateRehearse } = await import('../src/migrate/rehearse.ts');

const base = {
  connectionString: 'endpoint=https://dev/;accesskey=k',
  targetResourceGuid: RESOURCE,
};

beforeEach(() => {
  calls.length = 0;
  userSeq = 0;
  sentMetadata = {};
});

describe('migrate rehearse --mint', () => {
  it('creates the two identities an empty resource does not have', async () => {
    await migrateRehearse({ ...base, mint: true });
    expect(calls.filter((c) => c.startsWith('createUser:'))).toHaveLength(2);
  });

  /**
   * The whole promise of a rehearsal is that it is safe to run against a
   * resource you care about. It may remove what it made and nothing else.
   */
  it('removes exactly what it created, and only that', async () => {
    await migrateRehearse({ ...base, mint: true });

    const created = calls
      .filter((c) => c.startsWith('createUser:'))
      .map((c) => c.slice('createUser:'.length));
    const deleted = calls
      .filter((c) => c.startsWith('deleteUser:'))
      .map((c) => c.slice('deleteUser:'.length));

    expect(deleted.sort()).toEqual(created.sort());
    expect(calls).toContain('deleteChatThread:19:new@thread.v2');
  });

  // The one the caller actually worries about: an identity that already existed
  // in their resource is theirs, and must survive the run.
  it('never deletes an identity that was passed in', async () => {
    const mine = `8:acs:${RESOURCE}_belongs-to-me`;
    const alsoMine = `8:acs:${RESOURCE}_also-mine`;
    await migrateRehearse({
      ...base,
      systemAcsId: mine,
      nonSystemAcsId: alsoMine,
      nonSystemOurUserId: 'THE-UUID',
    });

    expect(calls.filter((c) => c.startsWith('createUser:'))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith('deleteUser:'))).toHaveLength(0);
  });

  it('still cleans up the identities when an assertion fails', async () => {
    threadClient.getMessage.mockResolvedValueOnce({
      id: 'm-1',
      createdOn: new Date('2026-09-25T00:00:00Z'),
      metadata: { originalSenderUserId: 'SOMEONE-ELSE', replayed: 'true' },
    });

    await expect(migrateRehearse({ ...base, mint: true })).rejects.toThrow(/Assertion/);
    expect(calls.filter((c) => c.startsWith('deleteUser:'))).toHaveLength(2);
    expect(calls).toContain('deleteChatThread:19:new@thread.v2');
  });
  it('refuses without identities and without --mint, rather than half-running', async () => {
    await expect(migrateRehearse(base)).rejects.toThrow(/--mint/);
    expect(calls).not.toContain('createChatThread');
  });

  it('will not write to a resource that is not the expected one', async () => {
    await expect(
      migrateRehearse({ ...base, targetResourceGuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff', mint: true }),
    ).rejects.toThrow(/mismatch/i);
    // Nothing was created, so there is nothing to have cleaned up.
    expect(calls).toHaveLength(0);
  });
});
