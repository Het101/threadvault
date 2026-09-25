# Changelog

All notable changes to Threadvault are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/). Until 1.0, breaking
changes may land in a minor release; they are always called out below.

## [Unreleased]

### Added

- **`TWILIO_BASE_URL`.** Points the Conversations client somewhere other than
  the default host. Twilio runs regional endpoints, so this is not only a test
  seam — but it is also the thing that made the Twilio reader verifiable at
  all. Plain `http` is refused unless the host is loopback: that URL carries
  the credential in an Authorization header and message bodies on the way back.

  With it, the **built binary** was run end to end against a server speaking
  the Conversations wire format, page size forced to 2 so every collection had
  to paginate. It produced a dump matching known fixtures exactly — 3 threads,
  6 participants, 5 messages — including an empty conversation and a
  participant reached over SMS who has a binding address and no identity.

### Changed

- **`migrate plan`'s attribution note no longer says "ACS"** when the dump did
  not come from ACS. It explained a Twilio dump in terms of a provider that was
  not involved.

### Fixed

- **A walk that cannot list anything no longer reports an empty estate.**
  `mirror backfill` caught a failure to list threads, logged it, and carried on
  to print `Threads: 0, Participants: 0, Messages: 0` and exit `0`. A revoked
  key, an identity with no access, and a resource with nothing in it all
  produced the same answer, and nothing in the output told them apart.

  Found by pointing the new Twilio walk at a real trial account, which refuses
  the Conversations API with `401 This feature is not available on a Trial
  account`. The tool said the account was empty.

  The same code was in the ACS walk — the Twilio one had been written from it —
  so `mirror backfill` against ACS with a bad credential did this too, and had
  since the beginning. Both now fail with the reason and exit `2`. A failure to
  read one thread is still tolerated; a failure to read any is not a finding
  about the estate.

## [0.8.0] - 2026-09-25

Threadvault is no longer only for Azure. `mirror backfill` can read Twilio
Conversations, and the Postgres mirror, `migrate plan` and `migrate verify`
work on the result unchanged.

**The Twilio reader has not been run against a live Twilio account.** Every ACS
path in this tool has been run against real Azure; this has not. It is covered
by tests against a faked HTTP layer — auth, pagination, partial failures, SMS
participants with no identity — which is the same standard the ACS tests meet,
but it is not the same as having done it. Read the caveat, not just the feature.

### Added

- **`mirror backfill --from-twilio`.** Threadvault can now mirror Twilio
  Conversations into your own Postgres, alongside ACS.

  The mirror is the part of this tool that was never about Azure: putting the
  estate somewhere you own, keyed to your own user ids, so the vendor becomes
  disposable. That argument holds for any chat provider. A Twilio walk produces
  the same records an ACS walk produces, so `migrate plan`, `migrate verify` and
  the Postgres schema work on it unchanged — no provider abstraction was added,
  because `AsyncIterable<Rec>` has been the interface since the first dump.

  Two things are deliberately different, and both are because Twilio does not
  have the problem this tool was written for. There is no resource guard: a
  Twilio credential names one account and the walk only reads. And there is no
  identity minting: Twilio takes the author as a plain string, where ACS makes
  you send as an identity you hold a token for and record the real sender in
  metadata — which is the root of misattribution, of stale identities, and of
  most of what `doctor` looks for.

  No SDK. The `twilio` helper library is megabytes of voice, video and TwiML
  for what is three GET endpoints, and this reads them over `fetch`.

  **Not yet run against a live Twilio account.** It is covered by tests against
  a faked HTTP layer — auth, pagination, partial failures, SMS participants with
  no identity — but every ACS path in this tool has been run against real Azure
  and this has not. Treat it accordingly, and say so if you try it.

### Changed

- **The `doctor` screenshot shows what `doctor` prints.** It predated the scope
  lines added in 0.5.0 and the remediation section added in 0.7.0, so the most
  looked-at picture in the README was two releases behind and undersold the
  tool. Its alt text was worse than the image: it described a different check
  firing, so anyone reading with a screen reader got a different report from
  everyone else. Background is transparent now, so it sits on GitHub in either
  colour scheme.

## [0.7.0] - 2026-09-25

`doctor` now tells you what to do about what it finds, and the release process
has the gate it was missing.

### Added

