# Contributing to Threadvault

Thanks for looking. Threadvault came out of a production incident, and the rules below all exist because something went wrong once. They are short, and they are not negotiable — everything else is open to argument.

## The three hard rules

1. **Never put a chat message body in a log, a test fixture, an issue, or a commit message.** Message bodies are PHI. `src/log.ts` strips them; keep it that way. Fixtures use lorem, never clinical text and never real names.
2. **Never point a test or an example at a production ACS resource or a production database.**
3. **Never commit a credential.** Reference environment variables by name. The pre-commit hook will stop you, but do not rely on it.

## Getting set up

```bash
git clone https://github.com/Het101/threadvault.git
cd threadvault
npm install          # also installs the git hooks
```

Node **22 or newer**. The Azure SDK will not install on 20.

```bash
npm run dev -- doctor --help   # run from source, no build step
npm test                       # vitest
npm run typecheck              # tsc --noEmit
npm run build                  # tsup -> dist/
```

`npm install` runs `git config core.hooksPath .githooks` for you. If you cloned before that existed, run `npm run hooks` once.

## What the hooks do

**pre-commit** blocks a commit that carries a live ACS access key, a database URL with a real password, or a `.env` file, then runs typecheck and tests if any TypeScript changed. **commit-msg** requires a [Conventional Commit](https://www.conventionalcommits.org/) subject under 72 characters.

`--no-verify` exists, but CI runs the same checks, so it only moves the failure later.

## Commit messages

```
<type>(<scope>): <summary in the imperative, under 72 chars>

Why the change was needed. What broke, or what could not be done before.
The diff already says what changed; the message is for the person who
finds this commit in a year while something is on fire.
```

Types: `feat` `fix` `docs` `test` `perf` `refactor` `build` `ci` `chore` `revert`.
Scopes in use: `acs` `db` `doctor` `mirror` `migrate` `cli` `log`.

Do not add `Co-Authored-By` trailers for tooling. The commit-msg hook rejects them.

## Tests

Every non-trivial change needs a test that fails without it. Not a suite — one test that would have caught the bug.

- Tests are `test/*.test.ts`, run by vitest.
- ACS is mocked with `vi.mock('../src/acs/client.ts', …)`. See `test/scan.test.ts` or `test/verify.test.ts` for the shape.
- Fixtures are synthetic. `lorem`, `19:t@thread.v2`, `8:acs:<guid>_<guid>`, `u-user`.
- If your change touches a path that handles message bodies, assert the body does **not** appear in the output. `test/verify.test.ts` has an example.

## The domain rules

These are earned, and a PR that breaks one will be sent back even if the tests pass:

- **`senderUserId` is our UUID, never an ACS identity.** ACS identities are scoped to one resource (`8:acs:<resourceGuid>_<userGuid>`) and become garbage the moment the resource changes.
- **`sentAt` is the original timestamp.** ACS stamps its own `createdOn` on replay and cannot backdate.
- **Participants are always restored.** There is no flag to skip them. Skipping them caused both production defects the tool was written to prevent.
- **`metadata.originalSenderAcsId` is written for forensics and never read.** Attribution is read from `metadata.originalSenderUserId` only.
- **`ACS_EXPECT_RESOURCE` is required for any ACS write**, and the target is probed and compared before anything is written.
- **Writes are dry-run until `--commit`.**
- **An identity belonging to another resource is exactly as broken as no identity.** Code that only re-mints on *empty* is how 649 stale identities became permanent.
- **Messages inside a thread stay serial.** ACS assigns `sequenceId` on receipt. Concurrency goes across threads, never within one.

## Pull requests

- One concern per PR. A refactor and a fix in the same diff is two PRs.
- Say what breaks without the change. If it fixes a bug, the PR should contain the test that was failing.
- CI must be green: tests, typecheck, build, and `node dist/cli.js --help` on Node 22 and 24.
- Behaviour changes need the README updated in the same PR.

## Reporting a bug

Open an issue with what you ran, what you expected, and what happened. Redact freely — a `doctor --json` with ids removed is usually enough, and we would rather have a vague report than a leaked one.

Security problems do not go in issues. See [SECURITY.md](SECURITY.md).

## Where things live

```
src/cli.ts            commander entry
src/config.ts         env + optional threadvault.yml
src/log.ts            PHI-safe logger — the only thing that writes to stdout
src/acs/              identity parsing, retry, pooling, SDK reads
src/db/               pg helpers, schema DDL
src/doctor/           the five failure-mode checks
src/mirror/           ACS extract, JSONL and Postgres sources and sinks
src/migrate/          plan, rehearse, apply, verify, replay ledger
```
