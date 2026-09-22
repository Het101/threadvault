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
