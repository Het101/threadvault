import { describe, expect, it, vi } from 'vitest';
import type { Rec } from '../src/mirror/types.ts';

/**
 * The body of an ACS message is the only PHI this tool ever writes to disk.
 * `--no-bodies` is the flag that lets the read-and-analyse path run against a
 * resource whose contents are not allowed to leave it, so these tests are the
 * ones that fail if a body finds its way back into an extract.
 */

/** The resource, as the repo's other tests mock it. Bodies deliberately present. */
const BODY = 'lorem ipsum dolor';
const RESOURCE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

vi.mock('../src/acs/client.ts', () => ({
  createAcs: vi.fn().mockImplementation(() => ({
    identity: {},
    endpoint: 'https://mock.communication.azure.com',
    chatFor: vi.fn().mockImplementation(() =>
      Promise.resolve({
        listChatThreads: async function* () {
          yield { id: '19:t@thread.v2' };
        },
        getChatThreadClient: () => ({
          getProperties: () =>
            Promise.resolve({
              id: '19:t@thread.v2',
              topic: 'lorem',
              createdOn: new Date('2022-01-01T00:00:00Z'),
            }),
          listParticipants: async function* () {
            yield { id: { communicationUserId: '8:acs:s' }, displayName: 'Lorem' };
          },
          listMessages: async function* () {
            yield {
              id: 'm-1',
              type: 'text',
              sequenceId: '1',
              content: { message: BODY },
              sender: { communicationUserId: '8:acs:s' },
              senderDisplayName: 'Lorem',
              createdOn: new Date('2022-01-01T12:00:00Z'),
              metadata: { originalSenderUserId: 'u-1' },
            };
          },
        }),
      }),
    ),
  })),
  probeResource: vi.fn().mockResolvedValue({ host: 'mock', guid: RESOURCE }),
}));

const { extractAcs } = await import('../src/mirror/extract.ts');
const { migrateApply } = await import('../src/migrate/apply.ts');

async function collect(withoutBodies: boolean): Promise<Rec[]> {
  const out: Rec[] = [];
  const stream = extractAcs({
    connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
    readerAcsId: '8:acs:r',
    withoutBodies,
  });
  for await (const r of stream) out.push(r);
  return out;
}
describe('migrate extract --no-bodies', () => {
  it('keeps every field except the body', async () => {
    const withBodies = await collect(false);
    const without = await collect(true);

    const before = withBodies.find((r) => r.kind === 'message');
    const after = without.find((r) => r.kind === 'message');
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (before?.kind !== 'message' || after?.kind !== 'message') return;

    // The body is gone and the record says so.
    expect(before.content).toBe(BODY);
    expect(after.content).toBeNull();
    expect(after.bodiesOmitted).toBe(true);

    // Everything plan and verify read is untouched. Attribution and timing are
    // the whole point: an analysis run is worthless if these do not survive.
    expect(after.messageId).toBe(before.messageId);
    expect(after.senderAcsId).toBe(before.senderAcsId);
    expect(after.ourSenderUserId).toBe(before.ourSenderUserId);
    expect(after.createdOn).toBe(before.createdOn);
    expect(after.metadata).toEqual(before.metadata);
    expect(after.type).toBe(before.type);
  });

  it('writes the body nowhere in the record, not even inside metadata', async () => {
    const without = await collect(true);
    expect(JSON.stringify(without)).not.toContain(BODY);
  });

  it('marks only messages, so an ordinary extract is unchanged', async () => {
    const ordinary = await collect(false);
    for (const r of ordinary) {
      expect(r).not.toHaveProperty('bodiesOmitted');
    }
  });
});

describe('migrate apply refuses a body-free dump', () => {
  const omitted: Rec = {
    kind: 'message',
    legacyThreadId: '19:t@thread.v2',
    messageId: 'm-1',
    type: 'text',
    sequenceId: '1',
    content: null,
    senderAcsId: '8:acs:s',
    senderDisplayName: null,
    ourSenderUserId: 'u-1',
    createdOn: '2022-01-01T12:00:00.000Z',
    editedOn: null,
    deletedOn: null,
    metadata: null,
    bodiesOmitted: true,
  };

  /**
   * The dry run is where someone finds out, because it is what they run first.
   * If only --commit refused, the refusal would arrive after the decision.
   */
  it('refuses during the dry run, before --commit is ever reached', async () => {
    await expect(
      migrateApply({
        connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
        targetResourceGuid: RESOURCE,
        sourceStream: (async function* () {
          yield omitted;
        })(),
        commit: false,
      }),
    ).rejects.toThrow(/--no-bodies/);
  });
});
