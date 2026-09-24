import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Rec } from '../src/mirror/types.ts';

/** threadId -> how it behaves when read. */
const behaviour: Record<string, 'ok' | 'no-properties' | 'no-messages'> = {};

vi.mock('../src/acs/client.ts', () => ({
  createAcs: vi.fn().mockImplementation(() => ({
    identity: {},
    endpoint: 'https://mock.communication.azure.com',
    chatFor: vi.fn().mockResolvedValue({
      listChatThreads: async function* () {
        for (const id of Object.keys(behaviour)) yield { id };
      },
      getChatThreadClient: (threadId: string) => ({
        getProperties: async () => {
          if (behaviour[threadId] === 'no-properties') throw new Error('Forbidden');
          return { topic: `topic-${threadId}`, createdOn: new Date('2022-01-01T00:00:00Z') };
        },
        listParticipants: async function* () {
          yield { id: { communicationUserId: `8:acs:p-${threadId}` }, displayName: 'P' };
        },
        listMessages: async function* () {
          if (behaviour[threadId] === 'no-messages') throw new Error('Forbidden');
          yield {
            id: `${threadId}-m1`,
            type: 'text',
            sequenceId: '1',
            content: { message: 'lorem' },
            sender: { communicationUserId: `8:acs:p-${threadId}` },
            createdOn: new Date('2022-01-01T12:00:00Z'),
          };
        },
      }),
    }),
  })),
}));

const { extractAcs } = await import('../src/mirror/extract.ts');

const collect = async (concurrency: number): Promise<Rec[]> => {
  const out: Rec[] = [];
  for await (const rec of extractAcs({
    connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
    readerAcsId: '8:acs:reader',
    concurrency,
  })) {
    out.push(rec);
  }
  return out;
};

beforeEach(() => {
  for (const k of Object.keys(behaviour)) delete behaviour[k];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('extractAcs', () => {
  it('keeps each thread group contiguous when walking threads concurrently', async () => {
    for (let i = 0; i < 12; i++) behaviour[`19:t${i}`] = 'ok';
    const out = await collect(4);
    expect(out).toHaveLength(12 * 3);

    // Walk the stream and assert every thread's records arrive together: a
    // consumer replaying this relies on thread -> participants -> messages.
    let current: string | null = null;
    const seen = new Set<string>();
    for (const rec of out) {
      if (rec.kind === 'thread') {
        expect(seen.has(rec.legacyThreadId)).toBe(false);
        current = rec.legacyThreadId;
        seen.add(current);
      } else {
        expect(rec.legacyThreadId).toBe(current);
      }
    }
    expect(seen.size).toBe(12);
  });

  it('drops one unreadable thread instead of ending the whole walk', async () => {
    behaviour['19:good1'] = 'ok';
    behaviour['19:bad'] = 'no-properties';
    behaviour['19:good2'] = 'ok';
    const out = await collect(2);
    const threadIds = out.filter((r) => r.kind === 'thread').map((r) => r.legacyThreadId);
    expect(threadIds.sort()).toEqual(['19:good1', '19:good2']);
  });

  it('drops a thread whose messages cannot be listed rather than emitting a headless half', async () => {
    behaviour['19:good'] = 'ok';
    behaviour['19:partial'] = 'no-messages';
    const out = await collect(2);
    // A thread record with no messages would replay as an empty thread and
    // read as success. Better to report it missing.
    expect(out.filter((r) => r.legacyThreadId === '19:partial')).toEqual([]);
    expect(out.filter((r) => r.legacyThreadId === '19:good')).toHaveLength(3);
  });

  it('produces the same records serially as it does pooled', async () => {
    for (let i = 0; i < 6; i++) behaviour[`19:t${i}`] = 'ok';
    const serial = await collect(1);
    const pooled = await collect(4);
    const key = (r: Rec) => `${r.legacyThreadId}|${r.kind}`;
    expect(pooled.map(key).sort()).toEqual(serial.map(key).sort());
  });
});
