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

/**
 * Found against a real resource: a first extract reported every message as
 * missing its original sender, which reads as total attribution loss and is
 * simply how ACS works. The count alone cannot tell the two apart.
 */
describe('how plan reports attribution', () => {
  const message = (n: number, ourSenderUserId: string | null): Rec => ({
    kind: 'message',
    legacyThreadId: '19:t@thread.v2',
    messageId: `m-${n}`,
    type: 'text',
    sequenceId: String(n),
    content: 'lorem',
    senderAcsId: `8:acs:${guidA}_user`,
    senderDisplayName: null,
    ourSenderUserId,
    createdOn: '2022-01-01T12:00:00.000Z',
    editedOn: null,
    deletedOn: null,
    metadata: null,
  });

  it('explains a dump with no our-user-ids instead of just counting them', async () => {
    const report = await migratePlan(recs([message(1, null), message(2, null)]));
    const out = formatPlan(report);

    expect(out).toContain('messages carrying our user id:    0 of 2');
    // The reassurance has to be there, or a first-time user reads 0 of 2 as a
    // disaster and stops.
    expect(out).toContain('Expected for a first `migrate');
    expect(out).not.toContain('WARNING');
  });

  it('warns loudly when only some messages lost it, which is the real defect', async () => {
    const report = await migratePlan(recs([message(1, 'u-1'), message(2, null), message(3, null)]));
    const out = formatPlan(report);

    expect(out).toContain('messages carrying our user id:    1 of 3');
    expect(out).toContain('WARNING');
    expect(out).toContain('2 do not');
    // A partial dump must not be described as expected.
    expect(out).not.toContain('Expected for a first');
  });

  it('says nothing extra when every message carries one', async () => {
    const report = await migratePlan(recs([message(1, 'u-1'), message(2, 'u-2')]));
    const out = formatPlan(report);

    expect(out).toContain('messages carrying our user id:    2 of 2');
    expect(out).not.toContain('WARNING');
    expect(out).not.toContain('note:');
  });

  // An ACS identity in the UUID field is not attribution, it is the bug that
  // caused the incident. It must not be counted as present.
  it('does not count an ACS identity stuffed into the user id field', async () => {
    const report = await migratePlan(recs([message(1, `8:acs:${guidA}_user`)]));
    expect(formatPlan(report)).toContain('messages carrying our user id:    0 of 1');
  });
});
