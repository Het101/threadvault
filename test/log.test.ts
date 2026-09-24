import { describe, expect, it, vi } from 'vitest';
import { log, redactPhi } from '../src/log.ts';

describe('redactPhi', () => {
  it('strips body-bearing keys and ACS access keys', () => {
    const out = redactPhi({
      messageId: 'm1',
      content: 'patient reports chest pain',
      text: 'also secret',
      html: '<p>nope</p>',
      body: 'nope',
      metadata: { originalSenderUserId: 'u1' },
      nested: { content: 'still secret' },
    }) as Record<string, unknown>;
    expect(out.content).toBe('[redacted]');
    expect(out.text).toBe('[redacted]');
    expect(out.html).toBe('[redacted]');
    expect(out.body).toBe('[redacted]');
    expect(out.messageId).toBe('m1');
    expect((out.nested as { content: string }).content).toBe('[redacted]');
    expect(redactPhi('endpoint=https://x.communication.azure.com/;accesskey=abc123')).toBe(
      'endpoint=https://x.communication.azure.com/;accesskey=[redacted]',
    );
  });
});

describe('log', () => {
  it('never writes a message body to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('replayed message', { content: 'patient reports chest pain', messageId: '42' });
    const dumped = JSON.stringify(spy.mock.calls);
    expect(dumped).not.toMatch(/chest pain/);
    expect(dumped).toMatch(/\[redacted\]/);
    spy.mockRestore();
  });
});

describe('redactSecrets on connection URLs', () => {
  it('strips the password out of a Postgres URL', async () => {
    const { redactSecrets } = await import('../src/log.ts');
    expect(redactSecrets('postgres://admin:hunter2@db.postgres.database.azure.com:5432/app')).toBe(
      'postgres://admin:[redacted]@db.postgres.database.azure.com:5432/app',
    );
  });
});

describe('redactPhi hardening', () => {
  it('survives a cycle instead of taking the process down with the error', async () => {
    const { redactPhi } = await import('../src/log.ts');
    // The shape of a real Azure SDK error: request and response point at
    // each other, so a naive walk never terminates.
    const request: Record<string, unknown> = { url: 'https://x.communication.azure.com' };
    const response: Record<string, unknown> = { status: 429, request };
    request.response = response;
    const out = redactPhi({ error: response }) as Record<string, Record<string, unknown>>;
    expect(out.error?.status).toBe(429);
    expect(JSON.stringify(out)).toContain('[circular]');
  });

  it('caps depth rather than exhausting the stack', async () => {
    const { redactPhi } = await import('../src/log.ts');
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 5000; i++) {
      const next: Record<string, unknown> = {};
      cur.n = next;
      cur = next;
    }
    expect(JSON.stringify(redactPhi(root))).toContain('[truncated]');
  });

  it('keeps an Error readable, without its stack', async () => {
    const { redactPhi } = await import('../src/log.ts');
    const out = redactPhi({
      error: new Error('connect failed for postgres://admin:hunter2@db:5432/app'),
    }) as Record<string, Record<string, unknown>>;
    expect(out.error?.name).toBe('Error');
    expect(out.error?.message).toContain('[redacted]');
    expect(out.error?.message).not.toContain('hunter2');
    expect(out.error?.stack).toBeUndefined();
  });

  it('still redacts bodies at depth, and renders siblings sharing one object', async () => {
    const { redactPhi } = await import('../src/log.ts');
    const shared = { content: 'lorem ipsum', threadId: '19:t' };
    const out = redactPhi({ a: shared, b: shared, deep: { x: { y: { content: 'more' } } } }) as any;
    expect(out.a.content).toBe('[redacted]');
    // Appearing twice side by side is not a cycle; both must render.
    expect(out.b.content).toBe('[redacted]');
    expect(out.b.threadId).toBe('19:t');
    expect(out.deep.x.y.content).toBe('[redacted]');
  });
});
