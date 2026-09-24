import { describe, expect, it } from 'vitest';
import { isTerminal, isThrottled, retryAfterMs, withRetry } from '../src/acs/retry.ts';

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

  it('gives up immediately on a terminal error instead of backing off', async () => {
    let n = 0;
    const waits: number[] = [];
    await expect(
      withRetry(
        'createChatThread',
        async () => {
          n++;
          throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
        },
        { attempts: 8, sleep: async (ms) => { waits.push(ms); }, random: () => 0 },
      ),
    ).rejects.toThrow(/createChatThread: Forbidden/);
    expect(n).toBe(1);
    expect(waits).toEqual([]);
  });

  it('still gives a transient non-throttle error one more chance', async () => {
    let n = 0;
    const result = await withRetry(
      'getProperties',
      async () => {
        n++;
        if (n === 1) throw new Error('socket hang up');
        return 'ok';
      },
      { attempts: 8, sleep: async () => undefined, random: () => 0 },
    );
    expect(result).toBe('ok');
    expect(n).toBe(2);
  });

  it('keeps retrying a throttle even though ACS words it as a 403-ish failure', async () => {
    expect(isTerminal({ statusCode: 429 })).toBe(false);
    expect(isTerminal({ statusCode: 403 })).toBe(true);
    expect(isTerminal({ message: 'CommunicationError Forbidden' })).toBe(true);
    expect(isTerminal({ message: 'socket hang up' })).toBe(false);
  });
});
