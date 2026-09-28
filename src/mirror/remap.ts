/**
 * Fills `ourUserId` / `ourSenderUserId` on a dump from the host users table.
 *
 * Nothing else in this tool does this. `migrate extract` walks ACS, which has
 * no idea who your users are, so it writes `ourUserId: null`. The Postgres sink
 * then stands in `shadowUserId(acsId)` for every null. The result is an estate
 * that is internally consistent and attributed to nobody: each person matches
 * no row in your users table, and the ACS ids that could have identified them
 * die with their resource.
 *
 * The host mapping in threadvault.yml already describes where the real ids
 * live; until now only `doctor` read it.
 *
 * Failsafe by construction: the caller checks coverage over the whole source
 * *before* anything is written, because a partial run cannot be repaired by
 * re-running. `threadvault_identities` is keyed `(our_user_id, resource_guid)`,
 * so a row written under a shadow id and a row written under the real id are
 * two different rows, not one row corrected.
 */
import type { Rec } from './types.ts';

export type HostUser = { ourUserId: string; acsId: string | null };

/**
 * ACS id to our user id.
 *
 * Users with no ACS id contribute nothing. A duplicate ACS id across two users
 * is a real defect in the host data, not something to pick a winner for, so it
 * is reported rather than resolved.
 */
export function buildIdentityMap(users: HostUser[]): {
  map: Map<string, string>;
  duplicates: string[];
} {
  const map = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const u of users) {
    const acsId = u.acsId?.trim();
    if (!acsId || !u.ourUserId) continue;
    const seen = map.get(acsId);
    if (seen && seen !== u.ourUserId) {
      duplicates.add(acsId);
      continue;
    }
    map.set(acsId, u.ourUserId);
  }
  return { map, duplicates: [...duplicates].sort() };
}

export type Coverage = {
  /** Distinct ACS ids in the source that the host table accounts for. */
  resolved: number;
  /** Distinct ACS ids in the source with no row in the host table. */
  unresolved: string[];
  /** Records that already carried an id, which are left exactly as they are. */
  alreadyMapped: number;
};

/**
 * Every ACS id a replay would need an owner for.
 *
 * A message with no `senderAcsId` is a system or control message and has no
 * owner to find, so it is not counted as a miss. Counting it would make full
 * coverage unreachable and train people to pass --allow-unmapped, which is the
 * opposite of what this is for.
 *
 * A record that already carries an id is left alone: a dump that has been
 * mapped once is authoritative over this table.
 */
export async function measureCoverage(
  source: AsyncIterable<Rec>,
  map: Map<string, string>,
): Promise<Coverage> {
  const wanted = new Set<string>();
  let alreadyMapped = 0;

  for await (const rec of source) {
    if (rec.kind === 'participant') {
      if (rec.ourUserId) {
        alreadyMapped++;
        continue;
      }
      if (rec.acsId) wanted.add(rec.acsId);
    } else if (rec.kind === 'message') {
      if (rec.ourSenderUserId) {
        alreadyMapped++;
        continue;
      }
      if (rec.senderAcsId) wanted.add(rec.senderAcsId);
    }
  }

  const unresolved: string[] = [];
  let resolved = 0;
  for (const acsId of wanted) {
    if (map.has(acsId)) resolved++;
    else unresolved.push(acsId);
  }
  return { resolved, unresolved: unresolved.sort(), alreadyMapped };
}

/**
 * The same stream with ids filled in where the host table knows them.
 *
 * Only ever fills a blank. An id already on the record wins, so re-running this
 * over an already-mapped dump is a no-op rather than a second opinion.
 */
export async function* remap(
  source: AsyncIterable<Rec>,
  map: Map<string, string>,
): AsyncIterable<Rec> {
  for await (const rec of source) {
    if (rec.kind === 'participant' && !rec.ourUserId && rec.acsId) {
      const ourUserId = map.get(rec.acsId);
      yield ourUserId ? { ...rec, ourUserId } : rec;
    } else if (rec.kind === 'message' && !rec.ourSenderUserId && rec.senderAcsId) {
      const ourSenderUserId = map.get(rec.senderAcsId);
      yield ourSenderUserId ? { ...rec, ourSenderUserId } : rec;
    } else {
      yield rec;
    }
  }
}

/** What the operator reads before deciding to commit. */
export function coverageLines(cov: Coverage, duplicates: string[]): string[] {
  const lines = [
    `identities needing an owner:      ${cov.resolved + cov.unresolved.length}`,
    `  found in your users table:      ${cov.resolved}`,
    `  not found:                      ${cov.unresolved.length}`,
  ];
  if (cov.alreadyMapped) {
    lines.push(`records already carrying an id:   ${cov.alreadyMapped} (left as they are)`);
  }
  if (duplicates.length) {
    lines.push(
      '',
      `WARNING: ${duplicates.length} ACS id(s) appear on more than one user in your`,
      '         users table. They were left unmapped rather than guessed. Fix the',
      '         host data before replaying, or those people lose attribution.',
    );
  }
  return lines;
}
