import { existsSync, readFileSync } from 'node:fs';
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
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    if (configPath) throw new Error(`config not found: ${configPath}`);
    return {};
  }
  const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
  if (raw == null) return {};
  if (typeof raw !== 'object') throw new Error(`${path}: expected a mapping`);
  const host = (raw as { host?: unknown }).host;
  return { host: asMapping(host) };
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

export function acsExpectResource(): string {
  return (process.env.ACS_EXPECT_RESOURCE || '').trim().toLowerCase();
}
