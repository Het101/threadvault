import { describe, expect, it } from 'vitest';
import { pool } from '../src/acs/pool.ts';

describe('pool', () => {
  it('runs at most n workers and visits every item once', async () => {
    const seen: number[] = [];
    let inFlight = 0;
    let max = 0;
    await pool([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight++;
      max = Math.max(max, inFlight);
      seen.push(item);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(max).toBeLessThanOrEqual(2);
  });

  it('is a no-op on an empty list', async () => {
    let n = 0;
    await pool([], 4, async () => {
      n++;
    });
    expect(n).toBe(0);
  });
});

describe('poolMap', () => {
  it('yields every result and never exceeds the width', async () => {
    const { poolMap } = await import('../src/acs/pool.ts');
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const out: number[] = [];
    for await (const v of poolMap(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, (i % 3) * 2));
      inFlight--;
      return i * 2;
    })) {
      out.push(v);
    }
    expect(out).toHaveLength(20);
    expect(out.slice().sort((a, b) => a - b)).toEqual(items.map((i) => i * 2));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('keeps each worker result intact, so a thread group is never interleaved', async () => {
    const { poolMap } = await import('../src/acs/pool.ts');
    const groups: string[][] = [];
    for await (const g of poolMap(['a', 'b', 'c', 'd'], 3, async (k) => {
      await new Promise((r) => setTimeout(r, k === 'a' ? 12 : 1));
      return [`${k}1`, `${k}2`, `${k}3`];
    })) {
      groups.push(g);
    }
    // 'a' finishes last, but its records still arrive together.
    expect(groups).toHaveLength(4);
    for (const g of groups) {
      expect(new Set(g.map((x) => x[0])).size).toBe(1);
    }
  });

  it('surfaces a worker failure without leaving an unhandled rejection', async () => {
    const { poolMap } = await import('../src/acs/pool.ts');
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const run = async () => {
      const seen: number[] = [];
      for await (const v of poolMap([1, 2, 3, 4, 5, 6], 3, async (i) => {
        await new Promise((r) => setTimeout(r, i === 2 ? 1 : 8));
        if (i === 2) throw new Error('boom');
        return i;
      })) {
        seen.push(v);
      }
    };
    await expect(run()).rejects.toThrow(/boom/);
    await new Promise((r) => setTimeout(r, 40));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('is a no-op on an empty input', async () => {
    const { poolMap } = await import('../src/acs/pool.ts');
    const out = [];
    for await (const v of poolMap([], 4, async () => 1)) out.push(v);
    expect(out).toEqual([]);
  });
});
