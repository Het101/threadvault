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
/** `postgres://user:password@host` - pg surfaces these in connection errors. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s@/]+@/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET, 'accesskey=[redacted]').replace(URL_CREDENTIALS, '$1[redacted]@');
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

/**
 * The only way to put structured output on stdout. `--json` used to hand
 * JSON.stringify straight to console.log, which walked around every redaction
 * rule in this file. Route it through the same strippers as everything else.
 */
export function logJson(value: unknown): void {
  console.log(redactSecrets(JSON.stringify(redactPhi(value), null, 2)));
}
