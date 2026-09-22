import { extractAcs } from './extract.ts';
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
  threadIds?: string[];
};

export async function mirrorBackfill(opts: MirrorOpts): Promise<{ threads: number; participants: number; messages: number } | void> {
  let stream: AsyncIterable<Rec>;

  if (opts.fromJsonl) {
    stream = sourceJsonlFile(opts.fromJsonl);
  } else {
    if (!opts.connectionString || !opts.readerAcsId) {
      throw new Error('ACS connection string and readerAcsId are required for backfill (unless --from-jsonl is used).');
    }
    stream = extractAcs({
      connectionString: opts.connectionString,
      readerAcsId: opts.readerAcsId,
      threadIds: opts.threadIds,
    });
  }

  if (!opts.db && !opts.jsonlPath) {
    throw new Error('Either db or jsonlPath must be provided to sink the extracted data.');
  }

  if (opts.db && opts.jsonlPath) {
    throw new Error('Backfilling to both DB and JSONL simultaneously is not implemented.');
  }

  if (opts.db) {
    return await sinkPostgres(stream, opts.db);
  } else if (opts.jsonlPath) {
    await sinkJsonl(stream, opts.jsonlPath);
  }
}
