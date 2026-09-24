import 'dotenv/config';
import { Command } from 'commander';
import { acsConnectionString, acsExpectResource, loadConfig } from './config.ts';
import { probeResource } from './acs/client.ts';
import { isKnownGuid } from './acs/identity.ts';
import { connectReadOnly, connect, type PgClient } from './db/pg.ts';
import {
  loadHostThreads,
  loadHostUsers,
  loadMirrorThreads,
  loadMirrorUsers,
  runChecks,
  type DoctorInputs,
} from './doctor/checks.ts';
import { buildReport, exitCode, formatReport } from './doctor/report.ts';
import { scanAcs } from './doctor/scan.ts';
import { mirrorBackfill } from './mirror/backfill.ts';
import { migrateRehearse } from './migrate/rehearse.ts';
import { migrateApply } from './migrate/apply.ts';
import { migrateExtract } from './migrate/extract.ts';
import { migratePlan, logPlan } from './migrate/plan.ts';
import { sourceJsonlFile } from './mirror/source-jsonl.ts';
import { sourcePostgres } from './mirror/source-postgres.ts';
import type { Rec } from './mirror/types.ts';
import { applySchema } from './db/schema.ts';
import { readIdentityMap, writeIdentityMap } from './migrate/identity-map.ts';
import { log, logError, logJson } from './log.ts';

const program = new Command();

program
  .name('threadvault')
  .description('Mirror Azure Communication Services chat into Postgres so the ACS resource is disposable.')
  .version('0.1.0');

program
  .command('probe')
  .description('Mint a throwaway identity to learn the resource GUID. Prints host + GUID, never the key.')
  .action(async () => {
    const cs = acsConnectionString();
    if (!cs) {
      logError('ACS_CONNECTION_STRING (or ACS_NEW_CONNECTION_STRING) is not set');
      process.exit(2);
    }
    const r = await probeResource(cs);
    log(`${(r.host || '-').padEnd(68)}  ${(r.guid || '-').padEnd(38)}  ${r.error ? r.error : 'ok'}`);
    const expect = acsExpectResource();
    if (!expect) {
      log(`note: ACS_EXPECT_RESOURCE unset. Target resource GUID is ${r.guid ?? '?'}`);
      if (r.guid) log(`      export ACS_EXPECT_RESOURCE=${r.guid}`);
    } else if (r.guid && r.guid === expect) {
      log('ok: connection string matches ACS_EXPECT_RESOURCE');
    } else if (isKnownGuid(r.guid)) {
      logError(`WARNING: connection string is ${r.guid}, expected ${expect}`);
      process.exit(1);
    } else {
      logError('INCONCLUSIVE: could not read the resource GUID — fix the error above before trusting any of this');
      process.exit(2);
    }
  });

