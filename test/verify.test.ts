import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Rec } from '../src/mirror/types.ts';
import { ReplayLedger } from '../src/migrate/state.ts';

/** What the target resource holds, keyed by target thread id. */
type TargetThread = {
  participants: string[];
  messages: Array<{ type: string; metadata: Record<string, string> | null }>;
  readable: boolean;
  /**
   * Identities ACS will let read this thread.
   *
   * When set, the mock refuses anyone else, the way ACS does. The tests here
   * used to ignore who was asking entirely, which is how `verify` shipped
   * reading every thread as one identity that belonged to none of them.
   */
  readableBy?: string[];
};

/** Every identity chatFor() was asked for, so minting can be asserted against. */
const askedAs: string[] = [];
const createUser = vi.fn().mockResolvedValue({ communicationUserId: "8:acs:verifier" });
const target: Record<string, TargetThread> = {};

vi.mock('../src/acs/client.ts', () => ({
  createAcs: vi.fn().mockImplementation(() => ({
    identity: {
      createUser,
      deleteUser: vi.fn().mockResolvedValue(undefined),
    },
    endpoint: 'https://mock.communication.azure.com',
    chatFor: vi.fn().mockImplementation((reader: string) => {
      askedAs.push(reader);
      const allowed = (t: TargetThread | undefined): boolean =>
        !!t && t.readable && (!t.readableBy || t.readableBy.includes(reader));
      return Promise.resolve({
      getChatThreadClient: (threadId: string) => ({
        listParticipants: async function* () {
          const t = target[threadId];
          if (!allowed(t)) throw new Error('Forbidden');
          for (const p of t!.participants) yield { id: { communicationUserId: p } };
        },
        listMessages: async function* () {
          const t = target[threadId];
          if (!allowed(t)) throw new Error('Forbidden');
          for (const [i, m] of t!.messages.entries()) {
            yield {
              id: `${threadId}-m${i}`,
              type: m.type,
              // A body exists on the wire; verify must never retain it.
              content: { message: 'lorem ipsum' },
              sender: { communicationUserId: '8:acs:someone' },
              metadata: m.metadata,
            };
          }
        },
      }),
      });
    }),
  })),
}));

const { migrateVerify, formatVerify, verifyExitCode } = await import('../src/migrate/verify.ts');

async function* recs(items: Rec[]): AsyncIterable<Rec> {
  for (const item of items) yield item;
}

const goodMeta = { originalSenderUserId: 'u-1', originalCreatedOn: '2022-01-01T00:00:00.000Z' };

function source(threadId: string, participants: number, messages: number): Rec[] {
  const out: Rec[] = [
    {
      kind: 'thread',
      ourThreadId: null,
      legacyThreadId: threadId,
      topic: 'lorem',
      createdOn: '2022-01-01T00:00:00.000Z',
      createdByAcsId: null,
      deletedOn: null,
      readerAcsId: '8:acs:r',
    },
  ];
  for (let i = 0; i < participants; i++) {
    out.push({
      kind: 'participant',
      legacyThreadId: threadId,
      acsId: `8:acs:old_p${i}`,
      displayName: null,
      ourUserId: `u-${i}`,
    });
  }
  for (let i = 0; i < messages; i++) {
    out.push({
      kind: 'message',
      legacyThreadId: threadId,
      messageId: `m${i}`,
      type: 'text',
      sequenceId: String(i),
      content: 'lorem',
      senderAcsId: null,
      senderDisplayName: null,
      ourSenderUserId: 'u-1',
      createdOn: '2022-01-01T00:00:00.000Z',
      editedOn: null,
      deletedOn: null,
      metadata: null,
    });
  }
  return out;
}

/**
 * Map the participants `source()` creates, the way `apply` would have.
 *
 * A ledger from a real replay always carries these — they are the identities
 * it minted. Verify reads each thread as one of them, so a test ledger without
 * them is not a ledger any replay could produce.
 */
function withIdentities(ledger: ReplayLedger, n = 4): ReplayLedger {
  for (let i = 0; i < n; i++) ledger.recordIdentity(`u-${i}`, `8:acs:new_p${i}`);
  return ledger;
}

const run = (src: Rec[], ledger: ReplayLedger) =>
  migrateVerify({
    connectionString: 'endpoint=https://mock.communication.azure.com/;accesskey=mock',
    sourceStream: recs(src),
    ledger,
    concurrency: 2,
  });

