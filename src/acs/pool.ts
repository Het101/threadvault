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

/**
 * `pool`, but for a consumer that is a stream rather than a loop: each result
 * is yielded as it completes, with at most `n` workers in flight.
 *
 * Results arrive in completion order, not input order. Callers that need
 * records grouped must return the whole group from one worker call — which is
 * the same rule as `pool`: pool threads, never the messages inside one.
 */
export async function* poolMap<T, R>(
  items: readonly T[],
  n: number,
  worker: (item: T, i: number) => Promise<R>,
): AsyncGenerator<R, void, undefined> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(n, items.length));
  let next = 0;
  type Settled = { i: number; value?: R; error?: unknown; failed: boolean };
  const inFlight = new Map<number, Promise<Settled>>();

  const start = (): void => {
    const i = next++;
    if (i >= items.length) return;
    // Absorb the rejection here. A bare Promise.race leaves every other
    // in-flight promise unhandled the moment one rejects, which Node reports as
    // an unhandled rejection and, on some configs, exits the process over.
    inFlight.set(
      i,
      worker(items[i] as T, i).then(
        (value) => ({ i, value, failed: false }),
        (error: unknown) => ({ i, error, failed: true }),
      ),
    );
  };

  for (let k = 0; k < width; k++) start();

  while (inFlight.size > 0) {
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.i);
    start();
    if (settled.failed) throw settled.error;
    yield settled.value as R;
  }
}
