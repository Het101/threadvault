import { extractAcs } from './extract.ts';
import { extractTwilio } from '../twilio/extract.ts';
import type { TwilioAuth } from '../twilio/client.ts';
import { sinkPostgres } from './sink-postgres.ts';
import { sinkJsonl } from './sink-jsonl.ts';
import { sourceJsonlFile } from './source-jsonl.ts';
import type { PgClient } from '../db/pg.ts';
import type { Rec } from './types.ts';

export type MirrorOpts = {
  connectionString?: string;
  readerAcsId?: string;
  db?: PgClient;
  jsonlPath?: string;
  fromJsonl?: string;
  /**
   * Read Twilio Conversations instead of ACS.
   *
   * The mirror is the part of this tool that is not about Azure at all: it
   * puts the estate somewhere you own so the vendor becomes disposable. That
   * argument holds for any chat provider, so the source is swappable and the
   * rest of the pipeline is untouched.
   */
  twilio?: TwilioAuth;
  threadIds?: string[];
  /** Threads walked at once. Messages inside a thread always stay serial. */
  concurrency?: number;
};

export type MirrorStats = {
  threads: number;
  participants: number;
  messages: number;
  /** Rows written to threadvault_identities. Zero on a dry run or a JSONL sink. */
  identities: number;
};

export async function mirrorBackfill(opts: MirrorOpts): Promise<MirrorStats | void> {
  let stream: AsyncIterable<Rec>;

  if (opts.fromJsonl) {
    stream = sourceJsonlFile(opts.fromJsonl);
  } else if (opts.twilio) {
    stream = extractTwilio({
      auth: opts.twilio,
      conversationSids: opts.threadIds,
      concurrency: opts.concurrency,
    });
  } else {
    if (!opts.connectionString || !opts.readerAcsId) {
      throw new Error('ACS connection string and readerAcsId are required for backfill (unless --from-jsonl is used).');
    }
    stream = extractAcs({
      connectionString: opts.connectionString,
      readerAcsId: opts.readerAcsId,
      threadIds: opts.threadIds,
      concurrency: opts.concurrency,
    });
  }

  if (opts.db && opts.jsonlPath) {
    throw new Error('Backfilling to both DB and JSONL simultaneously is not implemented.');
  }

  // No sink is the dry run: walk the whole source and count. It must not open a
  // read-only connection and then attempt INSERTs, which is what it used to do.
  if (!opts.db && !opts.jsonlPath) {
    const stats: MirrorStats = { threads: 0, participants: 0, messages: 0, identities: 0 };
    for await (const rec of stream) {
      if (rec.kind === 'thread') stats.threads++;
      else if (rec.kind === 'participant') stats.participants++;
      else stats.messages++;
    }
    return stats;
  }

  if (opts.db) {
    return await sinkPostgres(stream, opts.db);
  } else if (opts.jsonlPath) {
    await sinkJsonl(stream, opts.jsonlPath);
  }
}
