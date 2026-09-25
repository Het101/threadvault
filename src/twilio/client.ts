/**
 * Twilio Conversations, over plain fetch.
 *
 * Not the `twilio` helper library: this needs three GET endpoints, and that
 * package brings megabytes of voice, video, verify and TwiML with it. A tool
 * whose pitch includes a small, auditable dependency tree does not add that for
 * three requests. Node 22 has fetch.
 */
import { withRetry } from '../acs/retry.ts';

const DEFAULT_BASE = 'https://conversations.twilio.com/v1';

/**
 * Where the Conversations API lives.
 *
 * Twilio runs regional endpoints, so this is not only a test seam - an account
 * pinned to Ireland or Australia answers on its own host. It is also the only
 * way to run the real binary against a stand-in server, which is the
 * difference between "the unit mocks pass" and "the shipped command walks an
 * API and writes a correct dump".
 *
 * Plain http is refused except on loopback. Everything this carries - the
 * credential in an Authorization header, and message bodies coming back - has
 * no business crossing a network in the clear.
 */
export function baseUrl(): string {
  const raw = (process.env.TWILIO_BASE_URL || '').trim();
  if (!raw) return DEFAULT_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`TWILIO_BASE_URL is not a URL: ${raw}`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(
      `TWILIO_BASE_URL must be https (got ${url.protocol}//). ` +
        `It carries the credential and the message bodies.`,
    );
  }
  return raw.replace(/\/+$/, '');
}

export type TwilioAuth = {
  /** AC… account SID, always required — it identifies the account. */
  accountSid: string;
  /**
   * An API key SID (SK…) and secret, or the account auth token as `password`
   * with `username` left unset. An API key is preferred: it can be revoked on
   * its own, where the auth token is the account.
   */
  username?: string;
  password: string;
};

/** What the tool reads. Twilio returns far more; this is what a mirror needs. */
export type TwilioConversation = {
  sid: string;
  friendly_name: string | null;
  date_created: string | null;
  date_updated: string | null;
  state: string | null;
};

export type TwilioParticipant = {
  sid: string;
  identity: string | null;
  messaging_binding: { address?: string | null } | null;
  date_created: string | null;
};

export type TwilioMessage = {
  sid: string;
  index: number;
  author: string | null;
  body: string | null;
  date_created: string | null;
  date_updated: string | null;
  attributes: string | null;
};

export type TwilioError = Error & { status?: number };

function authHeader(auth: TwilioAuth): string {
  // An API key authenticates as SK…:secret; the auth token as AC…:token.
  const user = auth.username ?? auth.accountSid;
  return 'Basic ' + Buffer.from(`${user}:${auth.password}`).toString('base64');
}

/**
 * Why this credential cannot work, or null if it looks usable.
 *
 * The API answers 401 with a page of HTML, which tells you nothing about which
 * of the two values is wrong.
 */
export function authProblem(auth: Partial<TwilioAuth>): string | null {
  if (!auth.accountSid?.trim()) return 'TWILIO_ACCOUNT_SID is not set';
  if (!/^AC[0-9a-f]{32}$/i.test(auth.accountSid.trim())) {
    return `TWILIO_ACCOUNT_SID does not look like an account SID: expected AC followed by 32 hex characters`;
  }
  if (!auth.password?.trim()) {
    return 'no credential: set TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID with TWILIO_API_KEY_SECRET';
  }
  if (auth.username && !/^SK[0-9a-f]{32}$/i.test(auth.username.trim())) {
    return 'TWILIO_API_KEY_SID does not look like an API key SID: expected SK followed by 32 hex characters';
  }
  return null;
}

async function get<T>(auth: TwilioAuth, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(auth), Accept: 'application/json' },
  });
  if (!res.ok) {
    // The body can echo request content, so it is read for the code and the
    // message only, never attached wholesale.
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string; code?: number };
      detail = body.message ? `: ${body.message}` : '';
    } catch {
      /* not JSON; the status is all we have */
    }
    const err: TwilioError = new Error(`Twilio ${res.status} ${res.statusText}${detail}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/**
 * Walk a paginated Twilio collection.
 *
 * Twilio hands back the next page as a full URL in `meta.next_page_url`, so the
 * cursor is never constructed here — the server decides where the boundary is.
 */
async function* paginate<T>(
  auth: TwilioAuth,
  firstUrl: string,
  key: string,
  label: string,
): AsyncGenerator<T, void, undefined> {
  let url: string | null = firstUrl;
  while (url) {
    const here: string = url;
    const page = await withRetry(label, () =>
      get<Record<string, unknown> & { meta?: { next_page_url?: string | null } }>(auth, here),
    );
    for (const item of (page[key] as T[] | undefined) ?? []) yield item;
    url = page.meta?.next_page_url ?? null;
  }
}

export type TwilioSession = {
  conversations: (pageSize: number) => AsyncGenerator<TwilioConversation, void, undefined>;
  participants: (sid: string) => AsyncGenerator<TwilioParticipant, void, undefined>;
  messages: (sid: string, pageSize: number) => AsyncGenerator<TwilioMessage, void, undefined>;
};

export function createTwilio(auth: TwilioAuth): TwilioSession {
  return {
    conversations: (pageSize) =>
      paginate<TwilioConversation>(
        auth,
        `${baseUrl()}/Conversations?PageSize=${pageSize}`,
        'conversations',
        'listConversations',
      ),
    participants: (sid) =>
      paginate<TwilioParticipant>(
        auth,
        `${baseUrl()}/Conversations/${encodeURIComponent(sid)}/Participants?PageSize=100`,
        'participants',
        'listParticipants',
      ),
    messages: (sid, pageSize) =>
      paginate<TwilioMessage>(
        auth,
        // Ascending, so a conversation's messages arrive in the order they were
        // sent. The mirror stores `index` as the sequence, and a replay that
        // reordered them would be wrong in a way nothing downstream can detect.
        `${baseUrl()}/Conversations/${encodeURIComponent(sid)}/Messages?Order=asc&PageSize=${pageSize}`,
        'messages',
        'listMessages',
      ),
  };
}

export type ProbeResult = { accountSid: string; conversations: 'reachable'; error?: string };

/**
 * Confirm the credential works and the Conversations API answers, by asking for
 * a single conversation. Reads nothing else and prints no content.
 */
export async function probeTwilio(
  auth: TwilioAuth,
): Promise<{ ok: boolean; accountSid: string; error?: string }> {
  const problem = authProblem(auth);
  if (problem) return { ok: false, accountSid: auth.accountSid ?? '', error: problem };
  try {
    await withRetry('probeTwilio', () => get(auth, `${baseUrl()}/Conversations?PageSize=1`));
    return { ok: true, accountSid: auth.accountSid };
  } catch (e) {
    return {
      ok: false,
      accountSid: auth.accountSid,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
