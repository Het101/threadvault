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

/**
 * How deep to walk before giving up. Well past anything worth logging, and far
 * short of the stack.
 */
const MAX_DEPTH = 12;

export function redactPhi(value: unknown): unknown {
  return redact(value, 0, new Set<object>());
}

/**
 * `path` holds the objects between the root and here, so a genuine cycle is
 * caught while the same object appearing twice side by side still renders.
 *
 * Without it this recursed forever. An Azure SDK error carries request and
 * response objects that point back at each other, so logging one killed the
 * process — and a logger that dies while reporting an error takes the error
 * with it, which is the worst possible moment to fail.
 */
function redact(value: unknown, depth: number, path: Set<object>): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value !== 'object') return value;

  // Errors carry their message and stack as non-enumerable properties, so the
  // generic object walk below renders them as {}. Keep the message; leave the
  // stack out, since frames can carry argument values.
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(value.message) };
  }

  if (depth >= MAX_DEPTH) return '[truncated]';
  if (path.has(value)) return '[circular]';
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, path));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Assigning __proto__ would set this object's prototype rather than a
      // key on it, silently dropping whatever it held from the output.
      if (k === '__proto__') continue;
      out[k] = PHI_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1, path);
    }
    return out;
  } finally {
    path.delete(value);
  }
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
