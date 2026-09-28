import { describe, expect, it } from 'vitest';
import { buildIdentityMap, measureCoverage, remap, coverageLines } from '../src/mirror/remap.ts';
import type { Rec } from '../src/mirror/types.ts';

/**
 * The gap this closes: `migrate extract` walks ACS, which knows nothing about
 * your users, so it writes `ourUserId: null`. The Postgres sink stands in a
 * derived id for every null. Nothing in between ever consulted the host users
 * table, which only `doctor` read. An estate migrated that way is internally
 * consistent and attributed to nobody.
 */

const GUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const acs = (u: string) => `8:acs:${GUID}_${u}`;
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const participant = (u: string, ourUserId: string | null = null): Rec => ({
  kind: 'participant',
  legacyThreadId: '19:t@thread.v2',
  acsId: acs(u),
  displayName: 'lorem',
  ourUserId,
});

const message = (
  senderAcsId: string | null,
  ourSenderUserId: string | null = null,
): Rec => ({
  kind: 'message',
  legacyThreadId: '19:t@thread.v2',
  messageId: 'm1',
  type: 'text',
  sequenceId: '1',
  content: 'lorem',
  senderAcsId,
  senderDisplayName: null,
  ourSenderUserId,
  createdOn: '2026-01-01T00:00:00Z',
  editedOn: null,
  deletedOn: null,
  metadata: null,
});

async function* recs(items: Rec[]): AsyncIterable<Rec> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<Rec>): Promise<Rec[]> {
  const out: Rec[] = [];
  for await (const r of stream) out.push(r);
  return out;
}

describe('buildIdentityMap', () => {
  it('maps an ACS id to the user who owns it', () => {
    const { map } = buildIdentityMap([{ ourUserId: U1, acsId: acs('a') }]);
    expect(map.get(acs('a'))).toBe(U1);
  });

  it('ignores users with no ACS id', () => {
    const { map } = buildIdentityMap([
      { ourUserId: U1, acsId: null },
      { ourUserId: U2, acsId: '   ' },
    ]);
    expect(map.size).toBe(0);
  });

  // Two people sharing an ACS id is a defect in the host data. Picking one
  // silently attributes somebody's messages to somebody else, which is the
  // exact failure this whole tool exists because of.
  it('refuses to pick a winner when two users share an ACS id', () => {
    const { map, duplicates } = buildIdentityMap([
      { ourUserId: U1, acsId: acs('shared') },
      { ourUserId: U2, acsId: acs('shared') },
    ]);
    expect(duplicates).toEqual([acs('shared')]);
    expect(map.get(acs('shared'))).toBe(U1);
    expect(coverageLines({ resolved: 0, unresolved: [], alreadyMapped: 0 }, duplicates).join('\n')).toMatch(
      /appear on more than one user/,
    );
  });

  it('does not call the same user twice a duplicate', () => {
    const { duplicates } = buildIdentityMap([
      { ourUserId: U1, acsId: acs('a') },
      { ourUserId: U1, acsId: acs('a') },
    ]);
    expect(duplicates).toEqual([]);
  });
});

describe('measureCoverage', () => {
  it('separates the ids it can account for from the ones it cannot', async () => {
    const { map } = buildIdentityMap([{ ourUserId: U1, acsId: acs('known') }]);
    const cov = await measureCoverage(
      recs([participant('known'), participant('stranger'), message(acs('stranger'))]),
      map,
    );
    expect(cov.resolved).toBe(1);
    expect(cov.unresolved).toEqual([acs('stranger')]);
  });

  // A control message has no sender to find. Counting it as a miss makes full
  // coverage unreachable, which trains people to pass --allow-unmapped every
  // time and turns the failsafe off permanently.
  it('does not count a message with no sender as unresolved', async () => {
    const cov = await measureCoverage(recs([message(null)]), new Map());
    expect(cov.unresolved).toEqual([]);
    expect(cov.resolved).toBe(0);
  });

  it('leaves records that already carry an id out of the count', async () => {
    const cov = await measureCoverage(
      recs([participant('a', U1), message(acs('b'), U2)]),
      new Map(),
    );
    expect(cov.alreadyMapped).toBe(2);
    expect(cov.unresolved).toEqual([]);
  });

  it('counts a repeated ACS id once', async () => {
    const cov = await measureCoverage(
      recs([participant('a'), participant('a'), message(acs('a'))]),
      new Map(),
    );
    expect(cov.unresolved).toEqual([acs('a')]);
  });
});

describe('remap', () => {
  it('fills in the ids the host table knows', async () => {
    const { map } = buildIdentityMap([{ ourUserId: U1, acsId: acs('a') }]);
    const out = await collect(remap(recs([participant('a'), message(acs('a'))]), map));

    expect(out[0]).toMatchObject({ kind: 'participant', ourUserId: U1 });
    expect(out[1]).toMatchObject({ kind: 'message', ourSenderUserId: U1 });
  });

  // A dump mapped once is authoritative. Overwriting would let a later, worse
  // users table quietly reattribute an estate that was already correct.
  it('never overwrites an id already on the record', async () => {
    const { map } = buildIdentityMap([{ ourUserId: U2, acsId: acs('a') }]);
    const out = await collect(remap(recs([participant('a', U1), message(acs('a'), U1)]), map));

    expect(out[0]).toMatchObject({ ourUserId: U1 });
    expect(out[1]).toMatchObject({ ourSenderUserId: U1 });
  });

  it('leaves an unknown ACS id alone rather than inventing one', async () => {
    const out = await collect(remap(recs([participant('stranger')]), new Map()));
    expect(out[0]).toMatchObject({ ourUserId: null });
  });

  it('passes thread records through untouched', async () => {
    const thread: Rec = {
      kind: 'thread',
      ourThreadId: null,
      legacyThreadId: '19:t@thread.v2',
      topic: 'lorem',
      createdOn: null,
      createdByAcsId: acs('a'),
      deletedOn: null,
      readerAcsId: acs('a'),
    };
    const out = await collect(remap(recs([thread]), new Map()));
    expect(out[0]).toEqual(thread);
  });
});
