import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { authProblem, createTwilio, probeTwilio } from '../src/twilio/client.ts';
import { extractTwilio, participantId } from '../src/twilio/extract.ts';
import type { Rec } from '../src/mirror/types.ts';

const ACCOUNT = 'AC' + 'a'.repeat(32);
const KEY = 'SK' + 'b'.repeat(32);
const auth = { accountSid: ACCOUNT, password: 'secret' };

describe('credentials are checked before the network is', () => {
  /**
   * Twilio answers a bad credential with 401 and a page of HTML, which does not
   * say which of the two values is wrong. Every one of these is a mistake worth
   * naming locally rather than sending and guessing at the reply.
   */
  it.each([
    [{}, /TWILIO_ACCOUNT_SID is not set/],
    [{ accountSid: 'not-a-sid', password: 'x' }, /does not look like an account SID/],
    [{ accountSid: ACCOUNT }, /TWILIO_AUTH_TOKEN|TWILIO_API_KEY_SID/],
    [{ accountSid: ACCOUNT, username: 'nope', password: 'x' }, /API key SID/],
  ])('rejects %o', (given, expected) => {
    expect(authProblem(given)).toMatch(expected);
  });

  it('accepts an account SID with a token, and an API key with a secret', () => {
    expect(authProblem({ accountSid: ACCOUNT, password: 'tok' })).toBeNull();
    expect(authProblem({ accountSid: ACCOUNT, username: KEY, password: 'sec' })).toBeNull();
  });
});

/** A Twilio that answers over the real fetch path, so auth and paging are exercised. */
function fakeTwilioHttp(pages: Record<string, unknown>) {
  const seen: { url: string; auth: string | null }[] = [];
  const f = vi.fn().mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, auth: init?.headers?.Authorization ?? null });
    const body = pages[url];
    if (!body) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ message: 'not found' }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  return { f, seen };
}

const BASE = 'https://conversations.twilio.com/v1';

describe('the HTTP layer', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('sends basic auth built from the API key when one is given', async () => {
    const { f, seen } = fakeTwilioHttp({
      [`${BASE}/Conversations?PageSize=1`]: { conversations: [], meta: {} },
    });
    globalThis.fetch = f;

    const r = await probeTwilio({ accountSid: ACCOUNT, username: KEY, password: 'sec' });
    expect(r.ok).toBe(true);

    const decoded = Buffer.from(seen[0]!.auth!.replace('Basic ', ''), 'base64').toString();
    // The key, not the account SID: that is the point of using one.
    expect(decoded).toBe(`${KEY}:sec`);
  });

  it('follows next_page_url rather than building its own cursor', async () => {
    const page2 = `${BASE}/Conversations?PageSize=100&PageToken=xyz`;
    const { f, seen } = fakeTwilioHttp({
      [`${BASE}/Conversations?PageSize=100`]: {
        conversations: [{ sid: 'CH1', friendly_name: 'a', date_created: null }],
        meta: { next_page_url: page2 },
      },
      [page2]: {
        conversations: [{ sid: 'CH2', friendly_name: 'b', date_created: null }],
        meta: { next_page_url: null },
      },
    });
    globalThis.fetch = f;

    const got: string[] = [];
    for await (const c of createTwilio(auth).conversations(100)) got.push(c.sid);

    expect(got).toEqual(['CH1', 'CH2']);
    // The second request is the URL Twilio handed back, verbatim.
    expect(seen[1]?.url).toBe(page2);
  });

  it('refuses a bad credential without making a request at all', async () => {
    const { f } = fakeTwilioHttp({});
    globalThis.fetch = f;

    const r = await probeTwilio({ accountSid: 'nope', password: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not look like an account SID/);
    // Nothing was sent: a malformed SID cannot become valid over the network.
    expect(f).not.toHaveBeenCalled();
  });

  it('survives an error response that is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: () => Promise.reject(new Error('not json')),
    });

    const r = await probeTwilio(auth);
    expect(r.ok).toBe(false);
    // An HTML error page from a proxy still has to produce a usable message.
    expect(r.error).toMatch(/502/);
  });

  it('reports the failure without attaching the response body wholesale', async () => {
    const { f } = fakeTwilioHttp({});
    globalThis.fetch = f;
    const r = await probeTwilio(auth);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/404/);
  });
});

