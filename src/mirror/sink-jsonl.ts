import { appendFile } from 'node:fs/promises';
import { redactPhi } from '../log.ts';
import type { Rec } from './types.ts';

/**
 * Saves a stream of records to a JSONL file, appending to it.
 * This does not redact PHI from the file itself since the file IS the backup,
 * but be careful with the output path.
 */
export async function sinkJsonl(
  stream: AsyncIterable<Rec>,
  path: string,
): Promise<void> {
  for await (const rec of stream) {
    await appendFile(path, JSON.stringify(rec) + '\n', 'utf8');
  }
}
