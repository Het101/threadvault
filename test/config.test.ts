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
