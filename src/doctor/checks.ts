import { belongsToResource, resolveOriginalSenderUserId } from '../acs/identity.ts';
import type { HostMapping } from '../config.ts';
import { qid, type PgClient } from '../db/pg.ts';

export type Finding = {
  check: 1 | 2 | 3 | 4 | 5;
  id: string;
  summary: string;
  detail?: Record<string, unknown>;
};

export type DoctorInputs = {
  resourceGuid: string;
  /** ACS identities stored for host users. */
  users: Array<{
    ourUserId: string;
    acsId: string | null;
    isSystem: boolean;
  }>;
  /** Host ChatThread rows (or our threadvault_threads). */
  threads: Array<{
    ourThreadId: string;
    externalId: string | null;
  }>;
  /** ACS-side: thread id → participant ACS ids. */
  acsParticipants: Map<string, string[]>;
  /** ACS-side: messages we listed. Bodies must not be present. */
  acsMessages: Array<{
    threadId: string;
    messageId: string;
    senderAcsId: string | null;
    metadata: Record<string, string> | null;
  }>;
  /** Thread ids that exist on the ACS resource (from list or extract). */
  acsThreadIds: Set<string>;
  /**
   * False when we did not walk ACS. Check 5 then only reports rows with a
   * null externalId — comparing against an empty ACS set would false-positive
   * every thread.
   */
  acsScanned: boolean;
};

export const CHECKS = {
  1: {
    name: 'stale-identities',
    why: 'Users whose acsUserId belongs to a different resource GUID. The 649 stale identities.',
  },
  2: {
    name: 'system-only-threads',
    why: 'Threads whose only ACS participant is the system identity. Forbidden on reply.',
  },
  3: {
    name: 'misattributed-messages',
    why: 'Messages whose ACS sender is the system identity but whose metadata names a real user.',
  },
  4: {
    name: 'missing-system-identity',
    why: 'No system-user ACS identity on this resource. History is unrecoverable without it.',
  },
  5: {
    name: 'split-brain-threads',
    why: 'Threads in ACS with no matching row, or rows whose externalId is missing from ACS.',
  },
} as const;

export function runChecks(input: DoctorInputs): Finding[] {
  const findings: Finding[] = [];
  const guid = input.resourceGuid.toLowerCase();

  const system = input.users.filter((u) => u.isSystem);
  const systemAcsIds = new Set(
    system.map((u) => u.acsId).filter((id): id is string => !!id && belongsToResource(id, guid)),
  );

  // 1 — stale identities
  for (const u of input.users) {
    if (!u.acsId || u.acsId.trim() === '') continue;
    if (belongsToResource(u.acsId, guid)) continue;
    findings.push({
      check: 1,
      id: u.ourUserId,
      summary: `user ${u.ourUserId} holds an identity that does not belong to resource ${guid}`,
      detail: { acsIdPrefix: u.acsId.slice(0, 14) + '…', isSystem: u.isSystem },
    });
  }

  // 4 — missing system identity (before 2, which needs it)
  const systemOnResource = system.find((u) => u.acsId && belongsToResource(u.acsId, guid));
  if (system.length === 0) {
    findings.push({
      check: 4,
      id: 'system',
      summary: 'no system user row found — cannot own replayed threads or read history as the backend',
    });
  } else if (!systemOnResource) {
    findings.push({
      check: 4,
      id: system[0]!.ourUserId,
      summary: 'system user has no ACS identity on this resource — history is unrecoverable until one is minted',
    });
  }

  // 2 — system-only participant lists
  for (const [threadId, parts] of input.acsParticipants) {
    const live = parts.filter(Boolean);
    if (live.length === 0) continue;
    const onlySystem =
      live.length > 0 && live.every((p) => systemAcsIds.has(p) || (systemOnResource?.acsId === p));
    if (onlySystem) {
      findings.push({
        check: 2,
        id: threadId,
        summary: `thread ${threadId} has only the system identity as a participant — nobody else can reply`,
        detail: { participants: live.length },
      });
    }
  }

  // 3 — misattributed messages. Never inspect content.
  for (const m of input.acsMessages) {
    const original = resolveOriginalSenderUserId(m);
    if (!original) continue;
    const sender = m.senderAcsId;
    if (!sender) continue;
    const sentAsSystem = systemAcsIds.has(sender) || sender === systemOnResource?.acsId;
    if (!sentAsSystem) continue;
    findings.push({
      check: 3,
      id: m.messageId,
      summary: `message ${m.messageId} was sent as the system identity but metadata.originalSenderUserId names ${original}`,
      detail: { threadId: m.threadId, originalSenderUserId: original },
    });
  }

  // 5 — split brain
  for (const t of input.threads) {
    if (!t.externalId) {
      findings.push({
        check: 5,
        id: t.ourThreadId,
        summary: `database thread ${t.ourThreadId} has no externalId`,
      });
    }
  }
  if (input.acsScanned) {
    const dbExternal = new Set(
      input.threads.map((t) => t.externalId).filter((id): id is string => !!id),
    );
    for (const id of input.acsThreadIds) {
      if (dbExternal.has(id)) continue;
      findings.push({
        check: 5,
        id,
        summary: `ACS thread ${id} has no matching database row`,
      });
    }
    for (const t of input.threads) {
      if (!t.externalId) continue;
      if (!input.acsThreadIds.has(t.externalId)) {
        findings.push({
          check: 5,
          id: t.ourThreadId,
          summary: `database thread ${t.ourThreadId} points at ACS ${t.externalId}, which is not on this resource`,
        });
      }
    }
  }

  return findings;
}

