import { createAcs } from '../acs/client.ts';
import { poolMap } from '../acs/pool.ts';
import { listMessageMetaWithType, listParticipantIds } from '../acs/read.ts';
import { withRetry } from '../acs/retry.ts';
import { isReplayable, type Rec } from '../mirror/types.ts';
import type { ReplayLedger } from './state.ts';

export type VerifyIssue =
  | 'never-replayed'
  | 'incomplete'
  | 'unreadable'
  | 'message-count'
  | 'participant-count'
  | 'unattributed'
  | 'untimed';

export type VerifyFinding = {
  issue: VerifyIssue;
  legacyThreadId: string;
  targetThreadId?: string;
  summary: string;
  detail?: Record<string, unknown>;
};

export type VerifyReport = {
  threadsChecked: number;
  threadsClean: number;
  findings: VerifyFinding[];
  counts: Record<VerifyIssue, number>;
};

export const VERIFY_ISSUES: Record<VerifyIssue, string> = {
  'never-replayed': 'Source thread has no entry in the ledger — it was never replayed.',
  incomplete: 'The ledger says this thread never finished.',
  unreadable: 'The replayed thread could not be read back.',
  'message-count': 'The replayed thread holds a different number of messages than the source.',
  'participant-count': 'The replayed thread holds a different number of participants.',
  unattributed: 'Replayed messages carry no originalSenderUserId — the author is unrecoverable.',
  untimed: 'Replayed messages carry no originalCreatedOn — they will show the replay date.',
};

type Expected = {
  participants: number;
  messages: number;
  /**
   * How the ledger keys this thread’s participants.
   *
   * ACS only lets an identity read a thread it belongs to, so verifying a
   * replayed thread means reading it as somebody who is in it. The ledger keys
   * on our own user id where there is one and the source ACS id otherwise —
   * the same rule `apply` used when it minted them. Keying on the ACS id alone
   * misses every participant the source could name properly.
   */
  participantKeys: string[];
};

/** Fold the source into per-thread expectations. Bodies are never retained. */
export async function expectationsFrom(
  stream: AsyncIterable<Rec>,
): Promise<Map<string, Expected>> {
  const expected = new Map<string, Expected>();
  const bump = (id: string): Expected => {
    let e = expected.get(id);
    if (!e) {
      e = { participants: 0, messages: 0, participantKeys: [] };
      expected.set(id, e);
    }
    return e;
  };
  for await (const rec of stream) {
    if (rec.kind === 'thread') bump(rec.legacyThreadId);
    else if (rec.kind === 'participant') {
      const e = bump(rec.legacyThreadId);
      e.participants++;
      // identityKey() in apply.ts, mirrored.
      const key = rec.ourUserId?.trim() || rec.acsId;
      if (key) e.participantKeys.push(key);
    }
    else if (rec.kind === 'message' && isReplayable(rec)) bump(rec.legacyThreadId).messages++;
  }
  return expected;
}

export type VerifyOpts = {
  connectionString: string;
  sourceStream: AsyncIterable<Rec>;
  ledger: ReplayLedger;
  /** Identity to read the target as. Defaults to a freshly minted one. */
  readerAcsId?: string;
  concurrency?: number;
};

/**
 * Read a replayed estate back and prove it matches the source.
 *
 * Nothing else in the pipeline answers "did the replay actually work?".
 * `apply` reports what it sent; this reports what arrived, which is the only
 * number worth trusting after a migration.
 *
 * Read-only, and never reads a message body: every check runs on counts and
 * metadata.
 */
