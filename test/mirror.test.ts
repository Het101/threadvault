import { describe, expect, it, vi } from 'vitest';
import { sinkPostgres } from '../src/mirror/sink-postgres.ts';
import type { Rec } from '../src/mirror/types.ts';
import type { PgClient } from '../src/db/pg.ts';

async function* asyncGeneratorFromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const item of arr) {
    yield item;
  }
}

describe('sinkPostgres', () => {
  it('upserts threads, participants, and messages correctly mapped', async () => {
    const executedQueries: Array<{ sql: string; values: any[] }> = [];

    const mockDb = {
      query: vi.fn().mockImplementation((sql: string, values?: any[]) => {
        executedQueries.push({ sql, values: values || [] });

        if (sql.includes('SELECT our_user_id, acs_id')) {
          return Promise.resolve({ rows: [{ our_user_id: '11111111-1111-4111-8111-111111111111', acs_id: '8:acs:test_auth-1' }] });
        }

        if (sql.includes('INSERT INTO threadvault_threads')) {
          return Promise.resolve({ rows: [{ id: 'th-uuid-1' }] });
        }

        if (sql.includes('INSERT INTO threadvault_participants') || sql.includes('INSERT INTO threadvault_messages')) {
          return Promise.resolve({ rowCount: 1 });
        }

        return Promise.resolve({ rows: [] });
      })
    } as unknown as PgClient;

    const stream = asyncGeneratorFromArray<Rec>([
      {
        kind: 'thread',
        legacyThreadId: '19:test@thread.v2',
        topic: 'Test Topic',
        createdOn: '2023-01-01T00:00:00.000Z',
        createdByAcsId: '8:acs:test_auth-1',
        ourThreadId: null,
        deletedOn: null,
        readerAcsId: '8:acs:test_reader'
      },
      {
        kind: 'participant',
        legacyThreadId: '19:test@thread.v2',
        acsId: '8:acs:test_auth-1',
        displayName: 'Test User',
        ourUserId: null
      },
      {
        kind: 'message',
        legacyThreadId: '19:test@thread.v2',
        messageId: 'msg-1',
        type: 'text',
        sequenceId: '1',
        content: 'hello',
        senderAcsId: '8:acs:test_auth-2',
        senderDisplayName: null,
        ourSenderUserId: null,
        createdOn: '2023-01-01T10:00:00.000Z',
        editedOn: null,
        deletedOn: null,
        metadata: {
          originalSenderUserId: '55555555-5555-4555-8555-555555555555',
          originalCreatedOn: '2023-01-01T09:00:00.000Z'
        }
      }
    ]);

    const stats = await sinkPostgres(stream, mockDb);

    // This fixture's ACS id has a non-UUID resource half, so it does not parse
    // and no identity row is written — hence identities: 0.
    expect(stats).toEqual({ threads: 1, participants: 1, messages: 1, identities: 0 });

    const threadQuery = executedQueries.find(q => q.sql.includes('INSERT INTO threadvault_threads'));
    expect(threadQuery).toBeDefined();
    expect(threadQuery?.values[0]).toBe('19:test@thread.v2'); // external_id

    const msgQuery = executedQueries.find(q => q.sql.includes('INSERT INTO threadvault_messages'));
    expect(msgQuery).toBeDefined();
    // thread_id, external_message_id, sender_user_id, content, message_type, sent_at
    expect(msgQuery?.values[0]).toBe('th-uuid-1');
    expect(msgQuery?.values[1]).toBe('msg-1');
    // Important: sender_user_id is UUID (resolved from metadata), not ACS id
    expect(msgQuery?.values[2]).toBe('55555555-5555-4555-8555-555555555555');
    // Important: sent_at is original (resolved from metadata), not replayed date
    expect(msgQuery?.values[5]).toEqual(new Date('2023-01-01T09:00:00.000Z'));
  });
});

