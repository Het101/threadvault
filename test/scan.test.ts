import { describe, expect, it, vi, beforeEach } from 'vitest';

const RESOURCE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SYS = `8:acs:${RESOURCE}_11111111-1111-1111-1111-111111111111`;
const USER = `8:acs:${RESOURCE}_22222222-2222-2222-2222-222222222222`;
const STALE = `8:acs:${OTHER}_33333333-3333-3333-3333-333333333333`;

/** Threads the mocked resource holds, and which identity may open each. */
const threads: Record<string, { readableBy: string[]; listed: boolean }> = {};
const chatForCalls: string[] = [];

vi.mock('../src/acs/client.ts', () => ({
  createAcs: vi.fn().mockImplementation(() => ({
    identity: {},
    endpoint: 'https://mock.communication.azure.com',
    chatFor: vi.fn().mockImplementation(async (acsId: string) => {
      chatForCalls.push(acsId);
      return {
        listChatThreads: async function* () {
          for (const [id, t] of Object.entries(threads)) {
            if (t.listed && t.readableBy.includes(acsId)) yield { id };
          }
        },
        getChatThreadClient: (threadId: string) => ({
          listParticipants: async function* () {
            const t = threads[threadId];
            if (!t || !t.readableBy.includes(acsId)) throw new Error('Forbidden');
            for (const p of t.readableBy) yield { id: { communicationUserId: p } };
          },
          listMessages: async function* () {
            const t = threads[threadId];
            if (!t || !t.readableBy.includes(acsId)) throw new Error('Forbidden');
            yield {
              id: `${threadId}-m1`,
              // A body is present on the wire. Nothing downstream may keep it.
              content: { message: 'lorem ipsum dolor sit amet' },
              sender: { communicationUserId: SYS },
              metadata: { originalSenderUserId: 'u-user' },
            };
          },
        }),
      };
    }),
  })),
}));

const { scanAcs } = await import('../src/doctor/scan.ts');

const users = [
  { ourUserId: 'u-sys', acsId: SYS, isSystem: true },
  { ourUserId: 'u-user', acsId: USER, isSystem: false },
  { ourUserId: 'u-stale', acsId: STALE, isSystem: false },
];

const opts = {
  connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
  users,
  knownThreadIds: [] as string[],
  resourceGuid: RESOURCE,
  concurrency: 2,
};

beforeEach(() => {
  for (const k of Object.keys(threads)) delete threads[k];
  chatForCalls.length = 0;
});

describe('scanAcs', () => {
  it('never carries a message body out of the SDK boundary', async () => {
    threads['19:a'] = { readableBy: [SYS], listed: true };
    const scan = await scanAcs(opts);
    expect(scan.acsMessages).toHaveLength(1);
    expect(JSON.stringify(scan)).not.toContain('lorem');
    expect(Object.keys(scan.acsMessages[0]!).sort()).toEqual([
      'messageId',
      'metadata',
      'senderAcsId',
      'threadId',
    ]);
  });

  it('attempts known thread ids that listChatThreads does not return', async () => {
    // The Forbidden-on-reply defect hides exactly here: the reader is not a
    // participant, so the thread never appears in its own listing.
    threads['19:hidden'] = { readableBy: [USER], listed: false };
    const scan = await scanAcs({ ...opts, knownThreadIds: ['19:hidden'] });
    expect(scan.acsThreadIds.has('19:hidden')).toBe(true);
    expect(scan.unreadable).toBe(0);
  });

  it('falls back to another identity on this resource when the system one cannot open a thread', async () => {
    threads['19:b'] = { readableBy: [USER], listed: false };
    const scan = await scanAcs({ ...opts, knownThreadIds: ['19:b'] });
    expect(scan.acsParticipants.get('19:b')).toEqual([USER]);
    expect(chatForCalls).toContain(USER);
  });

  it('counts a thread no identity can open instead of pretending it is absent', async () => {
    threads['19:c'] = { readableBy: ['8:acs:someone-else'], listed: false };
    const scan = await scanAcs({ ...opts, knownThreadIds: ['19:c'] });
    expect(scan.unreadable).toBe(1);
    expect(scan.acsThreadIds.has('19:c')).toBe(false);
  });

  it('never reads as an identity belonging to another resource', async () => {
    threads['19:d'] = { readableBy: [SYS], listed: true };
    await scanAcs(opts);
    expect(chatForCalls).not.toContain(STALE);
  });

  it('prefers the system identity as the primary reader', async () => {
    threads['19:e'] = { readableBy: [SYS, USER], listed: true };
    const scan = await scanAcs(opts);
    expect(scan.readerAcsId).toBe(SYS);
    expect(chatForCalls[0]).toBe(SYS);
  });

  it('returns empty rather than throwing when no identity is on this resource', async () => {
    threads['19:f'] = { readableBy: [SYS], listed: true };
    const scan = await scanAcs({
      ...opts,
      users: [{ ourUserId: 'u-stale', acsId: STALE, isSystem: true }],
    });
    expect(scan.readerAcsId).toBeNull();
    expect(scan.acsMessages).toEqual([]);
  });
});
