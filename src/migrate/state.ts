import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { logError } from '../log.ts';

/**
 * How far a single thread got. `done` is only true once every message landed,
 * so an interrupted thread resumes from `messages` instead of being replayed
 * from the top into a duplicate.
 */
export type ThreadProgress = {
  target: string;
  messages: number;
  done: boolean;
};

type Entry =
  | { t: 'identity'; old: string; new: string }
  | { t: 'thread'; legacy: string; target: string; messages: number; done: boolean };

/**
 * The append-only record of what a replay has already done.
 *
 * It holds two things a replay cannot afford to lose:
 *
 *   identities  old ACS id -> identity on the target resource. The only link
 *               between a replayed thread and the people in it.
 *   threads     source thread -> target thread, and how many of its messages
 *               have landed.
 *
 * Append-only on purpose. Rewriting a whole JSON file after every thread is
 * O(n) per thread and O(n^2) over an estate; appending one line is flat, and a
 * truncated final line costs one record rather than the entire ledger.
 *
 * Writes go through a held file descriptor without fsync: a crashed process
 * still leaves its writes in the OS buffer, and paying a disk flush per message
 * would cost more than re-replaying the handful a machine crash could lose.
 */
export class ReplayLedger {
  readonly identities = new Map<string, string>();
  readonly threads = new Map<string, ThreadProgress>();
  private fd: number | null = null;

  /** In-memory only. Nothing is persisted; used when --state is not passed. */
  static ephemeral(): ReplayLedger {
    return new ReplayLedger();
  }

  static open(path: string): ReplayLedger {
    const ledger = new ReplayLedger();
    if (existsSync(path)) ledger.load(path);
    ledger.fd = openSync(path, 'a');
    return ledger;
  }

  private load(path: string): void {
    const lines = readFileSync(path, 'utf8').split('\n');
    let skipped = 0;
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        // A crash can truncate the final line. One lost record is recoverable;
        // refusing to read the rest of the ledger is not.
        skipped++;
        logError(`${path}: ignoring unreadable ledger line ${i + 1}`);
        continue;
      }
      if (entry?.t === 'identity' && entry.old && entry.new) {
        this.identities.set(entry.old, entry.new);
      } else if (entry?.t === 'thread' && entry.legacy && entry.target) {
        this.threads.set(entry.legacy, {
          target: entry.target,
          messages: Number(entry.messages) || 0,
          done: !!entry.done,
        });
      } else {
        skipped++;
      }
    }
    if (skipped) logError(`${path}: ${skipped} ledger line(s) ignored`);
  }

  private append(entry: Entry): void {
    if (this.fd === null) return;
    writeSync(this.fd, JSON.stringify(entry) + '\n');
  }

  recordIdentity(oldAcsId: string, newAcsId: string): void {
    this.identities.set(oldAcsId, newAcsId);
    this.append({ t: 'identity', old: oldAcsId, new: newAcsId });
  }

  recordThread(legacyThreadId: string, progress: ThreadProgress): void {
    this.threads.set(legacyThreadId, progress);
    this.append({ t: 'thread', legacy: legacyThreadId, ...progress });
  }

  /** Threads fully replayed already. Resuming must not touch these at all. */
  isDone(legacyThreadId: string): boolean {
    return this.threads.get(legacyThreadId)?.done === true;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
