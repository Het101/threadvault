import { describe, expect, it, vi } from 'vitest';
import { sourcePostgres } from '../src/mirror/source-postgres.ts';
import type { PgClient } from '../src/db/pg.ts';
import type { Rec } from '../src/mirror/types.ts';

describe('sourcePostgres', () => {
  it('emits thread then participants then messages in sent_at order', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM threadvault_threads')) {
          return Promise.resolve({
            rows: [
              {
                id: 'th-1',
                external_id: '19:t@thread.v2',
                topic: 'Care',
                created_on: new Date('2022-01-01T00:00:00.000Z'),
                metadata: { createdByAcsId: '8:acs:old_sys' },
              },
            ],
          });
        }
        if (sql.includes('FROM threadvault_participants')) {
          return Promise.resolve({
            rows: [
              {
                acs_id: '8:acs:old_user',
                display_name: 'Patient',
                our_user_id: 'u-user',
                external_id: '19:t@thread.v2',
              },
            ],
          });
        }
        if (sql.includes('FROM threadvault_messages')) {
          return Promise.resolve({
            rows: [
              {
                external_message_id: 'm-1',
                sender_user_id: 'u-user',
                content: 'lorem',
                message_type: 'text',
                sent_at: new Date('2022-01-01T12:00:00.000Z'),
                edited_at: null,
                deleted_at: null,
                metadata: {
                  originalSenderUserId: 'u-user',
                  originalCreatedOn: '2022-01-01T12:00:00.000Z',
                },
                external_id: '19:t@thread.v2',
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as PgClient;

    const out: Rec[] = [];
    for await (const rec of sourcePostgres(mockDb)) out.push(rec);

    expect(out.map((r) => r.kind)).toEqual(['thread', 'participant', 'message']);
    const thread = out[0];
    const participant = out[1];
    const message = out[2];
    if (thread?.kind !== 'thread') throw new Error('expected thread');
    if (participant?.kind !== 'participant') throw new Error('expected participant');
    if (message?.kind !== 'message') throw new Error('expected message');
    expect(thread.legacyThreadId).toBe('19:t@thread.v2');
    expect(participant.ourUserId).toBe('u-user');
    expect(message.ourSenderUserId).toBe('u-user');
    expect(message.createdOn).toBe('2022-01-01T12:00:00.000Z');
  });
});