export async function loadHostUsers(db: PgClient, host: HostMapping): Promise<DoctorInputs['users']> {
  const sql = `SELECT ${qid(host.usersIdColumn)} AS id,
                      ${qid(host.usersAcsIdColumn)} AS acs,
                      COALESCE(${qid(host.usersSystemColumn)}, false) AS sys
               FROM ${qid(host.usersTable)}`;
  const { rows } = await db.query<{ id: string; acs: string | null; sys: boolean }>(sql);
  return rows.map((r) => ({
    ourUserId: r.id,
    acsId: r.acs,
    isSystem: !!r.sys,
  }));
}

export async function loadHostThreads(
  db: PgClient,
  host: HostMapping,
): Promise<DoctorInputs['threads']> {
  const sql = `SELECT ${qid(host.threadsIdColumn)} AS id,
                      ${qid(host.threadsExternalIdColumn)} AS ext
               FROM ${qid(host.threadsTable)}`;
  const { rows } = await db.query<{ id: string; ext: string | null }>(sql);
  return rows.map((r) => ({ ourThreadId: r.id, externalId: r.ext }));
}

export async function loadMirrorUsers(db: PgClient, resourceGuid: string): Promise<DoctorInputs['users']> {
  const exists = await db.query<{ reg: string | null }>(
    `SELECT to_regclass('threadvault_identities')::text AS reg`,
  );
  if (!exists.rows[0]?.reg) return [];
  const { rows } = await db.query<{ our_user_id: string; acs_id: string; is_system: boolean }>(
    `SELECT our_user_id, acs_id, is_system FROM threadvault_identities WHERE resource_guid = $1`,
    [resourceGuid],
  );
  return rows.map((r) => ({
    ourUserId: r.our_user_id,
    acsId: r.acs_id,
    isSystem: r.is_system,
  }));
}

export async function loadMirrorThreads(db: PgClient): Promise<DoctorInputs['threads']> {
  const exists = await db.query<{ reg: string | null }>(
    `SELECT to_regclass('threadvault_threads')::text AS reg`,
  );
  if (!exists.rows[0]?.reg) return [];
  const { rows } = await db.query<{ id: string; external_id: string | null }>(
    `SELECT id, external_id FROM threadvault_threads`,
  );
  return rows.map((r) => ({ ourThreadId: r.id, externalId: r.external_id }));
}
