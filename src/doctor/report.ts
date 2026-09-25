import { CHECKS, type Finding } from './checks.ts';

/**
 * What the run actually looked at.
 *
 * Without this a check reading `ok` is unreadable: it means "no findings", and
 * the reader has no way to tell that apart from "found nothing because it
 * examined almost nothing". Every number here is what the checks ran against.
 */
export type DoctorScope = {
  /** The identity the resource was walked as, or null if nothing was walked. */
  readerAcsId: string | null;
  /** Threads ACS listed for that identity. */
  acsThreads: number;
  /** Messages read across those threads. Metadata only; bodies are discarded. */
  acsMessages: number;
  /** Identities loaded from the database and compared against the resource. */
  identities: number;
  /** Threads on record in the database. */
  dbThreads: number;
  /** Threads ACS listed but refused to open. Findings cannot cover these. */
  unreadable: number;
};

export type DoctorReport = {
  resourceGuid: string;
  host: string;
  findings: Finding[];
  counts: Record<1 | 2 | 3 | 4 | 5, number>;
  scope: DoctorScope;
};

export function buildReport(
  resourceGuid: string,
  host: string,
  findings: Finding[],
  scope: DoctorScope,
): DoctorReport {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  for (const f of findings) counts[f.check]++;
  return { resourceGuid, host, findings, counts, scope };
}

/**
 * The lines that make the checks below them mean something. Printed even when
 * nothing was walked, because that is exactly when it matters most.
 */
function scopeLines(scope: DoctorScope): string[] {
  const as = scope.readerAcsId ?? 'no usable identity';
  const out = [
    `  walked    ${scope.acsThreads} ACS thread(s), ${scope.acsMessages} message(s), as ${as}`,
    `  against   ${scope.identities} identit(ies) and ${scope.dbThreads} thread(s) on record`,
  ];
  if (scope.unreadable > 0) {
    out.push(`  unread    ${scope.unreadable} thread(s) ACS listed but would not open`);
  }
  return out;
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`threadvault doctor`);
  lines.push(`  resource  ${report.resourceGuid}`);
  lines.push(`  endpoint  ${report.host}`);
  for (const line of scopeLines(report.scope)) lines.push(line);
  lines.push('');
  for (const n of [1, 2, 3, 4, 5] as const) {
    const meta = CHECKS[n];
    const count = report.counts[n];
    const mark = count === 0 ? 'ok' : String(count);
    lines.push(`  [${n}] ${meta.name.padEnd(24)} ${mark}`);
  }
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('  clean — no findings.');
    return lines.join('\n');
  }
  const shown = report.findings.slice(0, 40);
  for (const f of shown) {
    lines.push(`  - (${f.check}) ${f.summary}`);
  }
  if (report.findings.length > shown.length) {
    lines.push(`  … ${report.findings.length - shown.length} more (pass --json for the full list)`);
  }
  return lines.join('\n');
}

/** Exit 0 clean, 1 findings, 2 could not run. */
export function exitCode(report: DoctorReport | null, failed: boolean): number {
  if (failed) return 2;
  if (!report) return 2;
  return report.findings.length === 0 ? 0 : 1;
}
