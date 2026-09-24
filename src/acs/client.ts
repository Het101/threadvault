import { ChatClient } from '@azure/communication-chat';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';
import { CommunicationIdentityClient } from '@azure/communication-identity';
import { parseAcsId } from './identity.ts';
import { withRetry } from './retry.ts';

export function parseEndpoint(connectionString: string): string {
  const m = connectionString.match(/endpoint=(https:\/\/[^;]+)/i);
  if (!m?.[1]) {
    throw new Error('Could not read endpoint= out of the ACS connection string.');
  }
  return m[1].replace(/\/$/, '');
}

export function parseEndpointHost(connectionString: string): string {
  try {
    return new URL(parseEndpoint(connectionString)).host;
  } catch {
    return parseEndpoint(connectionString);
  }
}

export type AcsSession = {
  identity: CommunicationIdentityClient;
  endpoint: string;
  chatFor: (acsId: string) => Promise<ChatClient>;
};

/** One token and one ChatClient per identity for the whole run. */
export function createAcs(connectionString: string): AcsSession {
  const identity = new CommunicationIdentityClient(connectionString);
  const endpoint = parseEndpoint(connectionString);
  const clients = new Map<string, ChatClient>();
  const chatFor = async (acsId: string) => {
    const hit = clients.get(acsId);
    if (hit) return hit;
    const tok = await withRetry('getToken', () =>
      identity.getToken({ communicationUserId: acsId }, ['chat']),
    );
    const c = new ChatClient(endpoint, new AzureCommunicationTokenCredential(tok.token));
    clients.set(acsId, c);
    return c;
  };
  return { identity, endpoint, chatFor };
}

/**
 * Why this connection string cannot work, or null if it looks usable.
 *
 * The Azure SDK answers "Invalid connection string <the string>", which is
 * true and tells you nothing. The overwhelmingly common cause is a shell:
 * `export ACS_CONNECTION_STRING=endpoint=...;accesskey=...` without quotes
 * ends the command at the `;`, so the variable holds the endpoint alone and
 * the key silently vanishes.
 */
export function connectionStringProblem(connectionString: string): string | null {
  const cs = connectionString.trim();
  if (!cs) return 'the connection string is empty';
  if (!/endpoint=/i.test(cs)) return 'no endpoint= in the connection string';
  if (!/accesskey=/i.test(cs)) {
    return (
      'no accesskey= in the connection string. If you exported it in a shell, quote it: ' +
      "an unquoted ';' ends the command and drops everything after it"
    );
  }
  return null;
}

export type ProbeResult = {
  host: string;
  guid: string | null;
  error?: string;
};

/**
 * Mint one identity to learn the resource GUID, then delete it.
 * Prints/returns host + GUID only — never the access key.
 */
export async function probeResource(connectionString: string): Promise<ProbeResult> {
  const problem = connectionStringProblem(connectionString);
  if (problem) {
    let host = '-';
    try {
      host = parseEndpointHost(connectionString);
    } catch {
      /* there is no endpoint to report either */
    }
    return { host, guid: null, error: problem };
  }

  const host = parseEndpointHost(connectionString);
  try {
    const identity = new CommunicationIdentityClient(connectionString);
    const u = await identity.createUser();
    const guid = parseAcsId(u.communicationUserId)?.resourceGuid ?? null;
    await identity.deleteUser(u).catch(() => undefined);
    if (!guid) {
      return {
        host,
        guid: null,
        error: `Could not read a resource GUID out of the minted identity.`,
      };
    }
    return { host, guid };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { host, guid: null, error: message.slice(0, 160) };
  }
}
