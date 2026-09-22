import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Rec } from './types.ts';

export async function* sourceJsonlFile(path: string): AsyncIterable<Rec> {
  const fileStream = createReadStream(path, 'utf8');
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line) as Rec;
  }
}
