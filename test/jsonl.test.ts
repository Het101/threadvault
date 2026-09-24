import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sinkJsonl } from '../src/mirror/sink-jsonl.ts';
import { sourceJsonlFile } from '../src/mirror/source-jsonl.ts';
import type { Rec } from '../src/mirror/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'tv-jsonl-'));

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

async function* one(): AsyncIterable<Rec> {
  yield thread;
}

describe('sinkJsonl', () => {
  it('truncates, so re-running an extract does not double the dump', async () => {
    const path = join(dir, 'dump.jsonl');
    await sinkJsonl(one(), path);
    await sinkJsonl(one(), path);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('sourceJsonlFile', () => {
  it('skips a malformed line instead of aborting the whole replay', async () => {
    const path = join(dir, 'mixed.jsonl');
    writeFileSync(path, `${JSON.stringify(thread)}\n{ not json\n\n${JSON.stringify(thread)}\n`, 'utf8');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out: Rec[] = [];
    for await (const rec of sourceJsonlFile(path)) out.push(rec);
    err.mockRestore();
    expect(out).toHaveLength(2);
  });
});

describe('sourceJsonlFile bad paths', () => {
  it('names the missing file instead of leaking a raw ENOENT', async () => {
    const run = async () => {
      for await (const _ of sourceJsonlFile(join(dir, 'not-here.jsonl'))) {
        /* consume */
      }
    };
    await expect(run()).rejects.toThrow(/extract not found:.*not-here\.jsonl/);
  });

  it('says so when the path is a directory', async () => {
    const run = async () => {
      for await (const _ of sourceJsonlFile(dir)) {
        /* consume */
      }
    };
    await expect(run()).rejects.toThrow(/not a file:/);
  });
});
