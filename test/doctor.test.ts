import { describe, expect, it } from 'vitest';
import { runChecks, type DoctorInputs } from '../src/doctor/checks.ts';
import { buildReport, exitCode, formatReport } from '../src/doctor/report.ts';

const RESOURCE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';
const sysAcs = `8:acs:${RESOURCE}_aaaaaaaa-0000-0000-0000-000000000001`;
const userAcs = `8:acs:${RESOURCE}_bbbbbbbb-0000-0000-0000-000000000002`;
const staleAcs = `8:acs:${OTHER}_cccccccc-0000-0000-0000-000000000003`;
const USER = '00000000-0000-0000-0000-000000000010';
const SYS = '00000000-0000-0000-0000-000000000099';
const THREAD = '19:abc@thread.v2';

function base(over: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    resourceGuid: RESOURCE,
    users: [
      { ourUserId: SYS, acsId: sysAcs, isSystem: true },
      { ourUserId: USER, acsId: userAcs, isSystem: false },
    ],
    threads: [{ ourThreadId: 't-db', externalId: THREAD }],
    acsParticipants: new Map([[THREAD, [sysAcs, userAcs]]]),
    acsMessages: [],
    acsThreadIds: new Set([THREAD]),
    acsScanned: true,
    ...over,
  };
}

describe('runChecks', () => {
  it('is clean on a healthy estate', () => {
    expect(runChecks(base())).toEqual([]);
  });

  it('1: flags identities minted by another resource', () => {
    const findings = runChecks(
      base({
        users: [
          { ourUserId: SYS, acsId: sysAcs, isSystem: true },
          { ourUserId: USER, acsId: staleAcs, isSystem: false },
        ],
      }),
    );
    expect(findings.filter((f) => f.check === 1)).toHaveLength(1);
    expect(findings[0]?.id).toBe(USER);
    expect(findings[0]?.detail).not.toHaveProperty('content');
  });

  it('2: flags threads whose only participant is the system identity', () => {
    const findings = runChecks(
      base({
        acsParticipants: new Map([[THREAD, [sysAcs]]]),
      }),
    );
    expect(findings.some((f) => f.check === 2 && f.id === THREAD)).toBe(true);
  });

  it('3: flags messages sent as system whose metadata names a real user', () => {
    const findings = runChecks(
      base({
        acsMessages: [
          {
            threadId: THREAD,
            messageId: 'msg-1',
            senderAcsId: sysAcs,
            metadata: { originalSenderUserId: USER, originalCreatedOn: '2024-01-01T00:00:00.000Z' },
          },
        ],
      }),
    );
    expect(findings.some((f) => f.check === 3 && f.id === 'msg-1')).toBe(true);
    expect(JSON.stringify(findings)).not.toMatch(/content/);
  });

  it('3: does not flag a system message with no originalSenderUserId', () => {
    const findings = runChecks(
      base({
        acsMessages: [
          { threadId: THREAD, messageId: 'sys-event', senderAcsId: sysAcs, metadata: { replayed: 'true' } },
        ],
      }),
    );
    expect(findings.filter((f) => f.check === 3)).toHaveLength(0);
  });

  it('4: flags a missing system user and a system user with a stale identity', () => {
    expect(runChecks(base({ users: [{ ourUserId: USER, acsId: userAcs, isSystem: false }] })).some((f) => f.check === 4)).toBe(
      true,
    );
    expect(
      runChecks(
        base({
          users: [
            { ourUserId: SYS, acsId: staleAcs, isSystem: true },
            { ourUserId: USER, acsId: userAcs, isSystem: false },
          ],
        }),
      ).some((f) => f.check === 4),
    ).toBe(true);
  });

  it('5: flags ACS-only threads, db-only threads, and null externalId', () => {
    const findings = runChecks(
      base({
        threads: [
          { ourThreadId: 't-db', externalId: THREAD },
          { ourThreadId: 't-orphan', externalId: '19:gone@thread.v2' },
          { ourThreadId: 't-null', externalId: null },
        ],
        acsThreadIds: new Set([THREAD, '19:only-on-acs@thread.v2']),
      }),
    );
    const five = findings.filter((f) => f.check === 5);
    expect(five.map((f) => f.id).sort()).toEqual(['19:only-on-acs@thread.v2', 't-null', 't-orphan'].sort());
  });

  it('5: does not treat an empty ACS set as split-brain when ACS was not scanned', () => {
    const findings = runChecks(
      base({
        acsScanned: false,
        acsThreadIds: new Set(),
        acsParticipants: new Map(),
      }),
    );
    expect(findings.filter((f) => f.check === 5)).toHaveLength(0);
  });
});

describe('report', () => {
  it('formats a clean report and maps findings to exit 1', () => {
    const clean = buildReport(RESOURCE, 'example.communication.azure.com', []);
    expect(formatReport(clean)).toMatch(/clean/);
    expect(exitCode(clean, false)).toBe(0);
    const dirty = buildReport(RESOURCE, 'example.communication.azure.com', [
      { check: 1, id: USER, summary: 'stale' },
    ]);
    expect(exitCode(dirty, false)).toBe(1);
    expect(exitCode(null, true)).toBe(2);
  });
});
