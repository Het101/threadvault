import { describe, expect, it } from 'vitest';
import { formatPlan, migratePlan } from '../src/migrate/plan.ts';
import { shadowUserId } from '../src/mirror/sink-postgres.ts';
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
    expect(out).toContain('Expected for a first extract');
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

/**
 * Found by replaying from a Postgres mirror for the first time.
 *
 * `mirror backfill` stands a derived id in for any participant the host tables
 * did not map, so that re-running is a no-op. Replaying that mints an ACS
 * identity against a synthetic id — the thread is whole, the messages are
 * attributed, and the person matches no row in the caller's users table.
 *
 * plan reported "messages carrying our user id: 5 of 5" and said nothing about
 * it, because that metric counts messages and the derived id is on a
 * participant.
 */
describe('participants the host never mapped', () => {
  const GUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const acs = (n: string) => `8:acs:${GUID}_${n}`;

  const participant = (n: string, ourUserId: string | null): Rec => ({
    kind: 'participant',
    legacyThreadId: '19:t@thread.v2',
    acsId: acs(n),
    displayName: null,
    ourUserId,
  });

  it('counts a derived id, and does not mistake a real one for it', async () => {
    const report = await migratePlan(
      recs([
        participant('a', shadowUserId(acs('a'))),
        participant('b', '11111111-1111-4111-8111-111111111111'),
      ]),
    );
    expect(report.participantsWithDerivedId).toBe(1);
    expect(report.participants).toBe(2);
  });

  // Detection is exact, not a guess: shadowUserId is deterministic, so a value
  // either is the derived id for that ACS id or it is not.
  it('does not flag a UUID that merely looks synthetic', async () => {
    const report = await migratePlan(
      recs([participant('a', shadowUserId(acs('somebody-else')))]),
    );
    expect(report.participantsWithDerivedId).toBe(0);
  });

  it('does not flag a participant with no id at all', async () => {
    const report = await migratePlan(recs([participant('a', null)]));
    expect(report.participantsWithDerivedId).toBe(0);
  });

  it('explains what a derived id costs, rather than only counting it', async () => {
    const out = formatPlan(
      await migratePlan(recs([participant('a', shadowUserId(acs('a'))), participant('b', 'u')])),
    );
    expect(out).toContain('of those, with a derived id:    1');
    expect(out).toMatch(/1 of 2 participant\(s\) carry an id this tool/);
    expect(out).toContain('matches no row in your users table');
    // And says how to fix it, not just that it is wrong.
    expect(out).toContain('point threadvault.yml');
  });

  it('says nothing when every participant was mapped', async () => {
    const out = formatPlan(
      await migratePlan(recs([participant('b', '11111111-1111-4111-8111-111111111111')])),
    );
    expect(out).toContain('of those, with a derived id:    0');
    expect(out).not.toContain('carry an id this tool');
  });
});
