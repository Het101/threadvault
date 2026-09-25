import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Rec } from '../src/mirror/types.ts';
import type { PgClient } from '../src/db/pg.ts';

/** Records what extractAcs was asked for, so option plumbing can be asserted. */
const extractCalls: Array<Record<string, unknown>> = [];
const emitted: Rec[] = [];

vi.mock('../src/mirror/extract.ts', () => ({
  extractAcs: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    extractCalls.push(opts);
    return (async function* () {
      for (const r of emitted) yield r;
    })();
  }),
}));

const { mirrorBackfill } = await import('../src/mirror/backfill.ts');

const thread: Rec = {
  kind: 'thread',
  ourThreadId: null,
  legacyThreadId: '19:t@thread.v2',
  topic: 'lorem',
  createdOn: '2022-01-01T00:00:00.000Z',
  createdByAcsId: null,
  deletedOn: null,
  readerAcsId: '8:acs:r',
};
const message: Rec = {
  kind: 'message',
  legacyThreadId: '19:t@thread.v2',
  messageId: 'm-1',
  type: 'text',
  sequenceId: '1',
  content: 'lorem',
  senderAcsId: null,
  senderDisplayName: null,
  ourSenderUserId: 'u-1',
  createdOn: '2022-01-01T12:00:00.000Z',
  editedOn: null,
  deletedOn: null,
  metadata: null,
};

beforeEach(() => {
  extractCalls.length = 0;
  emitted.length = 0;
});

describe('mirrorBackfill', () => {
  it('counts without writing when given no sink — that is the dry run', async () => {
    emitted.push(thread, message);
    const stats = await mirrorBackfill({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      readerAcsId: '8:acs:r',
    });
    // No db and no jsonlPath. It must not throw, and must not invent a sink.
    expect(stats).toEqual({ threads: 1, participants: 0, messages: 1, identities: 0 });
  });

  it('passes concurrency through to the ACS walk', async () => {
    await mirrorBackfill({
      connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
      readerAcsId: '8:acs:r',
      concurrency: 8,
    });
    expect(extractCalls[0]?.concurrency).toBe(8);
    expect(extractCalls[0]?.readerAcsId).toBe('8:acs:r');
  });

  it('refuses to read from ACS without a reader identity', async () => {
    await expect(
      mirrorBackfill({ connectionString: 'endpoint=https://x/;accesskey=k' }),
    ).rejects.toThrow(/readerAcsId/);
  });

  it('refuses to write to two sinks at once rather than half-doing both', async () => {
    const db = { query: vi.fn() } as unknown as PgClient;
    await expect(
      mirrorBackfill({
        connectionString: 'endpoint=https://x/;accesskey=k',
        readerAcsId: '8:acs:r',
        db,
        jsonlPath: 'out.jsonl',
      }),
    ).rejects.toThrow(/not implemented/i);
  });

  it('reads a JSONL source without needing ACS at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-bf-'));
    const path = join(dir, 'in.jsonl');
    writeFileSync(path, JSON.stringify(thread) + '\n' + JSON.stringify(message) + '\n', 'utf8');

    const stats = await mirrorBackfill({ fromJsonl: path });
    expect(stats).toEqual({ threads: 1, participants: 0, messages: 1, identities: 0 });
    // No connection string was given, so nothing may have tried to reach ACS.
    expect(extractCalls).toHaveLength(0);
  });
});
