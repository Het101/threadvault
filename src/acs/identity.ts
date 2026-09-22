/**
 * ACS identities are resource-scoped: `8:acs:<resourceGuid>_<userGuid>`.
 * An identity minted on resource A is garbage on resource B. That is the
 * whole reason this tool exists.
 */

const ACS_ID = /^8:acs:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f-]+)$/i;

export type ParsedAcsId = {
  resourceGuid: string;
  userGuid: string;
};

export function parseAcsId(id: string | null | undefined): ParsedAcsId | null {
  if (!id) return null;
  const m = id.trim().match(ACS_ID);
  if (!m?.[1] || !m[2]) return null;
  return { resourceGuid: m[1].toLowerCase(), userGuid: m[2].toLowerCase() };
}

/**
 * True only for an identity minted by `resourceGuid`. An empty or
 * other-resource id is as unusable as null — `ensureUserHasAcsIdentity`
 * that only remints on empty is how stale ids become a permanent break.
 */
export function belongsToResource(
  id: string | null | undefined,
  resourceGuid: string,
): boolean {
  if (!id || !resourceGuid) return false;
  const parsed = parseAcsId(id);
  const want = resourceGuid.toLowerCase();
  if (parsed) return parsed.resourceGuid === want;
  // Fallback matching the production replay script: the GUID sits between
  // `:` and `_`. Used if ACS ever emits a non-UUID resource identifier.
  return id.toLowerCase().includes(`:${want}_`);
}

/** Probe failures return '-' or '?'. Those compare equal and must not look like a match. */
export function isKnownGuid(guid: string | null | undefined): boolean {
  return !!guid && guid !== '-' && guid !== '?';
}

export function asCommunicationUserId(id: unknown): string | null {
  if (!id || typeof id !== 'object') return null;
  const rec = id as { communicationUserId?: unknown };
  return typeof rec.communicationUserId === 'string' ? rec.communicationUserId : null;
}

/**
 * The timestamp to show a user for an ACS message.
 *
 * ACS assigns `createdOn` server-side and cannot backdate, so a replayed
 * message carries the replay date inside ACS. Replay writes the true value
 * to `metadata.originalCreatedOn`; prefer that when it parses.
 */
export function resolveSentAt(message: {
  createdOn?: Date | string;
  metadata?: Record<string, string> | null;
}): string {
  const original = message.metadata?.originalCreatedOn;
  if (original) {
    const parsed = new Date(original);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (message.createdOn) {
    const parsed =
      message.createdOn instanceof Date
        ? message.createdOn
        : new Date(message.createdOn);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/**
 * The host app's user id for a (possibly replayed) ACS message.
 *
 * Reads `metadata.originalSenderUserId` only. Deliberately ignores
 * `metadata.originalSenderAcsId` — that names an identity on a resource
 * that may no longer exist.
 */
export function resolveOriginalSenderUserId(message: {
  metadata?: Record<string, string> | null;
}): string | null {
  const v = message.metadata?.originalSenderUserId?.trim();
  if (!v) return null;
  // A confused writer stuffed an ACS identity into the UUID field. Refuse it.
  if (v.startsWith('8:acs:')) return null;
  return v;
}
