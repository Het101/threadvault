import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Rec } from '../src/mirror/types.ts';

const emitted: Rec[] = [];
const extractCalls: Array<Record<string, unknown>> = [];

vi.mock('../src/mirror/extract.ts', () => ({
  extractAcs: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    extractCalls.push(opts);
    return (async function* () {
      for (const r of emitted) yield r;
    })();
  }),
}));

const { migrateExtract } = await import('../src/migrate/extract.ts');
const dir = mkdtempSync(join(tmpdir(), 'tv-ex-'));

const rec = (kind: Rec['kind'], n: number): Rec =>
  kind === 'thread'
    ? {
        kind: 'thread',
        ourThreadId: null,
        legacyThreadId: `19:t${n}@thread.v2`,
        topic: 'lorem',
        createdOn: '2022-01-01T00:00:00.000Z',
        createdByAcsId: null,
        deletedOn: null,
        readerAcsId: '8:acs:r',
      }
    : kind === 'participant'
      ? {
          kind: 'participant',
          legacyThreadId: '19:t0@thread.v2',
          acsId: `8:acs:p${n}`,
          displayName: null,
          ourUserId: null,
        }
      : {
          kind: 'message',
          legacyThreadId: '19:t0@thread.v2',
          messageId: `m-${n}`,
          type: 'text',
          sequenceId: String(n),
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
  emitted.length = 0;
  extractCalls.length = 0;
});

describe('migrateExtract', () => {
  it('writes every record and reports what it wrote', async () => {
    emitted.push(rec('thread', 0), rec('participant', 1), rec('message', 1), rec('message', 2));
    const out = join(dir, 'dump.jsonl');
    const stats = await migrateExtract({
      connectionString: 'endpoint=https://mock/;accesskey=k',
      readerAcsId: '8:acs:r',
      outPath: out,
    });

    expect(stats).toEqual({ threads: 1, participants: 1, messages: 2 });
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    // The counts have to describe the file, not the intent.
    expect(lines.filter((l) => JSON.parse(l).kind === 'message')).toHaveLength(2);
  });

  it('truncates, so extracting twice does not double the dump', async () => {
    emitted.push(rec('thread', 0));
    const out = join(dir, 'twice.jsonl');
    await migrateExtract({ connectionString: 'e', readerAcsId: '8:acs:r', outPath: out });
    await migrateExtract({ connectionString: 'e', readerAcsId: '8:acs:r', outPath: out });
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('passes concurrency and thread filters down to the walk', async () => {
    await migrateExtract({
      connectionString: 'e',
      readerAcsId: '8:acs:r',
      outPath: join(dir, 'opts.jsonl'),
      concurrency: 6,
      threadIds: ['19:only@thread.v2'],
    });
    expect(extractCalls[0]?.concurrency).toBe(6);
    expect(extractCalls[0]?.threadIds).toEqual(['19:only@thread.v2']);
  });
});
