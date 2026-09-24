# Changelog

All notable changes to Threadvault are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/). Until 1.0, breaking
changes may land in a minor release; they are always called out below.

## [0.2.2] - 2026-09-24

### Fixed

- Reading a file no longer checks that it exists first. `existsSync` followed by
  `readFileSync` leaves a window in which the file can be created, removed or
  replaced, and the answer to the check is stale by the time the read runs
  (CodeQL `js/file-system-race`). Affected the replay ledger and the config
  loader. Only a genuinely missing file is treated as absent now; a permission
  or I/O failure surfaces instead of being reported as "nothing here yet",
  which would have silently restarted a replay.
- A mistyped `--from-jsonl` path now says `extract not found: <path>` rather
  than surfacing Node's raw `ENOENT` with an absolute path in it.

### Security

- Cleared GHSA-g7r4-m6w7-qqqr (esbuild development server, arbitrary file read
  on Windows). Dev-only and never invoked, but the fix was a lockfile bump.
- The remaining `uuid` advisory stays accepted and is documented in
  `SECURITY.md`: not reachable, and npm's only fix downgrades the Azure SDK.

## [0.2.1] - 2026-09-24

### Fixed

- `redactPhi` crashed on a cyclic object. An Azure SDK error carries request
  and response objects that point at each other, so redacting one overflowed
  the stack and killed the process — while reporting an error, which took the
  diagnostic down with it. It now renders a genuine cycle as `[circular]`,
  caps depth, and shows an `Error` as name and message rather than `{}`.
- `migrate rehearse` carried a failure branch that could never run; every
  assertion throws, so it would only have replaced a specific assertion
  message with a useless one.

## [0.2.0] - 2026-09-24

### Added

- `migrate verify` — reads a replayed estate back and proves it matches the
  source: message counts, participant counts, and whether every replayed message
  still carries a recoverable author and original timestamp. Read-only, never
  reads a message body, exits non-zero on a mismatch so it can gate a cutover.
- `migrate apply --state` — an append-only replay ledger holding minted
  identities and per-thread progress. Makes an interrupted replay resumable
  instead of duplicating everything it already wrote.
- `migrate plan` — inspects a dump before replay and flags messages with no
  recoverable sender or timestamp, and identities from other resources.
- `--concurrency` on `migrate extract` and `mirror backfill`. Threads are walked
  in parallel; messages inside a thread stay serial as ACS requires.
- A Postgres mirror source, so `migrate apply` can replay `--from-mirror`.
- Pre-commit and commit-msg hooks, wired through `core.hooksPath` with no new
  dependencies. They block committed secrets and enforce Conventional Commits.

### Changed

- **Breaking:** remote Postgres connections now verify the server certificate by
  default. A server with a private CA needs `PG_SSL_NO_VERIFY=true`. The old
  `PG_SSL_VERIFY` variable is gone.
- `migrate apply` sends each message as its mapped sender where that identity is
  on the thread, so the ACS sender and the metadata agree.
- ACS control messages (`participantAdded`, `topicUpdated`) are no longer
  replayed as empty text messages.
- Terminal ACS errors (400/401/403/404) fail immediately instead of backing off
  through a retry schedule that could never succeed.
- `mirror backfill`'s dry run counts the source and never opens a write path.
- JSONL extracts truncate rather than append, and stream rather than reopening
  the file per record.

### Fixed

- ACS identities whose user half is not a bare UUID (`8:acs:<guid>_sys`) now
  parse. They previously did not, which made `migrate plan` report zero stale
  identities on a dump full of them.
- Participants with no host mapping got a fresh random UUID per run, so
  `ON CONFLICT` never fired and every re-run duplicated every participant row.
- A single malformed line no longer aborts a whole JSONL replay.
- `--json` output went straight to `console.log`, bypassing PHI and secret
  redaction.
- Database passwords in connection URLs are now redacted from logs and errors.
- One unreadable thread no longer ends an entire extract.

### Security

- `test/phi-guard.test.ts` fails the build if any source file writes to stdout or
  stderr without going through the redacting logger.

## [0.1.0]

Initial release: `probe`, `doctor`, `mirror backfill`, `migrate extract`,
`migrate rehearse`, `migrate apply`.

[0.2.2]: https://github.com/Het101/threadvault/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Het101/threadvault/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Het101/threadvault/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Het101/threadvault/releases/tag/v0.1.0