/**
 * An async iterable that fails the moment it is read, the way a dead endpoint
 * does. Written once: a generator that only throws has no yield, and the
 * alternative - an unreachable `yield` after the `throw` - is dead code that
 * CodeQL is right to flag.
 */
// eslint-disable-next-line require-yield
async function* failing(message: string): AsyncGenerator<never, void, undefined> {
  throw new Error(message);
}

/** An async iterable that yields nothing, without pretending to fail. */
async function* empty(): AsyncGenerator<never, void, undefined> {}

/** A session stub, for the walk itself. */
function session(opts: { messages?: unknown[]; participants?: unknown[] } = {}) {
  return {
    conversations: async function* () {
      yield { sid: 'CH1', friendly_name: 'lorem', date_created: '2022-01-01T00:00:00Z' };
    },
    participants: async function* () {
      for (const p of opts.participants ?? [
        { sid: 'MB1', identity: 'user-a', messaging_binding: null, date_created: null },
      ]) {
        yield p;
      }
    },
    messages: async function* () {
      for (const m of opts.messages ?? [
        {
          sid: 'IM1',
          index: 0,
          author: 'user-a',
          body: 'lorem ipsum',
          date_created: '2022-01-01T12:00:00Z',
          date_updated: null,
          attributes: null,
        },
      ]) {
        yield m;
      }
    },
  } as never;
}

async function walk(opts: Parameters<typeof extractTwilio>[0]): Promise<Rec[]> {
  const out: Rec[] = [];
  for await (const r of extractTwilio(opts)) out.push(r);
  return out;
}

describe('a Twilio walk produces the records the rest of the tool already reads', () => {
  it('maps a conversation onto the same Rec shape an ACS thread produces', async () => {
    const recs = await walk({ auth, session: session() });

    const thread = recs.find((r) => r.kind === 'thread');
    expect(thread).toMatchObject({
      kind: 'thread',
      legacyThreadId: 'CH1',
      topic: 'lorem',
      createdOn: '2022-01-01T00:00:00.000Z',
      // No per-user reader exists on Twilio; the account is what read it.
      readerAcsId: ACCOUNT,
    });

    const msg = recs.find((r) => r.kind === 'message');
    expect(msg).toMatchObject({
      legacyThreadId: 'CH1',
      messageId: 'IM1',
      senderAcsId: 'user-a',
      createdOn: '2022-01-01T12:00:00.000Z',
    });
  });

  /**
   * Twilio's own ordinal, not a counter kept here. A counter would renumber on a
   * partial re-read, and a replay that reordered a conversation is wrong in a
   * way nothing downstream can detect.
   */
  it('takes the sequence from Twilio rather than counting', async () => {
    const recs = await walk({
      auth,
      session: session({
        messages: [
          { sid: 'IM9', index: 41, author: 'a', body: 'x', date_created: null, date_updated: null, attributes: null },
          { sid: 'IM10', index: 42, author: 'a', body: 'y', date_created: null, date_updated: null, attributes: null },
        ],
      }),
    });
    expect(recs.filter((r) => r.kind === 'message').map((r) => r.sequenceId)).toEqual(['41', '42']);
  });

  it('keeps an SMS participant, who has a binding address and no identity', async () => {
    const recs = await walk({
      auth,
      session: session({
        participants: [
          { sid: 'MB1', identity: null, messaging_binding: { address: '+15551234567' }, date_created: null },
          { sid: 'MB2', identity: 'chat-user', messaging_binding: null, date_created: null },
        ],
      }),
    });
    // Dropping the one without an identity would silently lose a participant
    // from the mirrored conversation.
    expect(recs.filter((r) => r.kind === 'participant').map((r) => r.acsId)).toEqual([
      '+15551234567',
      'chat-user',
    ]);
  });

  it('falls back to the participant SID when there is neither', () => {
    expect(participantId({ sid: 'MB3', identity: null, messaging_binding: null })).toBe('MB3');
    expect(participantId({ sid: 'MB3', identity: '   ', messaging_binding: { address: '' } })).toBe('MB3');
  });

  it('honours --no-bodies, because PHI is PHI whoever is hosting it', async () => {
    const recs = await walk({ auth, session: session(), withoutBodies: true });
    const msg = recs.find((r) => r.kind === 'message');
    expect(msg).toMatchObject({ content: null, bodiesOmitted: true });
    expect(JSON.stringify(recs)).not.toContain('lorem ipsum');
  });

  it('emits the thread before its participants and messages', async () => {
    const kinds = (await walk({ auth, session: session() })).map((r) => r.kind);
    expect(kinds[0]).toBe('thread');
    expect(kinds).toEqual(['thread', 'participant', 'message']);
  });
});

