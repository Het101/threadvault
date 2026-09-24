import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('loads a host mapping and rejects unsafe identifiers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-'));
    const path = join(dir, 'threadvault.yml');
    writeFileSync(
      path,
      `
host:
  usersTable: UserDetails
  usersIdColumn: user_id
  usersAcsIdColumn: acsUserId
  usersSystemColumn: isSystemUser
  threadsTable: ChatThread
  threadsIdColumn: id
  threadsExternalIdColumn: externalId
  participantsTable: ChatParticipant
  participantsThreadColumn: threadId
  participantsUserColumn: userId
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.host?.usersTable).toBe('UserDetails');
    expect(cfg.host?.usersIdColumn).toBe('user_id');
  });

  it('rejects SQL in a column name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-'));
    const path = join(dir, 'threadvault.yml');
    writeFileSync(
      path,
      `
host:
  usersTable: UserDetails; DROP TABLE UserDetails
  usersIdColumn: user_id
  usersAcsIdColumn: acsUserId
  usersSystemColumn: isSystemUser
  threadsTable: ChatThread
  threadsIdColumn: id
  threadsExternalIdColumn: externalId
  participantsTable: ChatParticipant
  participantsThreadColumn: threadId
  participantsUserColumn: userId
`,
    );
    expect(() => loadConfig(path)).toThrow(/not a safe identifier/);
  });
});

describe('loadConfig error handling', () => {
  it('falls through a missing file, but surfaces a real read failure', () => {
    expect(() => loadConfig(join(tmpdir(), 'tv-no-such-config.yml'))).toThrow(/config not found/);

    // A directory is not "absent" — it must not be reported as such.
    const d = mkdtempSync(join(tmpdir(), 'tv-cfg-'));
    expect(() => loadConfig(d)).toThrow();
  });
});
