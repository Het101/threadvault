import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type HostMapping = {
  usersTable: string;
  usersIdColumn: string;
  usersAcsIdColumn: string;
  usersSystemColumn: string;
  threadsTable: string;
  threadsIdColumn: string;
  threadsExternalIdColumn: string;
  participantsTable: string;
  participantsThreadColumn: string;
  participantsUserColumn: string;
};

export type ThreadvaultConfig = {
  host?: HostMapping;
};

const HOST_KEYS: (keyof HostMapping)[] = [
  'usersTable',
  'usersIdColumn',
  'usersAcsIdColumn',
  'usersSystemColumn',
  'threadsTable',
  'threadsIdColumn',
  'threadsExternalIdColumn',
  'participantsTable',
  'participantsThreadColumn',
  'participantsUserColumn',
];

function asMapping(raw: unknown): HostMapping | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const out = {} as HostMapping;
  for (const k of HOST_KEYS) {
    const v = rec[k];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`threadvault.yml host.${k} must be a non-empty string`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
      throw new Error(`threadvault.yml host.${k} is not a safe identifier: ${v}`);
    }
    out[k] = v;
  }
  return out;
}

export function loadConfig(configPath?: string): ThreadvaultConfig {
  const candidates = configPath
    ? [resolve(configPath)]
    : [resolve('threadvault.yml'), resolve('threadvault.yaml')];
  // Read each candidate and let absence fall through, rather than testing for
  // existence first. Checking and then reading leaves a window where the file
  // can change, and the same read has to happen either way.
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    const raw = parseYaml(text) as unknown;
    if (raw == null) return {};
    if (typeof raw !== 'object') throw new Error(`${path}: expected a mapping`);
    const host = (raw as { host?: unknown }).host;
    return { host: asMapping(host) };
  }

  if (configPath) throw new Error(`config not found: ${configPath}`);
  return {};
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`${name} is not set`);
  return v;
}

export function acsConnectionString(): string {
  return (
    process.env.ACS_CONNECTION_STRING ||
    process.env.ACS_NEW_CONNECTION_STRING ||
    process.env.AZURE_COMMUNICATION_CONNECTION_STRING ||
    ''
  );
}

/**
 * Twilio credentials, by name only.
 *
 * An API key (SK…) is preferred over the account auth token: it can be
 * revoked on its own, where the auth token is the whole account.
 */
export function twilioAuth(): { accountSid: string; username?: string; password: string } | null {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const keySid = (process.env.TWILIO_API_KEY_SID || '').trim();
  const keySecret = (process.env.TWILIO_API_KEY_SECRET || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!accountSid && !keySid && !token) return null;
  if (keySid && keySecret) return { accountSid, username: keySid, password: keySecret };
  return { accountSid, password: token };
}

export function acsExpectResource(): string {
  return (process.env.ACS_EXPECT_RESOURCE || '').trim().toLowerCase();
}
