import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Rec } from './types.ts';

/**
 * Write a record stream to a JSONL file. The file IS the backup, so records
 * are written verbatim — mind the output path, it holds PHI.
 *
 * Truncates: appending to an existing dump silently doubles it, and a doubled
 * dump replays every message twice. One stream, not one appendFile per record —
 * an open/close syscall pair per message does not survive a real estate.
 */
export async function sinkJsonl(
  stream: AsyncIterable<Rec>,
  path: string,
): Promise<void> {
  const out = createWriteStream(path, { encoding: 'utf8', flags: 'w' });
  try {
    for await (const rec of stream) {
      if (!out.write(JSON.stringify(rec) + '\n')) await once(out, 'drain');
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
}