export async function migrateVerify(opts: VerifyOpts): Promise<VerifyReport> {
  const expected = await expectationsFrom(opts.sourceStream);
  const acs = createAcs(opts.connectionString);

  /**
   * Who can read a given replayed thread.
   *
   * Not one reader for the whole estate: ACS refuses a thread to an identity
   * that is not a participant, so a single reader can only verify the threads
   * it happens to be in. This used to mint a fresh identity when none was
   * given, which participates in nothing at all - so every thread came back
   * `unreadable` and the report said "verified clean 0" however good the
   * replay was.
   *
   * The ledger maps each source participant to the identity the replay minted
   * for them, and those identities were added to the thread. They are the
   * readers.
   */
  function readersFor(legacyId: string): string[] {
    const out: string[] = [];
    if (opts.readerAcsId) out.push(opts.readerAcsId);
    for (const key of expected.get(legacyId)?.participantKeys ?? []) {
      const mapped = opts.ledger.identities.get(key);
      if (mapped && !out.includes(mapped)) out.push(mapped);
    }
    return out;
  }

  const findings: VerifyFinding[] = [];
  const counts = {
    'never-replayed': 0,
    incomplete: 0,
    unreadable: 0,
    'message-count': 0,
    'participant-count': 0,
    unattributed: 0,
    untimed: 0,
  } as Record<VerifyIssue, number>;
  const add = (f: VerifyFinding): void => {
    findings.push(f);
    counts[f.issue]++;
  };

  const legacyIds = [...expected.keys()];
  const checkable: string[] = [];

  for (const legacyId of legacyIds) {
    const progress = opts.ledger.threads.get(legacyId);
    if (!progress) {
      add({
        issue: 'never-replayed',
        legacyThreadId: legacyId,
        summary: `thread ${legacyId} is in the source but not in the ledger`,
      });
      continue;
    }
    if (!progress.done) {
      add({
        issue: 'incomplete',
        legacyThreadId: legacyId,
        targetThreadId: progress.target,
        summary: `thread ${legacyId} stopped after ${progress.messages} message(s)`,
        detail: { delivered: progress.messages, expected: expected.get(legacyId)?.messages },
      });
    }
    checkable.push(legacyId);
  }

  let clean = 0;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  try {
    for await (const result of poolMap(checkable, concurrency, async (legacyId) => {
      const progress = opts.ledger.threads.get(legacyId)!;
      const want = expected.get(legacyId)!;
      const readers = readersFor(legacyId);
      let lastError = readers.length
        ? ''
        : 'no identity in the ledger participates in this thread';

      // First reader that can open it wins. A Forbidden here is not a finding
      // about the replay, only about who asked.
      for (const reader of readers) {
        try {
          const chat = await acs.chatFor(reader);
          const tc = chat.getChatThreadClient(progress.target);
          const participants = await withRetry(`verifyParticipants ${progress.target}`, () =>
            listParticipantIds(tc),
          );
          const messages = await withRetry(`verifyMessages ${progress.target}`, () =>
            listMessageMetaWithType(tc, progress.target),
          );
          return { legacyId, progress, want, participants, messages, error: null as string | null };
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }

      {
        const e = new Error(lastError);
        return {
          legacyId,
          progress,
          want,
          participants: [] as string[],
          messages: [] as Awaited<ReturnType<typeof listMessageMetaWithType>>,
          error: e.message,
        };
      }
    })) {
      const { legacyId, progress, want, participants, messages, error } = result;
      if (error) {
        add({
          issue: 'unreadable',
          legacyThreadId: legacyId,
          targetThreadId: progress.target,
          summary: `replayed thread ${progress.target} could not be read back`,
          detail: { error },
        });
        continue;
      }

      let threadClean = true;

      // Only messages we put there count. ACS emits its own control messages
      // when participants are added, and those are not replay failures.
      const replayed = messages.filter((m) => m.type === 'text' || m.type === 'html');
      if (replayed.length !== want.messages) {
        threadClean = false;
        add({
          issue: 'message-count',
          legacyThreadId: legacyId,
          targetThreadId: progress.target,
          summary: `thread ${legacyId}: source has ${want.messages} message(s), target has ${replayed.length}`,
          detail: { source: want.messages, target: replayed.length },
        });
      }

      // The migrator identity creates the thread, so it is a participant too.
      if (participants.length < want.participants) {
        threadClean = false;
        add({
          issue: 'participant-count',
          legacyThreadId: legacyId,
          targetThreadId: progress.target,
          summary: `thread ${legacyId}: source has ${want.participants} participant(s), target has ${participants.length}`,
          detail: { source: want.participants, target: participants.length },
        });
      }

      const unattributed = replayed.filter((m) => !m.metadata?.originalSenderUserId).length;
      if (unattributed > 0) {
        threadClean = false;
        add({
          issue: 'unattributed',
          legacyThreadId: legacyId,
          targetThreadId: progress.target,
          summary: `thread ${legacyId}: ${unattributed} replayed message(s) have no originalSenderUserId`,
          detail: { count: unattributed },
        });
      }

      const untimed = replayed.filter((m) => !m.metadata?.originalCreatedOn).length;
      if (untimed > 0) {
        threadClean = false;
        add({
          issue: 'untimed',
          legacyThreadId: legacyId,
          targetThreadId: progress.target,
          summary: `thread ${legacyId}: ${untimed} replayed message(s) have no originalCreatedOn`,
          detail: { count: untimed },
        });
      }

      if (threadClean && progress.done) clean++;
    }
  } finally {
    // Nothing is minted here any more, so there is nothing to clean up. A
    // read-only command that created an identity was always odd.
  }

  return {
    threadsChecked: legacyIds.length,
    threadsClean: clean,
    findings,
    counts,
  };
}

export function formatVerify(report: VerifyReport): string {
  const lines = ['threadvault migrate verify', ''];
  lines.push(`  threads in source   ${report.threadsChecked}`);
  lines.push(`  verified clean      ${report.threadsClean}`);
  lines.push('');
  for (const issue of Object.keys(VERIFY_ISSUES) as VerifyIssue[]) {
    const n = report.counts[issue];
    lines.push(`  ${issue.padEnd(20)} ${n === 0 ? 'ok' : n}`);
  }
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('  the replayed estate matches the source.');
    return lines.join('\n');
  }
  for (const f of report.findings.slice(0, 40)) lines.push(`  - (${f.issue}) ${f.summary}`);
  if (report.findings.length > 40) {
    lines.push(`  … ${report.findings.length - 40} more (pass --json for the full list)`);
  }
  return lines.join('\n');
}

/** 0 the replay matches, 1 it does not. */
export function verifyExitCode(report: VerifyReport): number {
  return report.findings.length === 0 ? 0 : 1;
}