- **`doctor` now says what to do about what it finds.** Running it against a
  real resource turned up two orphan threads, and the report said only that
  they existed. Working out what that meant, whether it mattered and what to do
  took longer than the scan — the wrong way round for something people run
  while an incident is open.

  Each finding now carries three things: what it means in terms of consequence,
  what to do about it, and how to confirm it worked. Grouped by kind of problem
  rather than by occurrence, so 649 stale identities produce one paragraph and
  not 649. `--json` carries the same guidance, so a monitor can surface it too.

  No remedy runs a command that writes. Several of these have more than one
  reasonable answer — an orphan thread can be adopted or discarded, and only
  someone who can read it knows which — so the decision stays with a person.

### Fixed

- **CI proves commands work, not that they print help.** Three releases shipped
  with a command that did not function, and the suite was green for all three.
  `src/cli.ts` — every command’s wiring, the largest file in the project —
  sat at 0% coverage, and the only thing CI ran against each command was
  `--help`, which passes whether or not the command works.

  The commander program is now exported and driven by tests exactly as a user
  drives it, through `parseAsync`, asserting on output and exit codes. Twelve
  of them, including one that fails against the pre-0.6.0 `rehearse` and passes
  against the current one. CI additionally runs a real `migrate plan` through
  the built binary and checks the numbers it prints.

  Coverage 67% to 76%; `cli.ts` 0% to 43%. The floor moved up with it.

  Nothing about the published binary changes: it parses argv when it is the
  program being run, and the smoke test proves that on every commit.

## [0.6.0] - 2026-09-25

Makes `migrate rehearse` usable on the resource it was designed for. With this
release every command in the tool has been run against a real Azure resource
rather than against its own fixtures.

### Added

- **`migrate rehearse --mint`.** Rehearse needs two ACS identities, and a
  brand-new resource has none. ACS creates identities only through its API
  — there is no portal screen for it — so rehearsing against a fresh target
  meant writing a script first, which is the one thing a rehearsal is meant to
  save you from. The command was effectively unusable on exactly the kind of
  resource it exists for.

  `--mint` creates the two identities it needs and removes them again at the
  end, including when an assertion fails. Identities passed in with
  `--system-acs-id` / `--non-system-acs-id` are never deleted: only ones the
  run created. `--non-system-our-user-id` now defaults to a random UUID, since
  it exists only to be asserted on.

  Verified against a real Azure resource: four assertions passed, one thread
  created and removed, two identities created and removed, nothing else in the
  resource touched.

## [0.5.0] - 2026-09-25

The first release shaped by running this tool against a real production ACS
resource rather than against its own fixtures. Every change below is something
that run exposed: two of them are reports that were technically correct and
unreadable, and one is the reason the run could happen at all.

Upgrade if you use `doctor` or `migrate plan`. Their output changes.

### Added

- **`migrate extract --no-bodies`.** Message bodies are the only thing this tool
  writes to disk that the source would call sensitive. `doctor` already discards
  them at the SDK boundary so no caller can hold one, and `plan` and `verify`
  never read them — `extract` was the single reason the read-and-analyse path
  could not be pointed at a resource whose contents are not allowed to leave it.

  With the flag the extract carries every thread, participant, identity,
  timestamp and attribution field, and no message text. That is exactly what
  `plan` and `verify` consume, so the whole analysis runs unchanged.

  `migrate apply` refuses such a dump, during the dry run, before `--commit` is
  reached. Replaying one would post an empty message for each real one — in the
  right thread, from the right person, at the right time. Convincing, and not
  recoverable without re-extracting.

- **[A runbook for the first run against a real resource](docs/first-real-run.md).**
  Ordered so stages 1–5 cannot write to ACS at all, and the first thing that
  writes needs a resource you are willing to delete.

### Changed

- **`doctor` now says what it walked**, not only what it found:

  ```
    walked    34 ACS thread(s), 168 message(s), as 8:acs:<reader>
    against   167 identit(ies) and 32 thread(s) on record
    unread    3 thread(s) ACS listed but would not open
  ```

  A check reading `ok` means *no findings*. Without those lines there was no way
  to tell that from *no findings because almost nothing was read* — the same
  trap as the `acsScanned` bug fixed in 0.3.0. The `unread` line appears only
  when non-zero, because "clean" and "unread" are different things the old
  report silently merged.

  The reader identity appearing there also removes a step: `migrate extract`
  requires one, and `doctor` had been resolving it and keeping it to itself.

- **`migrate plan` reports attribution in a way that can be acted on.** The row
  `messages missing original sender: 168` was technically correct and read as
  total attribution loss. `originalSenderUserId` is metadata that `migrate
  apply` writes during a replay; ACS does not store it, so a resource that has
  never been replayed has none at all. The number was structural and said
  nothing about the data — while `doctor` called attribution clean on the same
  estate minutes earlier.

  It now reads `messages carrying our user id: N of M`, and the report
  distinguishes three situations: all present says nothing, **none** present is
  explained as expected on a first extract along with what it costs, and
  **some** present prints a `WARNING` — that is the mixed case, where
  attribution really was lost for a subset, and it was previously
  indistinguishable from the other two.

