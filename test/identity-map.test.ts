import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIdentityMap, writeIdentityMap } from '../src/migrate/identity-map.ts';

const dir = mkdtempSync(join(tmpdir(), 'tv-idmap-'));

describe('identity map', () => {
  it('round-trips so a re-run reuses identities instead of minting new ones', () => {
    const path = join(dir, 'map.json');
    writeIdentityMap(path, new Map([['8:acs:old_b', '8:acs:new_b'], ['8:acs:old_a', '8:acs:new_a']]));
    const back = readIdentityMap(path);
    expect(back.get('8:acs:old_a')).toBe('8:acs:new_a');
    expect(back.get('8:acs:old_b')).toBe('8:acs:new_b');
  });

  it('is empty, not an error, when the file does not exist yet', () => {
    expect(readIdentityMap(join(dir, 'missing.json')).size).toBe(0);
  });

  it('refuses a malformed map rather than silently minting a fresh estate', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"8:acs:old_a": 42}', 'utf8');
    expect(() => readIdentityMap(bad)).toThrow(/not an ACS id/);
    writeFileSync(bad, '["nope"]', 'utf8');
    expect(() => readIdentityMap(bad)).toThrow(/expected a JSON object/);
  });
});