beforeEach(() => {
  for (const k of Object.keys(target)) delete target[k];
});

describe('migrateVerify', () => {
  it('passes a replay that matches the source', async () => {
    target['tgt-1'] = {
      readable: true,
      participants: ['8:acs:a', '8:acs:b'],
      messages: [
        { type: 'text', metadata: goodMeta },
        { type: 'text', metadata: goodMeta },
      ],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 2, done: true });

    const report = await run(source('19:t', 2, 2), ledger);
    expect(report.findings).toEqual([]);
    expect(report.threadsClean).toBe(1);
    expect(verifyExitCode(report)).toBe(0);
    expect(formatVerify(report)).toContain('matches the source');
  });

  it('ignores the control messages ACS emits for itself', async () => {
    target['tgt-1'] = {
      readable: true,
      participants: ['8:acs:a'],
      messages: [
        { type: 'participantAdded', metadata: null },
        { type: 'topicUpdated', metadata: null },
        { type: 'text', metadata: goodMeta },
      ],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 1, done: true });
    const report = await run(source('19:t', 1, 1), ledger);
    expect(report.findings).toEqual([]);
  });

  it('catches messages that did not arrive', async () => {
    target['tgt-1'] = {
      readable: true,
      participants: ['8:acs:a'],
      messages: [{ type: 'text', metadata: goodMeta }],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 3, done: true });
    const report = await run(source('19:t', 1, 3), ledger);
    expect(report.counts['message-count']).toBe(1);
    expect(report.findings[0]?.summary).toContain('source has 3 message(s), target has 1');
    expect(verifyExitCode(report)).toBe(1);
  });

  it('catches a thread that was never replayed at all', async () => {
    const report = await run(source('19:missing', 1, 1), ReplayLedger.ephemeral());
    expect(report.counts['never-replayed']).toBe(1);
  });

  it('reports a thread the ledger never finished', async () => {
    target['tgt-1'] = {
      readable: true,
      participants: ['8:acs:a'],
      messages: [{ type: 'text', metadata: goodMeta }],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 1, done: false });
    const report = await run(source('19:t', 1, 1), ledger);
    expect(report.counts.incomplete).toBe(1);
    expect(report.threadsClean).toBe(0);
  });

  it('catches replayed messages whose author is unrecoverable', async () => {
    target['tgt-1'] = {
      readable: true,
      participants: ['8:acs:a'],
      messages: [
        { type: 'text', metadata: { originalCreatedOn: '2022-01-01T00:00:00.000Z' } },
        { type: 'text', metadata: goodMeta },
      ],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 2, done: true });
    const report = await run(source('19:t', 1, 2), ledger);
    expect(report.counts.unattributed).toBe(1);
    expect(report.findings.some((f) => f.summary.includes('no originalSenderUserId'))).toBe(true);
  });

  it('catches replayed messages that will show the replay date', async () => {
    target['tgt-1'] = {
      readable: true,
      participants: ['8:acs:a'],
      messages: [{ type: 'text', metadata: { originalSenderUserId: 'u-1' } }],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 1, done: true });
    const report = await run(source('19:t', 1, 1), ledger);
    expect(report.counts.untimed).toBe(1);
  });

  it('reports a thread it cannot read back rather than calling it clean', async () => {
    target['tgt-1'] = { readable: false, participants: [], messages: [] };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 1, done: true });
    const report = await run(source('19:t', 1, 1), ledger);
    expect(report.counts.unreadable).toBe(1);
    expect(report.threadsClean).toBe(0);
  });

  it('never carries a message body into the report', async () => {
    target['tgt-1'] = {
      readable: true,
      participants: ['8:acs:a'],
      messages: [{ type: 'text', metadata: null }],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 1, done: true });
    const report = await run(source('19:t', 1, 1), ledger);
    expect(JSON.stringify(report)).not.toContain('lorem ipsum');
  });
});

/**
 * Found by running the full loop against a real ACS resource for the first
 * time: plan, apply --commit, verify. The replay was perfect and verify said
 * "verified clean 0", every thread `unreadable`.
 *
 * Two causes, both about who is asking. ACS refuses a thread to an identity
 * that is not a participant, and verify was asking as (a) a freshly minted
 * identity that participates in nothing, or (b) one identity for the whole
 * estate, which cannot be in every thread. The tests above never caught it
 * because the mock ignored the reader entirely.
 */
