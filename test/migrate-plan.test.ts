import { describe, expect, it } from 'vitest';
import { formatPlan, migratePlan } from '../src/migrate/plan.ts';
import type { Rec } from '../src/mirror/types.ts';

async function* recs(items: Rec[]): AsyncIterable<Rec> {
  for (const item of items) yield item;
}

const guidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const guidB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('migratePlan', () => {
  it('counts threads, participants, messages and flags missing original sender', async () => {
    const report = await migratePlan(
      recs([
        {
          kind: 'thread',
          ourThreadId: null,
          legacyThreadId: '19:t@thread.v2',
          topic: 't',
          createdOn: '2022-01-01T00:00:00.000Z',
          createdByAcsId: `8:acs:${guidA}_sys`,
          deletedOn: null,
          readerAcsId: `8:acs:${guidA}_sys`,
        },
        {
          kind: 'participant',
          legacyThreadId: '19:t@thread.v2',
          acsId: `8:acs:${guidA}_user`,
          displayName: 'User',
          ourUserId: 'u-user',
        },
        {
          kind: 'message',
          legacyThreadId: '19:t@thread.v2',
          messageId: 'm1',
          type: 'text',
          sequenceId: '1',
          content: 'lorem',
          senderAcsId: `8:acs:${guidA}_user`,
          senderDisplayName: null,
          ourSenderUserId: 'u-user',
          createdOn: '2022-01-01T12:00:00.000Z',
          editedOn: null,
          deletedOn: null,
          metadata: { originalCreatedOn: '2022-01-01T12:00:00.000Z', originalSenderUserId: 'u-user' },
        },
        {
          kind: 'message',
          legacyThreadId: '19:t@thread.v2',
          messageId: 'm2',
          type: 'text',
          sequenceId: '2',
          content: 'ipsum',
          senderAcsId: `8:acs:${guidA}_sys`,
          senderDisplayName: null,
          ourSenderUserId: null,
          createdOn: '2022-01-01T12:01:00.000Z',
          editedOn: null,
          deletedOn: null,
          metadata: null,
        },
      ]),
    );
    expect(report.threads).toBe(1);
    expect(report.participants).toBe(1);
    expect(report.messages).toBe(2);
    expect(report.messagesMissingOriginalSender).toBe(1);
    expect(report.resourceGuids).toEqual([guidA]);
  });

  it('counts stale identities against the target resource GUID', async () => {
    const report = await migratePlan(
      recs([
        {
          kind: 'participant',
          legacyThreadId: '19:t@thread.v2',
          acsId: `8:acs:${guidB}_user`,
          displayName: null,
          ourUserId: 'u-user',
        },
      ]),
      guidA,
    );
    expect(report.staleAcsIds).toBe(1);
    expect(report.resourceGuids).toEqual([guidB]);
  });
});

describe('migratePlan control messages', () => {
  it('separates ACS control messages from what apply will actually replay', async () => {
    const msg = (type: string, id: string): Rec => ({
      kind: 'message',
      legacyThreadId: '19:t@thread.v2',
      messageId: id,
      type,
      sequenceId: '1',
      content: type === 'text' ? 'lorem' : null,
      senderAcsId: null,
      senderDisplayName: null,
      ourSenderUserId: 'u-user',
      createdOn: '2022-01-01T12:00:00.000Z',
      editedOn: null,
      deletedOn: null,
      metadata: null,
    });
    const report = await migratePlan(
      recs([msg('text', 'm1'), msg('participantAdded', 'm2'), msg('topicUpdated', 'm3')]),
    );
    expect(report.messages).toBe(3);
    expect(report.controlMessages).toBe(2);
    expect(formatPlan(report)).toContain('replayable by apply:            1');
  });
});