describe('shadowUserId', () => {
  it('is stable for an ACS id, so re-running the backfill is a no-op', async () => {
    const { shadowUserId } = await import('../src/mirror/sink-postgres.ts');
    const a = shadowUserId('8:acs:test_auth-1');
    expect(shadowUserId('8:acs:test_auth-1')).toBe(a);
    expect(shadowUserId('8:acs:test_auth-2')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('sinkPostgres records identities', () => {
  it('writes an identity row so the mirror can map an ACS id back to a person', async () => {
    const executed: Array<{ sql: string; values: any[] }> = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string, values?: any[]) => {
        executed.push({ sql, values: values || [] });
        if (sql.includes('SELECT our_user_id, acs_id')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO threadvault_threads')) return Promise.resolve({ rows: [{ id: 'th-1' }] });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }),
    } as unknown as PgClient;

    const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const stats = await sinkPostgres(
      asyncGeneratorFromArray<Rec>([
        {
          kind: 'thread',
          legacyThreadId: '19:t@thread.v2',
          topic: 'Care',
          createdOn: '2023-01-01T00:00:00.000Z',
          createdByAcsId: null,
          ourThreadId: null,
          deletedOn: null,
          readerAcsId: `8:acs:${guid}_reader`,
        },
        {
          kind: 'participant',
          legacyThreadId: '19:t@thread.v2',
          acsId: `8:acs:${guid}_alice`,
          displayName: 'Alice',
          ourUserId: '11111111-1111-4111-8111-111111111111',
        },
      ]),
      db,
    );

    expect(stats.identities).toBe(1);
    const idQuery = executed.find((q) => q.sql.includes('INSERT INTO threadvault_identities'));
    expect(idQuery).toBeDefined();
    expect(idQuery?.values[0]).toBe('11111111-1111-4111-8111-111111111111');
    expect(idQuery?.values[1]).toBe(`8:acs:${guid}_alice`);
    // The resource GUID comes out of the ACS id itself, so nothing extra is needed.
    expect(idQuery?.values[2]).toBe(guid);
    expect(idQuery?.values[3]).toBe('Alice');
  });
});

describe('re-running the backfill repairs, not just deduplicates', () => {
  it('refreshes attribution and timing on conflict, not only content', async () => {
    const executed: Array<{ sql: string }> = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        executed.push({ sql });
        if (sql.includes('SELECT our_user_id, acs_id')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO threadvault_threads')) return Promise.resolve({ rows: [{ id: 'th-1' }] });
        // The message path looks its thread up when the cache is cold; without
        // a row it correctly skips the message entirely.
        if (sql.includes('SELECT id FROM threadvault_threads')) return Promise.resolve({ rows: [{ id: 'th-1' }] });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }),
    } as unknown as PgClient;

    await sinkPostgres(
      asyncGeneratorFromArray<Rec>([
        {
          kind: 'message',
          legacyThreadId: '19:t@thread.v2',
          messageId: 'm-1',
          type: 'text',
          sequenceId: '1',
          content: 'lorem',
          senderAcsId: null,
          senderDisplayName: null,
          ourSenderUserId: '11111111-1111-4111-8111-111111111111',
          createdOn: '2023-01-01T10:00:00.000Z',
          editedOn: null,
          deletedOn: null,
          metadata: { originalSenderUserId: '11111111-1111-4111-8111-111111111111' },
        },
      ]),
      db,
    );

    const msg = executed.find((q) => q.sql.includes('INSERT INTO threadvault_messages'));
    expect(msg).toBeDefined();
    // A mirror taken before the mapping existed has a null sender. Re-running
    // after fixing it has to actually fix it.
    expect(msg?.sql).toMatch(/sender_user_id = EXCLUDED\.sender_user_id/);
    expect(msg?.sql).toMatch(/sent_at = EXCLUDED\.sent_at/);
    expect(msg?.sql).toMatch(/metadata = EXCLUDED\.metadata/);
  });
});

/**
 * Found by running `mirror backfill --commit` against a real Postgres for the
 * first time. The mirror stores our user ids in `uuid` columns, and nothing
 * checked that before handing them to the driver.
 */
describe('sinkPostgres and our user ids', () => {
  const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const UU = {
    alice: '11111111-1111-4111-8111-111111111111',
    bob: '22222222-2222-4222-8222-222222222222',
  };

  function fakeDb() {
    const executed: Array<{ sql: string; values: any[] }> = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string, values?: any[]) => {
        executed.push({ sql, values: values || [] });
        if (sql.includes('SELECT our_user_id, acs_id')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO threadvault_threads')) return Promise.resolve({ rows: [{ id: 'th-1' }] });
        if (sql.includes('SELECT id FROM threadvault_threads')) return Promise.resolve({ rows: [{ id: 'th-1' }] });
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'm-1' }] });
      }),
    } as unknown as PgClient;
    return { db, executed };
  }

  const thread = (): Rec => ({
    kind: 'thread', legacyThreadId: '19:t@thread.v2', topic: 'lorem',
    createdOn: '2023-01-01T00:00:00.000Z', createdByAcsId: null, ourThreadId: null,
    deletedOn: null, readerAcsId: `8:acs:${GUID}_reader`,
  });
  const participant = (who: string, ourUserId: string | null): Rec => ({
    kind: 'participant', legacyThreadId: '19:t@thread.v2',
    acsId: `8:acs:${GUID}_${who}`, displayName: null, ourUserId,
  });

  /**
   * Postgres answers `invalid input syntax for type uuid: "u-alice-0001"` — no
   * field, no record, no hint a UUID was ever wanted. And by then a thread row
   * is already written, because the backfill is not one transaction.
   */
  it('refuses a participant id that is not a UUID, and says which and where', async () => {
    const { db } = fakeDb();
    await expect(
      sinkPostgres(asyncGeneratorFromArray<Rec>([thread(), participant('alice', 'u-alice-0001')]), db),
    ).rejects.toThrow(/ourUserId is not a UUID: "u-alice-0001" \(thread 19:t@thread\.v2\)/);
  });

  it('says re-running is safe, because a partial write is what it leaves behind', async () => {
    const { db } = fakeDb();
    await expect(
      sinkPostgres(asyncGeneratorFromArray<Rec>([thread(), participant('alice', 'nope')]), db),
    ).rejects.toThrow(/updates rows rather than duplicating/);
  });

  it('refuses a message sender that is not a UUID', async () => {
    const { db } = fakeDb();
    const msg: Rec = {
      kind: 'message', legacyThreadId: '19:t@thread.v2', messageId: 'm1', type: 'text',
      sequenceId: '1', content: 'lorem', senderAcsId: `8:acs:${GUID}_alice`,
      senderDisplayName: null, ourSenderUserId: 'not-a-uuid',
      createdOn: '2023-01-01T00:00:00.000Z', editedOn: null, deletedOn: null, metadata: null,
    };
    await expect(
      sinkPostgres(asyncGeneratorFromArray<Rec>([thread(), msg]), db),
    ).rejects.toThrow(/ourSenderUserId is not a UUID/);
  });

  // A participant the host has not mapped is normal, and gets a derived id.
  // Only a *present but wrong* value is an error.
  it('still accepts a null user id and derives a stand-in', async () => {
    const { db } = fakeDb();
    const stats = await sinkPostgres(
      asyncGeneratorFromArray<Rec>([thread(), participant('alice', null)]), db,
    );
    expect(stats.participants).toBe(1);
  });

  /**
   * One person in three threads is three upserts and one row. The count said
   * three, so reconciling it against the table never added up.
   */
  it('counts each identity once, not once per upsert', async () => {
    const { db } = fakeDb();
    const stats = await sinkPostgres(
      asyncGeneratorFromArray<Rec>([
        thread(),
        participant('alice', UU.alice),
        participant('bob', UU.bob),
        // alice again, as she would be in a second thread
        { ...(participant('alice', UU.alice) as any), legacyThreadId: '19:t@thread.v2' },
      ]),
      db,
    );
    expect(stats.identities).toBe(2);
  });
});
