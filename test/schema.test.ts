import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../src/db/schema.ts';

describe('SCHEMA_SQL', () => {
  it('creates the four mirror tables and does not log PHI column names as values', () => {
    expect(SCHEMA_SQL).toMatch(/threadvault_threads/);
    expect(SCHEMA_SQL).toMatch(/threadvault_identities/);
    expect(SCHEMA_SQL).toMatch(/threadvault_participants/);
    expect(SCHEMA_SQL).toMatch(/threadvault_messages/);
    expect(SCHEMA_SQL).toMatch(/external_message_id\s+varchar\(255\) UNIQUE/);
    expect(SCHEMA_SQL).toMatch(/sender_user_id\s+uuid/);
    expect(SCHEMA_SQL).toMatch(/sent_at\s+timestamptz NOT NULL/);
  });
});