### Fixed

- **A local `threadvault.yml` is now gitignored.** It names the table and column
  layout of whatever database it points at, which for anyone using this tool is
  a production schema. Only `threadvault.example.yml` belongs in a repository.

- **The runbook said the missing-sender count "must be 0".** Wrong in the way
  most likely to stop a first-time user: it described a completely normal
  reading as a defect. Rewritten around what the report now explains, with
  figures from a real run in place of invented ones, and a cross-check step —
  `doctor` and `plan` walk the same estate by different routes and their totals
  should agree.

## [0.4.0] - 2026-09-25

No behaviour changes. This release raises the minimum Node version and rebuilds
what stands between a compromised dependency and the package you install.

### Changed

- **Node 22.12 or newer is now required** (was 22.0). `commander` 15 declares
  the same floor, and 22.12.0 is where Node 22 entered LTS, so everything
  earlier in that line is already unsupported upstream. If you are on 22.0-22.11
  you are on a Node release that receives no fixes.
- `commander` 12 -> 15, `dotenv` 16 -> 18.
- dotenv 17 began announcing itself on every load. It is silenced, so the only
  thing this tool writes is its own output. `--json` was never affected.

### Security

None of the following changes what the tool does. All of it changes how much
you have to take on trust, which for something you point at production
credentials is the more useful thing to be able to check.

- **The release pipeline no longer holds write permissions it does not need.**
  The workflow that publishes had `contents`, `id-token` and `issues` write at
  the top level, so any job that file gained would have inherited the ability to
  publish. Every workflow now floors at read, and the single job that publishes
  asks for the rest itself.
