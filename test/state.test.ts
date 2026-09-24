import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayLedger } from '../src/migrate/state.ts';

const dir = mkdtempSync(join(tmpdir(), 'tv-state-'));
let n = 0;
const tmpPath = () => join(dir, `ledger-${n++}.jsonl`);

describe('ReplayLedger', () => {
  it('survives the process: what one run wrote, the next run reads', () => {
    const path = tmpPath();
    const first = ReplayLedger.open(path);
    first.recordIdentity('8:acs:old_a', '8:acs:new_a');
    first.recordThread('19:t1', { target: 'tgt-1', messages: 3, done: true });
    first.recordThread('19:t2', { target: 'tgt-2', messages: 1, done: false });
    first.close();

    const second = ReplayLedger.open(path);
    expect(second.identities.get('8:acs:old_a')).toBe('8:acs:new_a');
    expect(second.isDone('19:t1')).toBe(true);
    expect(second.isDone('19:t2')).toBe(false);
    expect(second.threads.get('19:t2')).toEqual({ target: 'tgt-2', messages: 1, done: false });
    second.close();
  });

  it('keeps the latest progress for a thread written more than once', () => {
    const path = tmpPath();
    const l = ReplayLedger.open(path);
    l.recordThread('19:t', { target: 'tgt', messages: 1, done: false });
    l.recordThread('19:t', { target: 'tgt', messages: 2, done: false });
    l.recordThread('19:t', { target: 'tgt', messages: 2, done: true });
    l.close();

    const reopened = ReplayLedger.open(path);
    expect(reopened.threads.get('19:t')).toEqual({ target: 'tgt', messages: 2, done: true });
    reopened.close();
  });

  it('recovers from a half-written final line instead of refusing the ledger', () => {
    const path = tmpPath();
    const l = ReplayLedger.open(path);
    l.recordIdentity('8:acs:old_a', '8:acs:new_a');
    l.recordThread('19:t1', { target: 'tgt-1', messages: 2, done: true });
    l.close();
    // A crash mid-write leaves a truncated record. Losing that one entry is
    // recoverable; losing every entry before it is not.
    appendFileSync(path, '{"t":"thread","legacy":"19:t2","tar', 'utf8');

    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reopened = ReplayLedger.open(path);
    err.mockRestore();
    expect(reopened.identities.get('8:acs:old_a')).toBe('8:acs:new_a');
    expect(reopened.isDone('19:t1')).toBe(true);
    reopened.close();
  });

  it('appends rather than rewriting, so cost per thread stays flat', () => {
    const path = tmpPath();
    const l = ReplayLedger.open(path);
    l.recordThread('19:a', { target: 'x', messages: 0, done: false });
    const afterFirst = readFileSync(path, 'utf8');
    l.recordThread('19:b', { target: 'y', messages: 0, done: false });
    l.close();
    const afterSecond = readFileSync(path, 'utf8');
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.trim().split('\n')).toHaveLength(2);
  });

  it('starts empty on a path that does not exist yet', () => {
    const l = ReplayLedger.open(tmpPath());
    expect(l.identities.size).toBe(0);
    expect(l.threads.size).toBe(0);
    l.close();
  });

  it('ignores a ledger line that parses but says nothing useful', () => {
    const path = tmpPath();
    writeFileSync(path, '{"t":"nonsense"}\n{"t":"identity","old":"a","new":"b"}\n', 'utf8');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const l = ReplayLedger.open(path);
    err.mockRestore();
    expect(l.identities.get('a')).toBe('b');
    l.close();
  });

  it('persists nothing when ephemeral', () => {
    const l = ReplayLedger.ephemeral();
    l.recordIdentity('8:acs:old_a', '8:acs:new_a');
    expect(l.identities.get('8:acs:old_a')).toBe('8:acs:new_a');
    expect(() => l.close()).not.toThrow();
  });
});

describe('ReplayLedger.open error handling', () => {
  it('treats a missing file as a first run, but does not swallow other errors', () => {
    // Absent is normal and must be silent.
    const fresh = ReplayLedger.open(join(dir, 'never-written.jsonl'));
    expect(fresh.threads.size).toBe(0);
    fresh.close();

    // Anything else must surface. Reading a directory is the cheap stand-in
    // for a permission or I/O failure, which must never look like "no ledger
    // yet" — that would silently restart a replay and duplicate the estate.
    expect(() => ReplayLedger.open(dir)).toThrow();
  });
});
