export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type AcsError = {
  statusCode?: number;
  status?: number;
  code?: string | number;
  message?: string;
  response?: { status?: number };
};

/** Is this error ACS telling us to slow down? */
export function isThrottled(e: unknown): boolean {
  const err = e as AcsError;
  const status = err?.statusCode ?? err?.status ?? err?.response?.status ?? err?.code;
  if (status === 429 || status === 503 || status === 'TooManyRequests') return true;
  const text = `${err?.message ?? ''} ${err?.code ?? ''}`;
  return /TooManyRequests|throttle limit exceeded|Rate limit/i.test(text);
}

const TERMINAL_STATUS = new Set([400, 401, 403, 404]);
const TERMINAL_TEXT = /Forbidden|Unauthorized|NotFound|PermissionDenied/i;

/**
 * Errors that cannot come good on a retry: the caller lacks permission, or the
 * thing is not there. Backing off on these is pure waiting.
 *
 * This matters at estate scale. `doctor` tries each candidate reader per thread,
 * and a reader that does not participate answers Forbidden every single time. At
 * 7,200 threads a one-second backoff per rejected candidate is hours spent
 * sleeping on an answer that will never change.
 *
 * A throttle is checked first by the caller, so a 429 is never terminal.
 */
export function isTerminal(e: unknown): boolean {
  const err = e as AcsError;
  const status = err?.statusCode ?? err?.status ?? err?.response?.status;
  if (typeof status === 'number' && TERMINAL_STATUS.has(status)) return true;
  return TERMINAL_TEXT.test(`${err?.message ?? ''} ${err?.code ?? ''}`);
}

/** Seconds ACS asked us to wait, if it said. */
export function retryAfterMs(e: unknown): number | null {
  const err = e as {
    response?: { headers?: { get?: (k: string) => string | null; [k: string]: unknown } };
  };
  const headers = err?.response?.headers;
  const raw =
    headers?.get?.('retry-after') ??
    (typeof headers?.['retry-after'] === 'string' ? headers['retry-after'] : null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

export type RetryOpts = {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

function defaultAttempts(): number {
  const n = Number(process.env.ACS_RETRY_ATTEMPTS ?? 8);
  return Number.isFinite(n) && n >= 1 ? n : 8;
}

/**
 * Retry a single ACS call through throttling. 429 is expected under load.
 * A terminal error (403, 404, ...) fails at once. Any other error gets one
 * retry for a transient blip, then fails.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? defaultAttempts();
  const wait = opts.sleep ?? sleep;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const throttled = isThrottled(e);
      // A throttle says "later"; a 403 says "no". Only one is worth waiting for.
      if (!throttled && isTerminal(e)) break;
      if (!throttled && attempt > 1) break;
      if (attempt >= attempts) break;
      const backoff =
        retryAfterMs(e) ??
        Math.min(30_000, 1_000 * Math.pow(2, attempt - 1)) + Math.floor(random() * 500);
      await wait(backoff);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${label}: ${msg}`);
}
