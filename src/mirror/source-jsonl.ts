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
  if (skipped) logError(`${path}: ${skipped} line(s) skipped — the replay is incomplete`);
}
