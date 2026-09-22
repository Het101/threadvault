import { createAcs } from '../acs/client.ts';
import { resolveOriginalSenderUserId } from '../acs/identity.ts';
import { withRetry } from '../acs/retry.ts';
import { log } from '../log.ts';
import type { Rec } from '../mirror/types.ts';
import type { PgClient } from '../db/pg.ts';

export type ApplyOpts = {
  connectionString: string;
  sourceStream: AsyncIterable<Rec>;
  db?: PgClient; // optional if they provide an identity map in memory, but we need it for real runs
  targetResourceGuid: string;
};

// Simplified apply logic for proof-of-concept / V0.1
export async function migrateApply(opts: ApplyOpts) {
  const acs = createAcs(opts.connectionString);
  const targetIdCache = new Map<string, string>(); // legacy thread id -> target thread id

  // Not implemented fully yet, just a stub
  for await (const rec of opts.sourceStream) {
    if (rec.kind === 'thread') {
      log(`Replaying thread ${rec.legacyThreadId}`);
      // would call acs.chatFor(systemIdentity)...
    }
    // and participants, and messages
  }
}
