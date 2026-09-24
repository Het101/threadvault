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
  log(`Extract complete. Threads: ${threads}, Participants: ${participants}, Messages: ${messages}`);
  return { threads, participants, messages };
}

export { parseRec };
