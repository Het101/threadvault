import { lookup } from 'node:dns';
import { promisify } from 'node:util';
import pg from 'pg';

const { Client } = pg;
const dnsLookup = promisify(lookup) as (
  h: string,
  o: { family: number },
) => Promise<{ address: string }>;

export type PgClient = pg.Client;

/**
 * Azure Postgres Flexible Server refuses unencrypted connections. Encrypt
 * without pinning Azure's CA unless PG_SSL_VERIFY=true. Local hosts stay plain.
 */
export function sslFor(host: string): false | { rejectUnauthorized: boolean } {
  if (/^(localhost|127\.0\.0\.1|::1|host\.docker\.internal)$/i.test(host)) return false;
  return { rejectUnauthorized: process.env.PG_SSL_VERIFY === 'true' };
}

const dnsCache = new Map<string, string>();

for (const pair of (process.env.PG_HOST_OVERRIDE ?? '').split(',')) {
  const [host, addr] = pair.split('=').map((x) => x.trim());
  if (host && addr) dnsCache.set(host, addr);
}

export async function resolveOnce(host: string): Promise<string> {
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return host;
  const hit = dnsCache.get(host);
  if (hit) return hit;
  const { address } = await dnsLookup(host, { family: 4 });
  dnsCache.set(host, address);
  return address;
}

type PgConfig = {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  statement_timeout: number;
  ssl: false | { rejectUnauthorized: boolean; servername?: string };
};

export async function pgConfigFor(url: string): Promise<PgConfig> {
  const u = new URL(url);
  const host = u.hostname;
  const tls = sslFor(host);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: await resolveOnce(host),
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    statement_timeout: 120_000,
    ssl: tls === false ? false : { ...tls, servername: host },
  };
}

export async function connect(url: string, readOnly: boolean): Promise<PgClient> {
  const cfg = await pgConfigFor(url);
  const attempts = Math.max(1, Number(process.env.PG_CONNECT_ATTEMPTS || 5));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const c = new Client(cfg);
    c.on('error', () => undefined);
    try {
      await c.connect();
      if (readOnly) await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      return c;
    } catch (e) {
      lastErr = e;
      await c.end().catch(() => undefined);
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, Math.min(8_000, 1_000 * 2 ** (attempt - 1))));
      }
    }
  }
  throw lastErr;
}

export function connectReadOnly(url: string): Promise<PgClient> {
  return connect(url, true);
}

/** Quote an identifier we already validated as /^[A-Za-z_][A-Za-z0-9_]*$/. */
export function qid(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
