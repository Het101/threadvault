import { describe, expect, it } from 'vitest';
import { isThrottled, retryAfterMs, withRetry } from '../src/acs/retry.ts';

describe('isThrottled', () => {
  it('detects numeric 429/503 and body text when the SDK drops the status', () => {
    expect(isThrottled({ statusCode: 429 })).toBe(true);
    expect(isThrottled({ status: 503 })).toBe(true);
    expect(isThrottled({ message: 'Request failed: TooManyRequests' })).toBe(true);
    expect(isThrottled({ message: 'The throttle limit exceeded for this resource' })).toBe(true);
    expect(isThrottled({ statusCode: 403, message: 'Forbidden' })).toBe(false);
  });
});

describe('retryAfterMs', () => {
  it('reads retry-after from a Headers-like object', () => {
    expect(retryAfterMs({ response: { headers: { get: () => '7' } } })).toBe(7000);
    expect(retryAfterMs({ response: { headers: { 'retry-after': '3' } } })).toBe(3000);
    expect(retryAfterMs({ response: { headers: { get: () => null } } })).toBeNull();
  });
});

describe('withRetry', () => {
  it('retries throttles and honours retry-after', async () => {
    const waits: number[] = [];
    let n = 0;
    const result = await withRetry(
      'sendMessage',
      async () => {
        n++;
        if (n < 3) {
          const err: any = new Error('TooManyRequests');
          err.statusCode = 429;
          err.response = { headers: { get: () => '1' } };
          throw err;
        }
        return 'ok';
      },
      { attempts: 5, sleep: async (ms) => { waits.push(ms); }, random: () => 0 },
    );
    expect(result).toBe('ok');
    expect(n).toBe(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it('fails a non-throttle error on the second attempt', async () => {
    let n = 0;
    await expect(
      withRetry(
        'createChatThread',
        async () => {
          n++;
          throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
        },
        { attempts: 8, sleep: async () => undefined, random: () => 0 },
      ),
    ).rejects.toThrow(/createChatThread: Forbidden/);
    expect(n).toBe(2);
  });
});
