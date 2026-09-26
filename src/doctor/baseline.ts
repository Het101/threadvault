import { readFileSync, writeFileSync } from 'node:fs';
import type { Finding } from './checks.ts';

/**
 * What `doctor` found last time, so a scheduled run can say what changed.
 *
 * Running doctor nightly is already possible — `--json`, exit codes, cron. The
 * problem is that it reports the same estate every night. Two findings you have
 * decided to live with arrive again at 3am on Tuesday looking exactly like two
 * findings that appeared an hour ago, and after a week nobody opens the mail.
 *
 * A baseline makes each run say what is *new*. That is the thing worth waking
 * up for, and it is the difference between an alert and a newsletter.
 */
export type Baseline = {
  /** Bumped only if the shape changes in a way an old file cannot be read. */
  version: 1;
  /** When it was taken, so a stale baseline is obvious. */
  takenAt: string;
  resourceGuid: string;
  /** Stable keys, not the findings themselves: summaries carry ids and counts. */
  keys: string[];
};

/**
 * What makes two findings the same finding across runs.
 *
 * Not the summary — it embeds counts and ids that reword themselves as the
 * estate moves, so comparing on it would report every thread as new the moment
 * its participant count changed.
 */
export function findingKey(f: Finding): string {
  return `${f.check}:${f.kind}:${f.id}`;
}

export type Drift = {
  /** Findings that were not in the baseline. The reason to look. */
  added: Finding[];
  /** Keys in the baseline that no longer appear. Somebody fixed something. */
  resolved: string[];
  /** Still present, already known. */
  unchanged: number;
  /** Null when there was no baseline to compare against. */
  comparedTo: string | null;
};

export function readBaseline(path: string): Baseline | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No baseline yet is the ordinary first run, not an error.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Baseline at ${path} is not valid JSON. Delete it to start a new one.`);
  }
  const b = parsed as Partial<Baseline>;
  if (b.version !== 1 || !Array.isArray(b.keys)) {
    throw new Error(`Baseline at ${path} is not a threadvault baseline. Delete it to start a new one.`);
  }
  return {
    version: 1,
    takenAt: typeof b.takenAt === 'string' ? b.takenAt : 'unknown',
    resourceGuid: typeof b.resourceGuid === 'string' ? b.resourceGuid : 'unknown',
    keys: b.keys.filter((k): k is string => typeof k === 'string'),
  };
}

export function writeBaseline(path: string, resourceGuid: string, findings: Finding[]): void {
  const baseline: Baseline = {
    version: 1,
    takenAt: new Date().toISOString(),
    resourceGuid,
    keys: [...new Set(findings.map(findingKey))].sort(),
  };
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
}

export function diffAgainst(baseline: Baseline | null, findings: Finding[]): Drift {
  if (!baseline) {
    // Everything is new on a first run, and none of it is news. Saying so keeps
    // the first scheduled run from paging somebody about an estate they already
    // knew about.
    return { added: [], resolved: [], unchanged: findings.length, comparedTo: null };
  }
  const known = new Set(baseline.keys);
  const seen = new Set(findings.map(findingKey));
  return {
    added: findings.filter((f) => !known.has(findingKey(f))),
    resolved: baseline.keys.filter((k) => !seen.has(k)),
    unchanged: findings.filter((f) => known.has(findingKey(f))).length,
    comparedTo: baseline.takenAt,
  };
}

/**
 * A different resource is not drift, it is a different question.
 *
 * Comparing one resource's findings against another's baseline would report the
 * whole estate as new and the whole baseline as resolved, which reads exactly
 * like a catastrophe.
 */
export function baselineMismatch(baseline: Baseline | null, resourceGuid: string): string | null {
  if (!baseline || baseline.resourceGuid === resourceGuid) return null;
  return (
    `Baseline was taken against resource ${baseline.resourceGuid}, this run is ${resourceGuid}. ` +
    `Comparing them would report every finding as new. Use a baseline per resource.`
  );
}

export function driftLines(drift: Drift): string[] {
  if (drift.comparedTo === null) {
    return ['  baseline  written; the next run will report what changed'];
  }
  const out = [
    `  since     ${drift.comparedTo}`,
    `  drift     ${drift.added.length} new, ${drift.resolved.length} resolved, ${drift.unchanged} unchanged`,
  ];
  for (const f of drift.added.slice(0, 20)) out.push(`  + (${f.check}) ${f.summary}`);
  if (drift.added.length > 20) out.push(`  … ${drift.added.length - 20} more new`);
  return out;
}
