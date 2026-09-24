import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * CLAUDE.md rule 3: chat message bodies are PHI and `src/log.ts` is the only
 * thing allowed to write them out (it strips content/text/html/body first).
 * A stray console.log walks around that silently, so fail the build instead of
 * finding out from a log aggregator.
 */
describe('PHI-safe logging is not bypassable', () => {
  const files = sourceFiles('src').filter((f) => !f.endsWith(`log.ts`));

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('routes every write to stdout/stderr through src/log.ts', () => {
    const offenders = files.filter((f) => /\bconsole\s*\./.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('strips message bodies out of structured --json output too', async () => {
    const { redactPhi } = await import('../src/log.ts');
    const redacted = redactPhi({
      findings: [{ summary: 'ok', detail: { content: 'lorem', body: 'ipsum', threadId: '19:t' } }],
    }) as { findings: Array<{ detail: Record<string, unknown> }> };
    expect(redacted.findings[0]?.detail.content).toBe('[redacted]');
    expect(redacted.findings[0]?.detail.body).toBe('[redacted]');
    expect(redacted.findings[0]?.detail.threadId).toBe('19:t');
  });
});
