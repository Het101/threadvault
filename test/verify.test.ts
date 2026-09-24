import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Rec } from '../src/mirror/types.ts';
import { ReplayLedger } from '../src/migrate/state.ts';

/** What the target resource holds, keyed by target thread id. */
type TargetThread = {
  participants: string[];
  messages: Array<{ type: string; metadata: Record<string, string> | null }>;
  readable: boolean;
};
const target: Record<string, TargetThread> = {};

vi.mock('../src/acs/client.ts', () => ({
  createAcs: vi.fn().mockImplementation(() => ({
    identity: {
      createUser: vi.fn().mockResolvedValue({ communicationUserId: '8:acs:verifier' }),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    },
    endpoint: 'https://mock.communication.azure.com',
    chatFor: vi.fn().mockResolvedValue({
      getChatThreadClient: (threadId: string) => ({
        listParticipants: async function* () {
          const t = target[threadId];
          if (!t || !t.readable) throw new Error('Forbidden');
          for (const p of t.participants) yield { id: { communicationUserId: p } };
        },
        listMessages: async function* () {
          const t = target[threadId];
          if (!t || !t.readable) throw new Error('Forbidden');
          for (const [i, m] of t.messages.entries()) {
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
    const ledger = ReplayLedger.ephemeral();
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
    const ledger = ReplayLedger.ephemeral();
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
    const ledger = ReplayLedger.ephemeral();
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
    const ledger = ReplayLedger.ephemeral();
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
    const ledger = ReplayLedger.ephemeral();
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
    const ledger = ReplayLedger.ephemeral();
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 1, done: true });
    const report = await run(source('19:t', 1, 1), ledger);
    expect(report.counts.untimed).toBe(1);
  });

  it('reports a thread it cannot read back rather than calling it clean', async () => {
    target['tgt-1'] = { readable: false, participants: [], messages: [] };
    const ledger = ReplayLedger.ephemeral();
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
    const ledger = ReplayLedger.ephemeral();
    ledger.recordThread('19:t', { target: 'tgt-1', messages: 1, done: true });
    const report = await run(source('19:t', 1, 1), ledger);
    expect(JSON.stringify(report)).not.toContain('lorem ipsum');
  });
});
