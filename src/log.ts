/** Keys that can hold chat / email bodies. Never printed. */
const PHI_KEYS = new Set([
  'content',
  'text',
  'html',
  'body',
  'message',
  'textContent',
  'htmlContent',
  'html_content',
  'text_content',
]);

const SECRET = /accesskey=[^;\s]+/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET, 'accesskey=[redacted]');
}

export function redactPhi(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactPhi);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PHI_KEYS.has(k) ? '[redacted]' : redactPhi(v);
    }
    return out;
  }
  return value;
}

export function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(redactSecrets(message), redactPhi(extra));
  else console.log(redactSecrets(message));
}

export function logError(message: string, extra?: Record<string, unknown>): void {
  if (extra) console.error(redactSecrets(message), redactPhi(extra));
  else console.error(redactSecrets(message));
}
