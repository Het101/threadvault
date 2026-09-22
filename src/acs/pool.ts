/**
 * Run `worker` over `items` with at most `n` in flight. Overlapping latency
 * instead of adding a fixed gap is the difference between ~2.4 and ~25
 * operations per second against ACS.
 *
 * Messages *inside* a thread must stay serial — ACS assigns sequenceId on
 * receipt — so callers pool threads, not messages.
 */
export async function pool<T>(
  items: readonly T[],
  n: number,
  worker: (item: T, i: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(n, items.length));
  let next = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i] as T, i);
    }
  });
  await Promise.all(runners);
}