describe('mirror backfill accepts Twilio as a source', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('counts a Twilio walk without writing, which is the dry run', async () => {
    vi.doMock('../src/twilio/extract.ts', () => ({
      extractTwilio: () =>
        (async function* () {
          yield* await walk({ auth, session: session() });
        })(),
    }));
    const { mirrorBackfill } = await import('../src/mirror/backfill.ts');

    const stats = await mirrorBackfill({ twilio: auth });
    expect(stats).toEqual({ threads: 1, participants: 1, messages: 1, identities: 0 });
  });

  it('does not need an ACS connection string to do it', async () => {
    vi.doMock('../src/twilio/extract.ts', () => ({
      extractTwilio: () =>
        (async function* () {
          yield* await walk({ auth, session: session() });
        })(),
    }));
    vi.doMock('../src/mirror/extract.ts', () => ({
      extractAcs: () => {
        throw new Error('the ACS walk must not be reached for a Twilio source');
      },
    }));
    const { mirrorBackfill } = await import('../src/mirror/backfill.ts');

    await expect(mirrorBackfill({ twilio: auth })).resolves.toBeTruthy();
  });
});

describe('a walk that goes wrong keeps what it read', () => {
  /**
   * This test used to assert the opposite, and the opposite was a bug.
   *
   * Running the walk against a real Twilio trial account, which refuses the
   * Conversations API with 401, printed "Threads: 0, Participants: 0,
   * Messages: 0" and exited 0. A revoked key and an account with nothing in it
   * produced the same answer, and the caller had no way to tell them apart.
   *
   * Failing to list anything is not a finding about the estate.
   */
  it('fails loudly when the conversation list itself fails', async () => {
    await expect(
      walk({
        auth,
        session: {
          conversations: () => failing('401 Unauthorized: not available on a Trial account'),
          participants: empty,
          messages: empty,
        },
      }),
    ).rejects.toThrow(/Could not list Twilio conversations.*Trial account/s);
  });

  it('an account that really is empty is still empty, not an error', async () => {
    const recs = await walk({
      auth,
      session: { conversations: empty, participants: empty, messages: empty },
    });
    expect(recs).toEqual([]);
  });

  /**
   * One conversation that cannot be read must not end a walk over thousands.
   * The thread record is already out, so the mirror records that it exists even
   * when its contents could not be fetched.
   */
  it('keeps the conversation when its messages cannot be read', async () => {
    const recs = await walk({
      auth,
      session: {
        conversations: async function* () {
          yield { sid: 'CH1', friendly_name: 'a', date_created: null };
        },
        participants: empty,
        messages: () => failing('500 Internal Server Error'),
      } as never,
    });
    expect(recs.map((r) => r.kind)).toEqual(['thread']);
    expect(recs[0]).toMatchObject({ legacyThreadId: 'CH1' });
  });

  it('walks only the conversations asked for, without listing the account', async () => {
    let listed = false;
    const recs = await walk({
      auth,
      conversationSids: ['CH7'],
      session: {
        conversations: async function* () {
          listed = true;
          yield { sid: 'SHOULD-NOT-APPEAR', friendly_name: null, date_created: null };
        },
        participants: empty,
        messages: empty,
      } as never,
    });

    expect(listed).toBe(false);
    expect(recs.map((r) => r.kind)).toEqual(['thread']);
    expect(recs[0]).toMatchObject({ legacyThreadId: 'CH7', topic: '' });
  });

  it('does not emit an unparseable date as a timestamp', async () => {
    const recs = await walk({
      auth,
      session: session({
        messages: [
          { sid: 'IM1', index: 0, author: 'a', body: 'x', date_created: 'not a date', date_updated: '', attributes: null },
        ],
      }),
    });
    const msg = recs.find((r) => r.kind === 'message');
    // Falls back to now rather than storing garbage, and says nothing about an
    // edit that did not happen.
    expect(msg?.kind === 'message' && Number.isNaN(Date.parse(msg.createdOn))).toBe(false);
    expect(msg).toMatchObject({ editedOn: null });
  });
});
