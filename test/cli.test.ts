import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type * as LogModule from '../src/log.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Drives the real commander program, the way a user does.
 *
 * Every command lives in src/cli.ts and nothing tested it: the file sat at 0%
 * coverage while the suite was green, and two commands shipped unusable as a
 * result. `migrate rehearse` required two ACS identities that a user had no way
 * to create, and CI never noticed because the only thing it ran against each
 * command was `--help` — which passes whether or not the command works.
 *
 * The rule these tests encode: a command is not "working" because it prints
 * help. It is working when it can be driven to its own success path using only
 * inputs a user can actually obtain.
 */

const RESOURCE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SYS = `8:acs:${RESOURCE}_11111111-1111-1111-1111-111111111111`;

const out: string[] = [];
const errs: string[] = [];

vi.mock('../src/log.ts', async (orig) => {
  const real = await orig<typeof LogModule>();
  return {
    ...real,
    log: (m: string) => out.push(m),
    logError: (m: string) => errs.push(m),
    logJson: (v: unknown) => out.push(JSON.stringify(v)),
  };
});

/**
 * A Postgres that answers whichever shape doctor asks in.
 *
 * doctor reads the host tables when a threadvault.yml is present and the
 * mirror tables when it is not — so a test that handled only one shape would
 * pass or fail depending on whether the developer running it happens to have a
 * config in their working directory. It handles both, deliberately.
 */
vi.mock('../src/db/pg.ts', () => ({
  connectReadOnly: vi.fn().mockImplementation(() =>
    Promise.resolve({
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('to_regclass')) return Promise.resolve({ rows: [{ reg: 'x' }] });

        // One system identity on this resource, by either route.
        if (sql.includes('threadvault_identities')) {
          return Promise.resolve({ rows: [{ our_user_id: 'sys', acs_id: SYS, is_system: true }] });
        }
        if (sql.includes('AS acs')) {
          return Promise.resolve({ rows: [{ id: 'sys', acs: SYS, sys: true }] });
        }

        // No threads on record either way, while ACS lists one. That is the
        // split brain this test wants reported.
        return Promise.resolve({ rows: [] });
      }),
      end: vi.fn().mockResolvedValue(undefined),
    }),
  ),
  connect: vi.fn(),
  qid: (n: string) => `"${n}"`,
}));
vi.mock('../src/acs/client.ts', () => ({
  probeResource: vi.fn().mockResolvedValue({ host: 'mock.communication.azure.com', guid: RESOURCE }),
  parseEndpoint: () => 'https://mock.communication.azure.com',
  parseEndpointHost: () => 'mock.communication.azure.com',
  connectionStringProblem: () => null,
  createAcs: vi.fn().mockImplementation(() => ({
    endpoint: 'https://mock.communication.azure.com',
    identity: {
      createUser: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ communicationUserId: `8:acs:${RESOURCE}_minted` }),
        ),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    },
    chatFor: vi.fn().mockImplementation(() =>
      Promise.resolve({
        createChatThread: () => Promise.resolve({ chatThread: { id: '19:r@thread.v2' } }),
        deleteChatThread: () => Promise.resolve(),
        listChatThreads: async function* () {
          yield { id: '19:r@thread.v2' };
        },
        getChatThreadClient: () => ({
          getProperties: () =>
            Promise.resolve({ id: '19:r@thread.v2', topic: 'lorem', createdOn: new Date() }),
          addParticipants: () => Promise.resolve(),
          listParticipants: async function* () {
            yield { id: { communicationUserId: SYS } };
            yield { id: { communicationUserId: `8:acs:${RESOURCE}_minted` } };
          },
          sendMessage: (_c: unknown, o?: { metadata?: Record<string, string> }) => {
            lastMetadata = o?.metadata ?? {};
            return Promise.resolve({ id: 'm-1' });
          },
          listMessages: async function* () {
            /* no messages */
          },
          getMessage: () =>
            Promise.resolve({ id: 'm-1', createdOn: new Date(), metadata: lastMetadata }),
        }),
      }),
    ),
  })),
}));

let lastMetadata: Record<string, string> = {};

const { program } = await import('../src/cli.ts');

/** Runs the CLI and returns what a user would have seen, plus the exit code. */
async function run(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  out.length = 0;
  errs.length = 0;
  let code = 0;
  let exited = false;
  // The real process.exit never returns, so the first call is the one that
  // counts. Recording later calls instead would report cli.ts's own catch
  // block swallowing this signal and exiting 2 over the code it meant.
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    if (!exited) {
      exited = true;
      code = c ?? 0;
    }
    throw new ExitSignal();
  }) as never);
  try {
    await program.parseAsync(['node', 'threadvault', ...argv]);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    exit.mockRestore();
  }
  return { out: out.join('\n'), err: errs.join('\n'), code };
}

class ExitSignal extends Error {}

const dir = mkdtempSync(join(tmpdir(), 'tv-cli-'));
const dump = join(dir, 'in.jsonl');
writeFileSync(
  dump,
  [
    JSON.stringify({
      kind: 'thread',
      ourThreadId: null,
      legacyThreadId: '19:a@thread.v2',
      topic: 'lorem',
      createdOn: '2022-01-01T00:00:00.000Z',
      createdByAcsId: null,
      deletedOn: null,
      readerAcsId: SYS,
    }),
    JSON.stringify({
      kind: 'message',
      legacyThreadId: '19:a@thread.v2',
      messageId: 'm-1',
      type: 'text',
      sequenceId: '1',
      content: 'lorem',
      senderAcsId: SYS,
      senderDisplayName: null,
      ourSenderUserId: 'u-1',
      createdOn: '2022-01-01T12:00:00.000Z',
      editedOn: null,
      deletedOn: null,
      metadata: null,
    }),
  ].join('\n') + '\n',
  'utf8',
);

