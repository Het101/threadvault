import { config as loadDotenv } from 'dotenv';
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';

// `quiet` because dotenv 17 started announcing itself on every load. This is a
// CLI whose output is read by people mid-incident and, with --json, by other
// programs; it does not get to add a line of its own. Called here rather than
// via `dotenv/config` only because the side-effect import takes no options —
// every env read in this file happens inside an action handler, well after it.
loadDotenv({ quiet: true });
import { log, logError, logJson } from './log.ts';
import type { PgClient } from './db/pg.ts';
import type { TwilioAuth } from './twilio/client.ts';
import type { DoctorInputs } from './doctor/checks.ts';
import type { Rec } from './mirror/types.ts';
import type { ReplayLedger as ReplayLedgerType } from './migrate/state.ts';

/**
 * Everything below loads on use, not on start.
 *
 * The Azure SDK costs about 850ms to import and pg another 120, and a static
 * import chain made every invocation pay for both — `--help`, `--version` and
 * `migrate plan --from-jsonl`, none of which touch a network. Measured before
 * this change: --help 540ms, plan 818ms.
 *
 * Only the module a command actually reaches is imported. `import type` above
 * is erased at build time and costs nothing.
 */
const lazy = {
  config: () => import('./config.ts'),
  acsClient: () => import('./acs/client.ts'),
  identity: () => import('./acs/identity.ts'),
  pg: () => import('./db/pg.ts'),
  schema: () => import('./db/schema.ts'),
  checks: () => import('./doctor/checks.ts'),
  report: () => import('./doctor/report.ts'),
  scan: () => import('./doctor/scan.ts'),
  backfill: () => import('./mirror/backfill.ts'),
  twilioClient: () => import('./twilio/client.ts'),
  sourceJsonl: () => import('./mirror/source-jsonl.ts'),
  sourcePostgres: () => import('./mirror/source-postgres.ts'),
  rehearse: () => import('./migrate/rehearse.ts'),
  apply: () => import('./migrate/apply.ts'),
  extract: () => import('./migrate/extract.ts'),
  plan: () => import('./migrate/plan.ts'),
  verify: () => import('./migrate/verify.ts'),
  state: () => import('./migrate/state.ts'),
};

/** The two env readers are needed by nearly every action; keep them terse. */
const acsConnectionString = async () => (await lazy.config()).acsConnectionString();
const acsExpectResource = async () => (await lazy.config()).acsExpectResource();

const program = new Command();

program
  .name('threadvault')
  .description('Mirror Azure Communication Services chat into Postgres so the ACS resource is disposable.')
  .version('0.7.0');

