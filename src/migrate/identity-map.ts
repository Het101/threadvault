import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * old ACS id -> identity on the target resource, as a flat JSON object.
 *
 * `migrate apply` mints a target identity per source participant. That mapping
 * is the only link between a replayed thread and the people in it: drop it and
 * the estate is readable by nobody. Keeping it on disk also makes a re-run
 * idempotent — the second pass reuses identities instead of minting a rival set.
 */
export function readIdentityMap(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object of oldAcsId -> newAcsId`);
  }
  for (const [oldId, newId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof newId !== 'string' || !newId.trim()) {
      throw new Error(`${path}: value for ${oldId} is not an ACS id`);
    }
    map.set(oldId, newId);
  }
  return map;
}

export function writeIdentityMap(path: string, map: Map<string, string>): void {
  const sorted = Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}