program
  .command('doctor')
  .description('Read-only audit. Finds stale identities, system-only threads, misattributed messages, missing system identity, split-brain threads.')
  .option('--json', 'print the report as JSON')
  .option('--config <path>', 'path to threadvault.yml')
  .option('--no-acs', 'skip the ACS walk (database checks only)')
  .option('--concurrency <n>', 'ACS listing concurrency', '4')
  .action(async (opts: { json?: boolean; config?: string; acs?: boolean; concurrency?: string }) => {
    const wantJson = !!opts.json;
    const walkAcs = opts.acs !== false;
    const concurrency = Math.max(1, Number(opts.concurrency ?? 4));
    try {
      const cfg = loadConfig(opts.config);
      const cs = acsConnectionString();
      const dbUrl = process.env.DATABASE_URL;

      let resourceGuid = acsExpectResource();
      let host = '(unknown)';
      if (walkAcs) {
        if (!cs) {
          logError('ACS_CONNECTION_STRING is not set (pass --no-acs to audit the database only)');
          process.exit(2);
        }
        const probe = await probeResource(cs);
        host = probe.host;
        if (!isKnownGuid(probe.guid)) {
          logError(`could not probe ACS: ${probe.error ?? 'unknown error'}`);
          process.exit(2);
        }
        if (resourceGuid && probe.guid !== resourceGuid) {
          logError(`ACS_EXPECT_RESOURCE is ${resourceGuid}, connection string is ${probe.guid}`);
          process.exit(2);
        }
        resourceGuid = probe.guid!;
      } else if (!resourceGuid) {
        logError('ACS_EXPECT_RESOURCE is required with --no-acs (the GUID to compare stored identities against)');
        process.exit(2);
      }

      let users: DoctorInputs['users'] = [];
      let threads: DoctorInputs['threads'] = [];
      if (dbUrl) {
        const db = await connectReadOnly(dbUrl);
        try {
          if (cfg.host) {
            users = await loadHostUsers(db, cfg.host);
            threads = await loadHostThreads(db, cfg.host);
          } else {
            users = await loadMirrorUsers(db, resourceGuid);
            threads = await loadMirrorThreads(db);
          }
        } finally {
          await db.end().catch(() => undefined);
        }
      } else if (!wantJson) {
        log('note: DATABASE_URL unset — doctor will only see what ACS lists, not host identities');
      }

      let acsParticipants: DoctorInputs['acsParticipants'] = new Map();
      let acsMessages: DoctorInputs['acsMessages'] = [];
      let acsThreadIds = new Set<string>();
      let acsScanned = false;
      if (walkAcs && cs) {
        const scan = await scanAcs({
          connectionString: cs,
          users,
          knownThreadIds: threads.map((t) => t.externalId).filter((id): id is string => !!id),
          resourceGuid,
          concurrency,
        });
        acsParticipants = scan.acsParticipants;
        acsMessages = scan.acsMessages;
        acsThreadIds = scan.acsThreadIds;
        acsScanned = true;
        if (!wantJson && scan.unreadable) {
          log(`  ${scan.unreadable} thread(s) unreadable with the chosen identity`);
        }
      }

      const findings = runChecks({
        resourceGuid,
        users,
        threads,
        acsParticipants,
        acsMessages,
        acsThreadIds,
        acsScanned,
      });
      const report = buildReport(resourceGuid, host, findings);
      if (wantJson) {
        logJson(report);
      } else {
        log(formatReport(report));
      }
      process.exit(exitCode(report, false));
    } catch (e) {
      logError(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  });

const mirror = program.command('mirror').description('ACS → Postgres. Makes the ACS resource disposable.');
mirror
  .command('backfill')
  .description('Walk ACS (or a JSONL extract) and upsert into threadvault_* tables.')
  .option('--from-jsonl <path>', 'read from a JSONL file instead of ACS')
  .option('--to-jsonl <path>', 'write to a JSONL file instead of Postgres')
  .option('--reader-acs-id <id>', 'the ACS identity to perform the ACS read as')
  .option('--commit', 'must be passed to write to Postgres (otherwise dry-run)')
  .action(async (opts: { fromJsonl?: string; toJsonl?: string; readerAcsId?: string; commit?: boolean }) => {
    try {
      const cs = acsConnectionString();
      const dbUrl = process.env.DATABASE_URL;

      let db: PgClient | undefined;
      if (!opts.toJsonl) {
        if (!opts.commit) {
          // Dry run counts the source and writes nothing. It must not open a
          // read-only connection and then try to INSERT through it.
          log('Dry run: counting the source only. Pass --commit to write to Postgres.');
        } else {
          if (!dbUrl) {
            logError('DATABASE_URL is not set and --to-jsonl is omitted.');
            process.exit(2);
          }
          db = await connect(dbUrl, false);
          await applySchema(db); // ensure tables exist before upserting
        }
      }

      log('Starting backfill...');
      const stats = await mirrorBackfill({
        connectionString: cs,
        readerAcsId: opts.readerAcsId,
        db,
        jsonlPath: opts.toJsonl,
        fromJsonl: opts.fromJsonl,
      });

      if (stats) {
        log(
          `Backfill ${opts.commit || opts.toJsonl ? 'complete' : 'dry run'}. ` +
            `Threads: ${stats.threads}, Participants: ${stats.participants}, Messages: ${stats.messages}`,
        );
      } else {
        log('Backfill complete.');
      }

      if (db) {
        await db.end().catch(() => undefined);
      }
    } catch (e) {
      logError(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  });

const migrate = program.command('migrate').description('Replay an estate into a new ACS resource.');

migrate
  .command('rehearse')
  .description('Write a synthetic thread to the target ACS resource and assert the four durability goals, then delete it.')
  .option('--system-acs-id <id>', 'system ACS identity')
  .option('--non-system-acs-id <id>', 'non-system ACS identity')
  .option('--non-system-our-user-id <id>', 'non-system OUR UUID')
  .option('--keep', 'do not delete the rehearsed thread')
  .action(async (opts: { systemAcsId?: string; nonSystemAcsId?: string; nonSystemOurUserId?: string; keep?: boolean }) => {
    try {
      const cs = acsConnectionString();
      if (!cs) {
        logError('ACS_CONNECTION_STRING is not set');
        process.exit(2);
      }
      if (!opts.systemAcsId || !opts.nonSystemAcsId || !opts.nonSystemOurUserId) {
        logError('Missing required options for rehearse: --system-acs-id, --non-system-acs-id, --non-system-our-user-id');
        process.exit(2);
      }
      log('Starting rehearse...');
      await migrateRehearse({
        connectionString: cs,
        systemAcsId: opts.systemAcsId!,
        nonSystemAcsId: opts.nonSystemAcsId!,
        nonSystemOurUserId: opts.nonSystemOurUserId!,
        keep: opts.keep,
      });
    } catch (e) {
      logError(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  });

migrate
  .command('extract')
  .description('Walk ACS and write a JSONL extract. Read-only.')
  .requiredOption('--out <path>', 'JSONL output path')
  .option('--reader-acs-id <id>', 'ACS identity to read as')
  .action(async (opts: { out: string; readerAcsId?: string }) => {
    try {
      const cs = acsConnectionString();
      if (!cs) {
        logError('ACS_CONNECTION_STRING is not set');
        process.exit(2);
      }
      if (!opts.readerAcsId) {
        logError('--reader-acs-id is required');
        process.exit(2);
      }
      await migrateExtract({
        connectionString: cs,
        readerAcsId: opts.readerAcsId,
        outPath: opts.out,
      });
    } catch (e) {
      logError(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  });

migrate
  .command('apply')
  .description('Replay threads, participants, and messages onto the target ACS resource.')
  .option('--from-jsonl <path>', 'path to JSONL extract')
  .option('--from-mirror', 'read from Postgres mirror')
  .option(
    '--identity-map <path>',
    'JSON map of old ACS id -> target ACS id. Read before minting, rewritten after. Keep it: without it the replayed threads belong to nobody.',
  )
  .option('--commit', 'must be passed to write to ACS (otherwise dry-run)')
  .action(async (opts: { fromJsonl?: string; fromMirror?: boolean; identityMap?: string; commit?: boolean }) => {
    let db: PgClient | undefined;
    try {
      const targetResourceGuid = acsExpectResource();
      if (!targetResourceGuid) {
        logError('ACS_EXPECT_RESOURCE is required. The command refuses to write without it.');
        process.exit(2);
      }

      const cs = acsConnectionString();
      if (!cs) {
        logError('ACS_CONNECTION_STRING is not set');
        process.exit(2);
      }

      let sourceStream: AsyncIterable<Rec>;
      if (opts.fromJsonl) {
        sourceStream = sourceJsonlFile(opts.fromJsonl);
      } else if (opts.fromMirror) {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          logError('DATABASE_URL is not set for --from-mirror');
          process.exit(2);
        }
        db = await connectReadOnly(dbUrl);
        sourceStream = sourcePostgres(db);
      } else {
        logError('Must specify --from-jsonl or --from-mirror');
        process.exit(2);
      }

      const identityMap = opts.identityMap ? readIdentityMap(opts.identityMap) : new Map<string, string>();
      if (opts.identityMap && identityMap.size) {
        log(`Reusing ${identityMap.size} mapped identit(ies) from ${opts.identityMap}`);
      }
      if (!opts.identityMap && opts.commit) {
        logError(
          'WARNING: --identity-map is not set. Every participant gets a freshly minted identity ' +
            'and the old -> new mapping is discarded when this process exits, so no real user will ' +
            'be able to open the replayed threads.',
        );
      }

      try {
        await migrateApply({
          connectionString: cs,
          sourceStream,
          targetResourceGuid,
          commit: !!opts.commit,
          identityMap,
        });
      } finally {
        // Persist even on failure: identities minted before the crash are real
        // and a re-run must reuse them rather than mint a second orphaned set.
        if (opts.identityMap && identityMap.size) {
          writeIdentityMap(opts.identityMap, identityMap);
          log(`Wrote ${identityMap.size} identity mapping(s) to ${opts.identityMap}`);
        }
      }
    } catch (e) {
      logError(e instanceof Error ? e.message : String(e));
      process.exit(2);
    } finally {
      if (db) {
        await db.end().catch(() => undefined);
      }
    }
  });

migrate
  .command('plan')
  .description('Inspect a dump and flag gaps before you replay. Read-only.')
  .option('--from-jsonl <path>', 'JSONL extract to inspect')
  .option('--from-mirror', 'inspect the Postgres mirror instead of a JSONL file')
  .option('--json', 'print the plan as JSON')
  .action(async (opts: { fromJsonl?: string; fromMirror?: boolean; json?: boolean }) => {
    let db: PgClient | undefined;
    try {
      const targetResourceGuid = acsExpectResource() ?? undefined;
      let sourceStream: AsyncIterable<Rec>;
      if (opts.fromJsonl) {
        sourceStream = sourceJsonlFile(opts.fromJsonl);
      } else if (opts.fromMirror) {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          logError('DATABASE_URL is not set for --from-mirror');
          process.exit(2);
        }
        db = await connectReadOnly(dbUrl);
        sourceStream = sourcePostgres(db);
      } else {
        logError('Must specify --from-jsonl or --from-mirror');
        process.exit(2);
      }

      const report = await migratePlan(sourceStream, targetResourceGuid);
      if (opts.json) {
        logJson(report);
      } else {
        logPlan(report, targetResourceGuid);
      }
    } catch (e) {
      logError(e instanceof Error ? e.message : String(e));
      process.exit(2);
    } finally {
      if (db) {
        await db.end().catch(() => undefined);
      }
    }
  });

program.parseAsync(process.argv).catch((e) => {
  logError(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
