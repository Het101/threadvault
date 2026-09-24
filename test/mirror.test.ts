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
          return Promise.resolve({ rows: [{ our_user_id: 'u-1', acs_id: '8:acs:test_auth-1' }] });
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
          originalSenderUserId: 'u-sender-uuid',
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
    expect(msgQuery?.values[2]).toBe('u-sender-uuid');
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
          ourUserId: 'u-alice',
        },
      ]),
      db,
    );

    expect(stats.identities).toBe(1);
    const idQuery = executed.find((q) => q.sql.includes('INSERT INTO threadvault_identities'));
    expect(idQuery).toBeDefined();
    expect(idQuery?.values[0]).toBe('u-alice');
    expect(idQuery?.values[1]).toBe(`8:acs:${guid}_alice`);
    // The resource GUID comes out of the ACS id itself, so nothing extra is needed.
    expect(idQuery?.values[2]).toBe(guid);
    expect(idQuery?.values[3]).toBe('Alice');
  });
});
