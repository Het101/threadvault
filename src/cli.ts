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
import { ReplayLedger } from './migrate/state.ts';
import { migrateVerify, formatVerify, verifyExitCode } from './migrate/verify.ts';
import { log, logError, logJson } from './log.ts';

const program = new Command();

program
  .name('threadvault')
  .description('Mirror Azure Communication Services chat into Postgres so the ACS resource is disposable.')
  .version('0.2.3');

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

    // Whether the probe worked is decided before anything is compared. This
    // used to be the last branch, so a failed probe with ACS_EXPECT_RESOURCE
    // unset printed "Target resource GUID is ?" and exited 0 — reporting
    // success for a command that had learned nothing.
    if (!isKnownGuid(r.guid)) {
      logError('INCONCLUSIVE: could not read the resource GUID — fix the error above before trusting any of this');
      process.exit(2);
    }

    const expect = acsExpectResource();
    if (!expect) {
      log(`note: ACS_EXPECT_RESOURCE unset. Target resource GUID is ${r.guid}`);
      log(`      export ACS_EXPECT_RESOURCE=${r.guid}`);
    } else if (r.guid === expect) {
      log('ok: connection string matches ACS_EXPECT_RESOURCE');
    } else {
      logError(`WARNING: connection string is ${r.guid}, expected ${expect}`);
      process.exit(1);
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
  .option('--concurrency <n>', 'threads walked at once (messages stay serial)', '4')
  .option('--commit', 'must be passed to write to Postgres (otherwise dry-run)')
  .action(async (opts: { fromJsonl?: string; toJsonl?: string; readerAcsId?: string; concurrency?: string; commit?: boolean }) => {
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
        concurrency: Math.max(1, Number(opts.concurrency ?? 4)),
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
      // rehearse writes to ACS, so it takes the same guard as apply.
      const targetResourceGuid = acsExpectResource();
      if (!targetResourceGuid) {
        logError('ACS_EXPECT_RESOURCE is required. Rehearse writes a thread to the target and refuses without it.');
        process.exit(2);
      }
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
        targetResourceGuid,
        systemAcsId: opts.systemAcsId,
        nonSystemAcsId: opts.nonSystemAcsId,
        nonSystemOurUserId: opts.nonSystemOurUserId,
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
  .option('--concurrency <n>', 'threads walked at once (messages stay serial)', '4')
  .action(async (opts: { out: string; readerAcsId?: string; concurrency?: string }) => {
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
        concurrency: Math.max(1, Number(opts.concurrency ?? 4)),
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
    '--state <path>',
    'replay ledger: minted identities and per-thread progress. Makes the replay resumable and is the only link between replayed threads and the people in them. Keep it.',
  )
  .option('--commit', 'must be passed to write to ACS (otherwise dry-run)')
  .action(async (opts: { fromJsonl?: string; fromMirror?: boolean; state?: string; commit?: boolean }) => {
    let db: PgClient | undefined;
    let ledger: ReplayLedger | undefined;
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

      ledger = opts.state ? ReplayLedger.open(opts.state) : ReplayLedger.ephemeral();
      const doneThreads = [...ledger.threads.values()].filter((t) => t.done).length;
      if (opts.state && (ledger.identities.size || ledger.threads.size)) {
        log(
          `Resuming from ${opts.state}: ${ledger.identities.size} identit(ies), ` +
            `${doneThreads} thread(s) already replayed`,
        );
      }
      if (!opts.state && opts.commit) {
        logError(
          'WARNING: --state is not set. Minted identities and replay progress are discarded when ' +
            'this process exits, so no real user will be able to open the replayed threads and an ' +
            'interrupted run cannot be resumed without duplicating everything it already wrote.',
        );
      }

      await migrateApply({
        connectionString: cs,
        sourceStream,
        targetResourceGuid,
        commit: !!opts.commit,
        ledger,
      });
    } catch (e) {
      logError(e instanceof Error ? e.message : String(e));
      process.exit(2);
    } finally {
      // Close even on failure: entries written before the crash are real, and a
      // resumed run reads them rather than duplicating the work they describe.
      ledger?.close();
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

migrate
  .command('verify')
  .description('Read a replayed estate back and prove it matches the source. Read-only.')
  .option('--from-jsonl <path>', 'the JSONL extract that was replayed')
  .option('--from-mirror', 'the Postgres mirror that was replayed')
  .requiredOption('--state <path>', 'the replay ledger written by migrate apply')
  .option('--reader-acs-id <id>', 'identity to read the target as')
  .option('--concurrency <n>', 'threads verified at once', '4')
  .option('--json', 'print the report as JSON')
  .action(
    async (opts: {
      fromJsonl?: string;
      fromMirror?: boolean;
      state: string;
      readerAcsId?: string;
      concurrency?: string;
      json?: boolean;
    }) => {
      let db: PgClient | undefined;
      let ledger: ReplayLedger | undefined;
      try {
        const cs = acsConnectionString();
        if (!cs) {
          logError('ACS_CONNECTION_STRING is not set (point it at the TARGET resource)');
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

        ledger = ReplayLedger.open(opts.state);
        const report = await migrateVerify({
          connectionString: cs,
          sourceStream,
          ledger,
          readerAcsId: opts.readerAcsId,
          concurrency: Math.max(1, Number(opts.concurrency ?? 4)),
        });

        if (opts.json) logJson(report);
        else log(formatVerify(report));
        process.exit(verifyExitCode(report));
      } catch (e) {
        logError(e instanceof Error ? e.message : String(e));
        process.exit(2);
      } finally {
        ledger?.close();
        if (db) {
          await db.end().catch(() => undefined);
        }
      }
    },
  );

program.parseAsync(process.argv).catch((e) => {
  logError(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
