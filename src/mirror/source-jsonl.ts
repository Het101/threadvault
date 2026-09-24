import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { logError } from '../log.ts';
import { parseRec, type Rec } from './types.ts';

/**
 * Stream a JSONL extract. A malformed line is reported by line number and
 * skipped — one bad byte must not abort a multi-hour replay, and the line
 * number must never be a line body (PHI).
 */
export async function* sourceJsonlFile(path: string): AsyncIterable<Rec> {
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let skipped = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      const rec = parseRec(line);
      if (!rec) {
        skipped++;
        logError(`${path}: skipping unparseable line ${lineNo}`);
        continue;
      }
      yield rec;
    }
  } catch (e) {
    // A mistyped path is the most likely first-run mistake. Saying so beats
    // surfacing Node's raw ENOENT with an absolute path in it.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`extract not found: ${path}`, { cause: e });
    if (code === 'EISDIR') throw new Error(`not a file: ${path}`, { cause: e });
    throw e;
  }
  if (skipped) logError(`${path}: ${skipped} line(s) skipped — the replay is incomplete`);
}