program
  .command('probe')
  .description('Mint a throwaway identity to learn the resource GUID. Prints host + GUID, never the key.')
  .action(async () => {
    const cs = await acsConnectionString();
    if (!cs) {
      logError('ACS_CONNECTION_STRING (or ACS_NEW_CONNECTION_STRING) is not set');
      process.exit(2);
    }
    const { probeResource } = await lazy.acsClient();
    const r = await probeResource(cs);
    log(`${(r.host || '-').padEnd(68)}  ${(r.guid || '-').padEnd(38)}  ${r.error ? r.error : 'ok'}`);

    // Whether the probe worked is decided before anything is compared. This
    // used to be the last branch, so a failed probe with ACS_EXPECT_RESOURCE
    // unset printed "Target resource GUID is ?" and exited 0 — reporting
    // success for a command that had learned nothing.
    const { isKnownGuid } = await lazy.identity();
    if (!isKnownGuid(r.guid)) {
      logError('INCONCLUSIVE: could not read the resource GUID — fix the error above before trusting any of this');
      process.exit(2);
    }

    const expect = await acsExpectResource();
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
      const cfg = (await lazy.config()).loadConfig(opts.config);
      const cs = await acsConnectionString();
      const dbUrl = process.env.DATABASE_URL;


      let resourceGuid = await acsExpectResource();
      let host = '(unknown)';
      if (walkAcs) {
        if (!cs) {
          logError('ACS_CONNECTION_STRING is not set (pass --no-acs to audit the database only)');
          process.exit(2);
        }
        const { probeResource } = await lazy.acsClient();
        const probe = await probeResource(cs);
        host = probe.host;
        const { isKnownGuid } = await lazy.identity();
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
        const { connectReadOnly } = await lazy.pg();
        const db = await connectReadOnly(dbUrl);
        try {
          if (cfg.host) {
            const { loadHostUsers, loadHostThreads } = await lazy.checks();
            users = await loadHostUsers(db, cfg.host);
            threads = await loadHostThreads(db, cfg.host);
          } else {
            const { loadMirrorUsers, loadMirrorThreads } = await lazy.checks();
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
      let readerAcsId: string | null = null;
      let unreadable = 0;
      if (walkAcs && cs) {
        const { scanAcs } = await lazy.scan();
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
        readerAcsId = scan.readerAcsId;
        unreadable = scan.unreadable;
        // Only true if a usable identity actually walked the resource. This
        // was set unconditionally, so a scan that found no reader at all still
        // counted as "I looked" — and check 5 then reported every thread in the
        // database as missing from ACS, having never asked.
        acsScanned = scan.readerAcsId !== null;

        if (!acsScanned) {
          logError(
            'No usable ACS identity: every identity on record belongs to another resource, or ' +
              'none is recorded yet. Nothing on ACS was read, so this run is inconclusive rather ' +
              'than clean. Point threadvault.yml at your own tables, or pass --no-acs to audit ' +
              'the database alone.',
          );
          process.exit(2);
        }
      }

      const { runChecks } = await lazy.checks();
      const findings = runChecks({
        resourceGuid,
        users,
        threads,
        acsParticipants,
        acsMessages,
        acsThreadIds,
        acsScanned,
      });
      const { buildReport, formatReport, exitCode } = await lazy.report();
      const report = buildReport(resourceGuid, host, findings, {
        readerAcsId,
        acsThreads: acsThreadIds.size,
        acsMessages: acsMessages.length,
        identities: users.length,
        dbThreads: threads.length,
        unreadable,
      });
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
  .description('Walk ACS or Twilio (or a JSONL extract) and upsert into threadvault_* tables.')
  .option('--from-jsonl <path>', 'read from a JSONL file instead of ACS')
  .option('--from-twilio', 'read Twilio Conversations instead of ACS (TWILIO_* env)')
  .option('--to-jsonl <path>', 'write to a JSONL file instead of Postgres')
  .option('--reader-acs-id <id>', 'the ACS identity to perform the ACS read as')
  .option('--concurrency <n>', 'threads walked at once (messages stay serial)', '4')
  .option('--commit', 'must be passed to write to Postgres (otherwise dry-run)')
  .action(async (opts: { fromJsonl?: string; fromTwilio?: boolean; toJsonl?: string; readerAcsId?: string; concurrency?: string; commit?: boolean }) => {
    try {
      const cs = await acsConnectionString();
      const dbUrl = process.env.DATABASE_URL;

      // Twilio needs no resource guard: its credentials name one account and
      // this only reads. The ACS guard exists because an ACS identity is
      // scoped to a resource and writing to the wrong one is unrecoverable.
      let twilio: TwilioAuth | undefined;
      if (opts.fromTwilio) {
        const { twilioAuth } = await lazy.config();
        const { authProblem } = await lazy.twilioClient();
        const auth = twilioAuth();
        const problem = authProblem(auth ?? {});
        if (!auth || problem) {
          logError(problem ?? 'Twilio credentials are not set');
          process.exit(2);
        }
        twilio = auth;
      }

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
          const { connect } = await lazy.pg();
          const { applySchema } = await lazy.schema();
          db = await connect(dbUrl, false);
          await applySchema(db); // ensure tables exist before upserting
        }
      }

      log('Starting backfill...');
      const { mirrorBackfill } = await lazy.backfill();
      const stats = await mirrorBackfill({
        connectionString: cs,
        readerAcsId: opts.readerAcsId,
        db,
        jsonlPath: opts.toJsonl,
        fromJsonl: opts.fromJsonl,
        twilio,
        concurrency: Math.max(1, Number(opts.concurrency ?? 4)),
      });

      if (stats) {
        log(
          `Backfill ${opts.commit || opts.toJsonl ? 'complete' : 'dry run'}. ` +
            `Threads: ${stats.threads}, Participants: ${stats.participants}, ` +
            `Messages: ${stats.messages}, Identities: ${stats.identities}`,
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
  .option('--mint', 'create the identities this needs, then remove them (for an empty target)')
  .action(async (opts: { systemAcsId?: string; nonSystemAcsId?: string; nonSystemOurUserId?: string; keep?: boolean; mint?: boolean }) => {
    try {
      // rehearse writes to ACS, so it takes the same guard as apply.
      const targetResourceGuid = await acsExpectResource();
      if (!targetResourceGuid) {
        logError('ACS_EXPECT_RESOURCE is required. Rehearse writes a thread to the target and refuses without it.');
        process.exit(2);
      }
      const cs = await acsConnectionString();
      if (!cs) {
        logError('ACS_CONNECTION_STRING is not set');
        process.exit(2);
      }
      // A fresh target resource has no identities and ACS only creates them
      // through the API, so demanding them up front made rehearse unusable on
      // exactly the resource it is meant for.
      if (!opts.mint && (!opts.systemAcsId || !opts.nonSystemAcsId)) {
        logError('rehearse needs --system-acs-id and --non-system-acs-id, or --mint to create them for this run');
        process.exit(2);
      }
      log('Starting rehearse...');
      const { migrateRehearse } = await lazy.rehearse();
      await migrateRehearse({
        connectionString: cs,
        targetResourceGuid,
        systemAcsId: opts.systemAcsId,
        nonSystemAcsId: opts.nonSystemAcsId,
        nonSystemOurUserId: opts.nonSystemOurUserId,
        keep: opts.keep,
        mint: opts.mint,
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
  .option('--no-bodies', 'omit message text; the dump then works with plan and verify, not apply')
  .action(async (opts: { out: string; readerAcsId?: string; concurrency?: string; bodies?: boolean }) => {
    try {
      const cs = await acsConnectionString();
      if (!cs) {
        logError('ACS_CONNECTION_STRING is not set');
        process.exit(2);
      }
      if (!opts.readerAcsId) {
        logError('--reader-acs-id is required');
        process.exit(2);
      }
      const { migrateExtract } = await lazy.extract();
      await migrateExtract({
        connectionString: cs,
        readerAcsId: opts.readerAcsId,
        outPath: opts.out,
        concurrency: Math.max(1, Number(opts.concurrency ?? 4)),
        withoutBodies: opts.bodies === false,
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
    let ledger: ReplayLedgerType | undefined;
    try {
      const targetResourceGuid = await acsExpectResource();
      if (!targetResourceGuid) {
        logError('ACS_EXPECT_RESOURCE is required. The command refuses to write without it.');
        process.exit(2);
      }

      const cs = await acsConnectionString();
      if (!cs) {
        logError('ACS_CONNECTION_STRING is not set');
        process.exit(2);
      }

      let sourceStream: AsyncIterable<Rec>;
      if (opts.fromJsonl) {
        sourceStream = (await lazy.sourceJsonl()).sourceJsonlFile(opts.fromJsonl);
      } else if (opts.fromMirror) {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          logError('DATABASE_URL is not set for --from-mirror');
          process.exit(2);
        }
        db = await (await lazy.pg()).connectReadOnly(dbUrl);
        sourceStream = (await lazy.sourcePostgres()).sourcePostgres(db);
      } else {
        logError('Must specify --from-jsonl or --from-mirror');
        process.exit(2);
      }

      const { ReplayLedger } = await lazy.state();
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

      const { migrateApply } = await lazy.apply();
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
      const targetResourceGuid = (await acsExpectResource()) ?? undefined;
      let sourceStream: AsyncIterable<Rec>;
      if (opts.fromJsonl) {
        sourceStream = (await lazy.sourceJsonl()).sourceJsonlFile(opts.fromJsonl);
      } else if (opts.fromMirror) {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          logError('DATABASE_URL is not set for --from-mirror');
          process.exit(2);
        }
        db = await (await lazy.pg()).connectReadOnly(dbUrl);
        sourceStream = (await lazy.sourcePostgres()).sourcePostgres(db);
      } else {
        logError('Must specify --from-jsonl or --from-mirror');
        process.exit(2);
      }

      const { migratePlan, logPlan } = await lazy.plan();
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
      let ledger: ReplayLedgerType | undefined;
      try {
        const cs = await acsConnectionString();
        if (!cs) {
          logError('ACS_CONNECTION_STRING is not set (point it at the TARGET resource)');
          process.exit(2);
        }

        let sourceStream: AsyncIterable<Rec>;
        if (opts.fromJsonl) {
          sourceStream = (await lazy.sourceJsonl()).sourceJsonlFile(opts.fromJsonl);
        } else if (opts.fromMirror) {
          const dbUrl = process.env.DATABASE_URL;
          if (!dbUrl) {
            logError('DATABASE_URL is not set for --from-mirror');
            process.exit(2);
          }
          db = await (await lazy.pg()).connectReadOnly(dbUrl);
          sourceStream = (await lazy.sourcePostgres()).sourcePostgres(db);
        } else {
          logError('Must specify --from-jsonl or --from-mirror');
          process.exit(2);
        }

        ledger = (await lazy.state()).ReplayLedger.open(opts.state);
        const { migrateVerify, formatVerify, verifyExitCode } = await lazy.verify();
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

/**
 * Exported so tests can drive the same commander program a user drives.
 *
 * Every command was wired up here and tested nowhere: this file sat at 0%
 * coverage while the suite was green. Two commands shipped unusable as a
 * result - `migrate rehearse` demanded identities that could not be obtained,
 * and nothing noticed, because the only thing CI ran against it was --help.
 */
export { program };

// Parse only when this file is the program being run. Without the guard,
// importing it in a test would consume the test runner argv and exit.
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  program.parseAsync(process.argv).catch((e: unknown) => {
    logError(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