const ENV = { ...process.env };
beforeEach(() => {
  process.env.ACS_CONNECTION_STRING = 'endpoint=https://mock.communication.azure.com/;accesskey=k';
  process.env.ACS_EXPECT_RESOURCE = RESOURCE;
  delete process.env.DATABASE_URL;
  lastMetadata = {};
});
afterAll(() => {
  process.env = ENV;
});

describe('every command reaches its own success path', () => {
  it('probe', async () => {
    const r = await run('probe');
    expect(r.code).toBe(0);
    expect(r.out).toContain(RESOURCE);
  });

  /**
   * The regression this whole file exists for. rehearse shipped requiring two
   * ACS identities that a user of a fresh resource had no way to create, so its
   * success path was unreachable. --help passed the entire time.
   */
  it('migrate rehearse, with nothing but --mint', async () => {
    const r = await run('migrate', 'rehearse', '--mint');
    expect(r.code).toBe(0);
    expect(r.out).toContain('all 4 assertions passed');
  });

  it('migrate plan, from a dump on disk', async () => {
    const r = await run('migrate', 'plan', '--from-jsonl', dump);
    expect(r.code).toBe(0);
    expect(r.out).toContain('threads:');
    expect(r.out).toContain('messages carrying our user id');
  });

  it('migrate extract, writing a file', async () => {
    const outPath = join(dir, 'out.jsonl');
    const r = await run('migrate', 'extract', '--out', outPath, '--reader-acs-id', SYS);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Extract complete');
  });

  it('migrate extract --no-bodies says the dump is not replayable', async () => {
    const outPath = join(dir, 'nb.jsonl');
    const r = await run(
      'migrate',
      'extract',
      '--out',
      outPath,
      '--reader-acs-id',
      SYS,
      '--no-bodies',
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('No message bodies were read');
  });
});

describe('a command that cannot run says why, and exits 2', () => {
  it('rehearse without identities names --mint as the way out', async () => {
    const r = await run('migrate', 'rehearse');
    expect(r.code).toBe(2);
    // Not just "missing options" — it has to say how to satisfy them.
    expect(r.err).toContain('--mint');
  });

  it('rehearse refuses without ACS_EXPECT_RESOURCE, because it writes', async () => {
    delete process.env.ACS_EXPECT_RESOURCE;
    const r = await run('migrate', 'rehearse', '--mint');
    expect(r.code).toBe(2);
    expect(r.err).toContain('ACS_EXPECT_RESOURCE');
  });

  it('extract refuses without a reader identity', async () => {
    const r = await run('migrate', 'extract', '--out', join(dir, 'x.jsonl'));
    expect(r.code).toBe(2);
    expect(r.err).toContain('reader-acs-id');
  });

  it('probe refuses when the connection string is unset', async () => {
    delete process.env.ACS_CONNECTION_STRING;
    const r = await run('probe');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/ACS_CONNECTION_STRING/);
  });

  it('doctor will not call a scan it never ran clean', async () => {
    // No DATABASE_URL and no host config, so no identity can be resolved.
    const r = await run('doctor');
    expect(r.code).toBe(2);
    expect(r.err).toContain('inconclusive');
  });
});

/**
 * doctor end to end: database in, ACS walked, report out. The remediation
 * section was added after the last run against a real resource, so this is what
 * stands in for that run — it drives the whole command rather than the
 * formatter alone.
 */
describe('doctor produces a full report', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
  });

  it('reports the split brain it found, and what to do about it', async () => {
    const r = await run('doctor');

    expect(r.code).toBe(1);
    expect(r.out).toContain('[5] split-brain-threads');
    expect(r.out).toContain('has no matching database row');

    // The half that was missing until now.
    expect(r.out).toContain('What to do');
    expect(r.out).toContain('acs-thread-not-in-db');
    expect(r.out).toMatch(/means .*database has no row/s);
    expect(r.out).toMatch(/check .*Re-run doctor/s);
  });

  it('states the scope, so a check reading ok can be believed', async () => {
    const r = await run('doctor');
    expect(r.out).toMatch(/walked\s+1 ACS thread/);
    expect(r.out).toMatch(/against\s+1 identit/);
  });

  it('gives --json the same advice a person gets', async () => {
    const r = await run('doctor', '--json');
    const report = JSON.parse(r.out) as {
      advice: { kind: string; means: string; action: string; verify: string }[];
      scope: { acsThreads: number };
    };
    expect(report.advice.map((a) => a.kind)).toContain('acs-thread-not-in-db');
    expect(report.advice[0]?.action.length).toBeGreaterThan(40);
    expect(report.scope.acsThreads).toBe(1);
  });
});

describe('the resource guard holds at the CLI boundary', () => {
  it('probe warns and exits 1 when the target is not the expected resource', async () => {
    process.env.ACS_EXPECT_RESOURCE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const r = await run('probe');
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/ffffffff-ffff-ffff-ffff-ffffffffffff/);
  });

  it('rehearse will not write to a resource that is not the expected one', async () => {
    process.env.ACS_EXPECT_RESOURCE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const r = await run('migrate', 'rehearse', '--mint');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/mismatch/i);
  });
});