- **Workflows are audited by [zizmor](https://docs.zizmor.sh) as a required
  check.** It found three things nothing else here looks for: five checkout
  steps leaving the job's token in `.git/config`, the release job restoring a
  cache that lower-privilege workflows can write to, and no Dependabot cooldown.
- **Dependabot now waits 7 days** (14 for majors) before proposing a version.
  Malicious releases are usually yanked within a day or two, so most are gone
  before they reach a pull request.
- **CI runners are monitored for outbound network traffic.** Every other check
  reads code; a dependency that only misbehaves while it runs is invisible to
  all of them, and that is the shape recent npm compromises have taken.
- **The release job no longer installs its own package manager.** It ran
  `npm install -g npm@latest` because Node 22 ships an npm too old for trusted
  publishing. Node 24 ships a new enough one, so the step is gone, along with an
  unreviewed input to the job holding the publishing identity.
- **[OpenSSF Scorecard](https://github.com/Het101/threadvault/security/code-scanning)
  and Dependency Review** run on every push and pull request. The Scorecard
  findings that remain open are listed in SECURITY.md with the reason each one
  is accepted, rather than left for you to wonder about.

### Internal

- Test coverage is measured and floored in CI, so it cannot quietly fall. Three
  of the six defects found in the September audit were in paths nothing
  exercised, and the suite was green throughout.
- A malformed workflow file fails the run *before any job exists*, so required
  checks never report and a pull request looks ready to merge. Staged workflow
  YAML is now parsed in `pre-commit`.

## [0.3.1] - 2026-09-25

### Security

- **No install script in the published package.** The only shell-out anywhere
  here was a `prepare` script pointing git at `.githooks`; `src/` never touches
  `child_process` and the bundle contains none. It did nothing for anyone
  installing the tool — `prepare` does not run on a registry install — so every
  consumer carried an install-time `execSync` in the manifest, which is the
  shape a supply-chain scanner flags first, and none of the benefit. Hook setup
  is now `npm run hooks`, run once. CI already enforces the same rules.

### Performance

- **The Azure SDK loads only when a command needs it.** Every invocation used to
  import it, and `pg`, through a static chain — including commands that touch no
  network. Against a 163 ms bare-node floor:

  | | before | after |
  | --- | --- | --- |
  | `--help` | 540 ms | 127 ms |
  | `--version` | 1055 ms | 146 ms |
  | `migrate plan --from-jsonl` | 818 ms | 181 ms |

  The build now emits chunks rather than one file. Bundling to a single file
  resolved every `import()` at build time and hoisted it back to a static
  import, so making the source lazy changed nothing until splitting was on.

## [0.3.0] - 2026-09-25

A functional audit of every command, and the four defects it found. Each one
sat in a path the tests exercised only with data that happened to avoid it.

### Fixed

- **Replayed identities were keyed on the ACS id, not on your UUID.** The first
  rule of this tool is that your UUID is the identifier and the ACS identity is
  disposable; `migrate apply` did the opposite. Anyone re-minted at some point
  carried two historical ACS ids and arrived on the new resource as two
  different people. Worse, `sourcePostgres` deliberately emits a null
  `senderAcsId`, so a mirror replay resolving senders by ACS id found nobody and
  sent every message as the migrator — the wrong-author defect, reproduced by
  our own Postgres path, on the workflow the README recommends.
- **`doctor` reported a scan that never happened as clean.** `acsScanned` was
  set whenever a walk was requested, including when no identity on record
  belonged to the resource and nothing was read. With threads in the mirror,
  check 5 then reported every one of them as missing from ACS, having never
  asked; with an empty mirror it printed `clean — no findings` and exited 0. A
  run that could not look now says so and exits 2.
- **Nothing ever wrote `threadvault_identities`.** The table was read by the
  mirror and by `doctor`, and populated by nothing, so the mirror could never
  map an ACS id back to a person and `doctor` had nobody to check without a
  `threadvault.yml` mapping. `mirror backfill` now records each participant's
  identity, taking the resource GUID from the ACS id.
- **A second backfill could not repair attribution.** The message upsert
  refreshed content and the edit and delete stamps only, so a mirror taken
  before identities were known kept its null `sender_user_id` forever. Repair is
  the reason to run it twice.

### Changed

- **Breaking, in practice only for an unused file:** a `--state` ledger written
  by an earlier version keys identities on ACS ids and will not match. Delete it
  and let the next run rebuild, or the replay will mint a second set. No
  published version has successfully completed a real replay, so this is
  expected to affect nobody.
- `mirror backfill` reports an identities count alongside threads, participants
  and messages.

## [0.2.4] - 2026-09-24

Documentation only, but the README is a shipped artifact: npm snapshots it at
publish time, so a correction to it needs a release to reach anyone.

### Documentation

- `doctor` and `migrate verify` were listed as writing nothing at all. Both mint
  a throwaway ACS identity and delete it, because ACS offers no other way to
  learn which resource a connection string belongs to. Neither reads a message
  or touches a thread, participant or message — but "No — read-only" was flatly
  untrue, and anyone in a regulated environment who checked would have been
  right to stop trusting the rest of the table. It now says what happens, with a
  note on why it is unavoidable and that `doctor --no-acs` skips ACS entirely.

## [0.2.3] - 2026-09-24

Both fixes below were found by the first people other than the author to run
this. Neither was reachable from the tests, because both were about what
happens when you hold it wrong.

### Fixed

- **`migrate rehearse` wrote to ACS without checking the resource.** It creates
  a thread, adds participants, sends messages and deletes a thread, and it
  checked neither `ACS_EXPECT_RESOURCE` nor the probed GUID — while the README,
  `SECURITY.md` and the agent notes all stated that guard covers *any* ACS
  write. The one command whose purpose is "try this safely first" was the one
  that would happily do it against production. It now takes the same guard as
  `migrate apply`.
- **`probe` exited `0` after failing to probe.** The "could not read the GUID"
  branch came last, so a failed probe with `ACS_EXPECT_RESOURCE` unset printed
  `Target resource GUID is ?` and reported success. Anything scripting it would
  have concluded the resource was fine.
- **An unusable connection string now says why.** The Azure SDK answers
  `Invalid connection string <the string>`, which is true and useless. The
  actual cause is almost always a shell: an unquoted
  `export ACS_CONNECTION_STRING=endpoint=...;accesskey=...` ends at the `;` and
  drops the key silently. Checked before the SDK sees it, and named.

### Documentation

- A per-command table of which environment variables each command needs, and a
  troubleshooting section built from what has actually gone wrong for people:
  `npm threadvault` versus `npx threadvault`, the quoting trap, `INCONCLUSIVE`,
  and `Forbidden` on reply.
- `.env.example` listed `ACS_OLD_CONNECTION_STRING` and `THREADVAULT_STATE`.
  Nothing reads either; the replay ledger is a flag, not a variable. Every entry
  is now cross-checked against actual `process.env` usage.

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

[0.8.0]: https://github.com/Het101/threadvault/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Het101/threadvault/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Het101/threadvault/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Het101/threadvault/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Het101/threadvault/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Het101/threadvault/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Het101/threadvault/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/Het101/threadvault/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Het101/threadvault/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Het101/threadvault/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Het101/threadvault/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Het101/threadvault/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Het101/threadvault/releases/tag/v0.1.0
