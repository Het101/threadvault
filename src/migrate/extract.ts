import { extractAcs } from '../mirror/extract.ts';
import { sinkJsonl } from '../mirror/sink-jsonl.ts';
import { log } from '../log.ts';
import { parseRec, type Rec } from '../mirror/types.ts';

export type ExtractOpts = {
  connectionString: string;
  readerAcsId: string;
  outPath: string;
  threadIds?: string[];
  /** Threads walked at once. Messages inside a thread always stay serial. */
  concurrency?: number;
  /** Write no message bodies. See ExtractOpts in mirror/extract.ts. */
  withoutBodies?: boolean;
};

/**
 * Walk ACS and write a JSONL extract. Read-only against ACS.
 * Field names stay byte-compatible with existing production dumps.
 */
export async function migrateExtract(opts: ExtractOpts): Promise<{
  threads: number;
  participants: number;
  messages: number;
}> {
  const stream = extractAcs({
    connectionString: opts.connectionString,
    readerAcsId: opts.readerAcsId,
    threadIds: opts.threadIds,
    concurrency: opts.concurrency,
    withoutBodies: opts.withoutBodies,
  });

  let threads = 0;
  let participants = 0;
  let messages = 0;

  async function* counted(): AsyncGenerator<Rec> {
    for await (const rec of stream) {
      if (rec.kind === 'thread') threads++;
      else if (rec.kind === 'participant') participants++;
      else if (rec.kind === 'message') messages++;
      yield rec;
    }
  }

  await sinkJsonl(counted(), opts.outPath);
  const bodyNote = opts.withoutBodies
    ? ' No message bodies were read: this dump is for plan and verify, and apply will refuse it.'
    : '';
  log(
    `Extract complete. Threads: ${threads}, Participants: ${participants}, ` +
      `Messages: ${messages}.${bodyNote}`,
  );
  return { threads, participants, messages };
}

export { parseRec };
