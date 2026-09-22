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