describe('verify reads each thread as somebody who is in it', () => {
  it('uses the identities the ledger minted, with no reader passed in', async () => {
    target['tgt-1'] = {
      readable: true,
      readableBy: ['8:acs:new_p0', '8:acs:new_p1'],
      participants: ['8:acs:new_p0', '8:acs:new_p1'],
      messages: [{ type: 'text', metadata: goodMeta }],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t1@thread.v2', { target: 'tgt-1', messages: 1, done: true });

    const report = await run(source('19:t1@thread.v2', 2, 1), ledger);
    expect(report.findings).toEqual([]);
    expect(report.threadsClean).toBe(1);
  });

  /**
   * The case that survived the first fix. Reading everything as one identity
   * verifies only the threads that identity happens to be in — here, the second
   * thread has an entirely different membership.
   */
  it('picks a different reader per thread when membership differs', async () => {
    target['tgt-1'] = {
      readable: true,
      readableBy: ['8:acs:new_p0'],
      participants: ['8:acs:new_p0'],
      messages: [],
    };
    target['tgt-2'] = {
      readable: true,
      readableBy: ['8:acs:new_p3'],
      participants: ['8:acs:new_p3'],
      messages: [],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:a@thread.v2', { target: 'tgt-1', messages: 0, done: true });
    ledger.recordThread('19:b@thread.v2', { target: 'tgt-2', messages: 0, done: true });

    const src = [
      ...source('19:a@thread.v2', 1, 0),
      ...source('19:b@thread.v2', 1, 0).map((r) =>
        r.kind === 'participant' ? { ...r, ourUserId: 'u-3' } : r,
      ),
    ];

    const report = await run(src, ledger);
    expect(report.findings).toEqual([]);
    expect(report.threadsClean).toBe(2);
  });

  /**
   * apply keys the ledger on our user id where there is one and the source ACS
   * id otherwise. Verify has to use the same rule or it finds nobody — the first
   * attempt at this fix keyed on the ACS id alone and still reported 0 clean.
   */
  it('keys on the source ACS id when a participant has no user id', async () => {
    target['tgt-1'] = {
      readable: true,
      readableBy: ['8:acs:new_anon'],
      participants: ['8:acs:new_anon'],
      messages: [],
    };
    const ledger = ReplayLedger.ephemeral();
    ledger.recordIdentity('8:acs:old_p0', '8:acs:new_anon');
    ledger.recordThread('19:t1@thread.v2', { target: 'tgt-1', messages: 0, done: true });

    const src = source('19:t1@thread.v2', 1, 0).map((r) =>
      r.kind === 'participant' ? { ...r, ourUserId: null } : r,
    );

    const report = await run(src, ledger);
    expect(report.findings).toEqual([]);
  });

  it('says so when no identity in the ledger is in the thread', async () => {
    target['tgt-1'] = {
      readable: true,
      readableBy: ['8:acs:somebody-else'],
      participants: ['8:acs:somebody-else'],
      messages: [],
    };
    const ledger = ReplayLedger.ephemeral();
    ledger.recordThread('19:t1@thread.v2', { target: 'tgt-1', messages: 0, done: true });

    const report = await run(source('19:t1@thread.v2', 1, 0), ledger);
    expect(report.findings[0]?.issue).toBe('unreadable');
    // A bare "Forbidden" sends people looking at the replay. The reason is who asked.
    expect(JSON.stringify(report.findings[0]?.detail)).toMatch(/no identity in the ledger/);
  });

  // A read-only command that creates an identity was always odd, and the one it
  // created could not read anything anyway.
  it('mints nothing', async () => {
    createUser.mockClear();
    target['tgt-1'] = {
      readable: true,
      readableBy: ['8:acs:new_p0'],
      participants: ['8:acs:new_p0'],
      messages: [],
    };
    const ledger = withIdentities(ReplayLedger.ephemeral());
    ledger.recordThread('19:t1@thread.v2', { target: 'tgt-1', messages: 0, done: true });

    await run(source('19:t1@thread.v2', 1, 0), ledger);
    expect(createUser).not.toHaveBeenCalled();
  });
});
