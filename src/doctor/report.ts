import { CHECKS, type Finding } from './checks.ts';

export type DoctorReport = {
  resourceGuid: string;
  host: string;
  findings: Finding[];
  counts: Record<1 | 2 | 3 | 4 | 5, number>;
};

export function buildReport(
  resourceGuid: string,
  host: string,
  findings: Finding[],
): DoctorReport {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  for (const f of findings) counts[f.check]++;
  return { resourceGuid, host, findings, counts };
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`threadvault doctor`);
  lines.push(`  resource  ${report.resourceGuid}`);
  lines.push(`  endpoint  ${report.host}`);
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
