import { describe, expect, it } from 'vitest';
import { runChecks, type Finding, type FindingKind } from '../src/doctor/checks.ts';
import { REMEDIES, adviceFor } from '../src/doctor/remedy.ts';
import { buildReport, formatReport } from '../src/doctor/report.ts';

const RESOURCE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const scope = {
  readerAcsId: `8:acs:${RESOURCE}_sys`,
  acsThreads: 34,
  acsMessages: 168,
  identities: 167,
  dbThreads: 32,
  unreadable: 0,
};

const finding = (kind: FindingKind, check: Finding['check'], id: string): Finding => ({
  check,
  kind,
  id,
  summary: `${kind} ${id}`,
});

describe('every finding can be acted on', () => {
  /**
   * The guard that matters. A check added later without guidance would print a
   * problem and no answer, which is the state this whole file exists to end.
   */
  it('has a remedy for every kind of finding the checks can raise', () => {
    const raised = new Set<FindingKind>();

    // Every branch of runChecks, driven to produce its finding.
    raised.add(
      runChecks({
        resourceGuid: RESOURCE,
        users: [{ ourUserId: 'u-1', acsId: `8:acs:${OTHER}_x`, isSystem: false }],
        threads: [],
        acsParticipants: new Map(),
        acsMessages: [],
        acsThreadIds: new Set(),
        acsScanned: true,
      })[0]!.kind,
    );

    raised.add(
      runChecks({
        resourceGuid: RESOURCE,
        users: [],
        threads: [],
        acsParticipants: new Map(),
        acsMessages: [],
        acsThreadIds: new Set(),
        acsScanned: true,
      })[0]!.kind,
    );

    raised.add(
      runChecks({
        resourceGuid: RESOURCE,
        users: [{ ourUserId: 'sys', acsId: `8:acs:${OTHER}_s`, isSystem: true }],
        threads: [],
        acsParticipants: new Map(),
        acsMessages: [],
        acsThreadIds: new Set(),
        acsScanned: true,
      })
        .map((f) => f.kind)
        .find((k) => k === 'system-user-has-no-identity')!,
    );

    const withSystem = { ourUserId: 'sys', acsId: `8:acs:${RESOURCE}_s`, isSystem: true };

    for (const f of runChecks({
      resourceGuid: RESOURCE,
      users: [withSystem],
      threads: [],
      acsParticipants: new Map([['19:t@thread.v2', [`8:acs:${RESOURCE}_s`]]]),
      acsMessages: [
        {
          messageId: 'm-1',
          threadId: '19:t@thread.v2',
          senderAcsId: `8:acs:${RESOURCE}_s`,
          metadata: { originalSenderUserId: 'u-9' },
        },
      ],
      acsThreadIds: new Set(['19:t@thread.v2']),
      acsScanned: true,
    })) {
      raised.add(f.kind);
    }

    for (const f of runChecks({
      resourceGuid: RESOURCE,
      users: [withSystem],
      threads: [
        { ourThreadId: 't-1', externalId: null },
        { ourThreadId: 't-2', externalId: '19:gone@thread.v2' },
      ],
      acsParticipants: new Map(),
      acsMessages: [],
      acsThreadIds: new Set(['19:orphan@thread.v2']),
      acsScanned: true,
    })) {
      raised.add(f.kind);
    }

    // Everything the checks can produce is covered, and nothing is described
    // that cannot happen.
    expect([...raised].sort()).toEqual(Object.keys(REMEDIES).sort());
  });

  it('answers all three questions for every kind, in usable prose', () => {
    for (const [kind, r] of Object.entries(REMEDIES)) {
      expect(r.means.length, `${kind} means`).toBeGreaterThan(40);
      expect(r.action.length, `${kind} action`).toBeGreaterThan(40);
      expect(r.verify.length, `${kind} verify`).toBeGreaterThan(20);
    }
  });
});

describe('advice is grouped, not repeated', () => {
  it('prints one entry per kind however many findings there are', () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      finding('stale-identity', 1, `u-${i}`),
    );
    const advice = adviceFor(many);

    expect(advice).toHaveLength(1);
    expect(advice[0]?.count).toBe(600);
  });

  it('keeps kinds in check order so the advice matches the summary above it', () => {
    const advice = adviceFor([
      finding('acs-thread-not-in-db', 5, 't'),
      finding('stale-identity', 1, 'u'),
      finding('system-only-thread', 2, 't'),
    ]);
    expect(advice.map((a) => a.kind)).toEqual([
      'stale-identity',
      'system-only-thread',
      'acs-thread-not-in-db',
    ]);
  });

  it('says nothing at all when the run was clean', () => {
    const report = buildReport(RESOURCE, 'h', [], scope);
    expect(report.advice).toEqual([]);
    expect(formatReport(report)).not.toContain('What to do');
  });
});

describe('the rendered report', () => {
  const report = buildReport(
    RESOURCE,
    'h',
    [
      finding('system-only-thread', 2, 'a'),
      finding('system-only-thread', 2, 'b'),
      finding('acs-thread-not-in-db', 5, 'c'),
    ],
    scope,
  );

  it('carries the advice for a machine as well as for a person', () => {
    // --json consumers get the same guidance; it is not formatting-only.
    expect(report.advice.map((a) => [a.kind, a.count])).toEqual([
      ['system-only-thread', 2],
      ['acs-thread-not-in-db', 1],
    ]);
  });

  it('states means, action and verification for each', () => {
    const out = formatReport(report);
    expect(out).toContain('What to do');
    expect(out).toContain('system-only-thread  (2)');
    expect(out).toContain('acs-thread-not-in-db  (1)');
    expect(out.match(/means /g)).toHaveLength(2);
    expect(out.match(/do {4}/g)).toHaveLength(2);
    expect(out.match(/check /g)).toHaveLength(2);
  });

  it('wraps prose instead of emitting one unreadable line', () => {
    for (const line of formatReport(report).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
