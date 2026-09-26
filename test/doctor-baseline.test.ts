import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '../src/doctor/checks.ts';
import {
  baselineMismatch,
  diffAgainst,
  driftLines,
  findingKey,
  readBaseline,
  writeBaseline,
} from '../src/doctor/baseline.ts';

const RESOURCE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tv-bl-'));
});

const finding = (id: string, summary = 'lorem'): Finding => ({
  check: 5,
  kind: 'acs-thread-not-in-db',
  id,
  summary,
});

describe('what makes two findings the same finding', () => {
  /**
   * Not the summary. It embeds counts and ids that reword themselves as the
   * estate moves — a thread gaining a participant would look like a brand new
   * problem, and every scheduled run would page somebody.
   */
  it('ignores the summary, which changes as the estate does', () => {
    expect(findingKey(finding('t-1', 'has 2 participants'))).toBe(
      findingKey(finding('t-1', 'has 3 participants')),
    );
  });

  it('separates the same id raised by different checks', () => {
    const a: Finding = { check: 2, kind: 'system-only-thread', id: 't-1', summary: 'x' };
    const b: Finding = { check: 5, kind: 'acs-thread-not-in-db', id: 't-1', summary: 'x' };
    expect(findingKey(a)).not.toBe(findingKey(b));
  });
});

describe('a first run is not news', () => {
  /**
   * Everything is new when there is no baseline, and none of it is news: the
   * estate was already like that. Reporting it as drift would make the first
   * scheduled run the loudest one anybody ever sees, and the last one they read.
   */
  it('reports nothing as added when there is no baseline', () => {
    const drift = diffAgainst(null, [finding('t-1'), finding('t-2')]);
    expect(drift.added).toEqual([]);
    expect(drift.unchanged).toBe(2);
    expect(drift.comparedTo).toBeNull();
  });

  it('says a baseline was written rather than reporting a diff', () => {
    expect(driftLines(diffAgainst(null, [finding('t-1')])).join('\n')).toMatch(
      /baseline\s+written/,
    );
  });
});

describe('drift', () => {
  it('reports only what is new, and what stopped', () => {
    const path = join(dir, 'b.json');
    writeBaseline(path, RESOURCE, [finding('t-1'), finding('t-2')]);

    const drift = diffAgainst(readBaseline(path), [finding('t-1'), finding('t-3')]);
    expect(drift.added.map((f) => f.id)).toEqual(['t-3']);
    expect(drift.resolved).toEqual(['5:acs-thread-not-in-db:t-2']);
    expect(drift.unchanged).toBe(1);
  });

  it('is quiet when nothing moved', () => {
    const path = join(dir, 'b.json');
    writeBaseline(path, RESOURCE, [finding('t-1')]);
    const drift = diffAgainst(readBaseline(path), [finding('t-1')]);
    expect(drift.added).toEqual([]);
    expect(drift.resolved).toEqual([]);
  });

  it('names the new findings, so the alert says what to look at', () => {
    const path = join(dir, 'b.json');
    writeBaseline(path, RESOURCE, []);
    const out = driftLines(diffAgainst(readBaseline(path), [finding('t-9', 'thread t-9 is adrift')]));
    expect(out.join('\n')).toContain('1 new, 0 resolved');
    expect(out.join('\n')).toContain('thread t-9 is adrift');
  });

  it('caps the listed findings so a bad night is not a wall of text', () => {
    const path = join(dir, 'b.json');
    writeBaseline(path, RESOURCE, []);
    const many = Array.from({ length: 50 }, (_, i) => finding(`t-${i}`));
    const out = driftLines(diffAgainst(readBaseline(path), many)).join('\n');
    expect(out).toContain('50 new');
    expect(out).toContain('30 more new');
  });
});

describe('the baseline file', () => {
  it('round-trips, and stores keys rather than findings', () => {
    const path = join(dir, 'b.json');
    writeBaseline(path, RESOURCE, [finding('t-1'), finding('t-1'), finding('t-2')]);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { keys: string[] };

    // Deduplicated and sorted, so the file does not churn between runs.
    expect(raw.keys).toEqual([
      '5:acs-thread-not-in-db:t-1',
      '5:acs-thread-not-in-db:t-2',
    ]);
    // Summaries carry ids and counts; a baseline is not a place for them.
    expect(JSON.stringify(raw)).not.toContain('lorem');
  });

  it('treats a missing file as an ordinary first run', () => {
    expect(readBaseline(join(dir, 'nope.json'))).toBeNull();
  });

  it('refuses a file that is not a baseline, and says what to do', () => {
    const path = join(dir, 'junk.json');
    writeFileSync(path, '{"hello":"world"}', 'utf8');
    expect(() => readBaseline(path)).toThrow(/not a threadvault baseline.*Delete it/s);
  });

  it('refuses a file that is not JSON at all', () => {
    const path = join(dir, 'junk.json');
    writeFileSync(path, 'not json', 'utf8');
    expect(() => readBaseline(path)).toThrow(/not valid JSON/);
  });
});

describe('a baseline belongs to one resource', () => {
  /**
   * Comparing one resource against another's baseline reports the whole estate
   * as new and the whole baseline as resolved — which reads exactly like a
   * catastrophe, at 3am, when it is nothing of the sort.
   */
  it('refuses to compare across resources', () => {
    const path = join(dir, 'b.json');
    writeBaseline(path, RESOURCE, [finding('t-1')]);
    const msg = baselineMismatch(readBaseline(path), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(msg).toMatch(/every finding as new/);
    expect(msg).toMatch(/baseline per resource/);
  });

  it('is happy when they match, and when there is no baseline', () => {
    const path = join(dir, 'b.json');
    writeBaseline(path, RESOURCE, []);
    expect(baselineMismatch(readBaseline(path), RESOURCE)).toBeNull();
    expect(baselineMismatch(null, RESOURCE)).toBeNull();
  });
});
