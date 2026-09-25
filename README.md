# Threadvault

<p align="center">
  <img src="https://raw.githubusercontent.com/Het101/threadvault/main/docs/assets/hero.png" alt="Threadvault — protect your ACS chat history. Mirror, migrate and recover Azure Communication Services chat into your own PostgreSQL database." width="820">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/threadvault"><img alt="npm" src="https://img.shields.io/npm/v/threadvault?style=flat-square&labelColor=161B22&color=6D3BEB&logo=npm&logoColor=white"></a>
  <a href="https://github.com/Het101/threadvault/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/Het101/threadvault/ci.yml?branch=main&style=flat-square&labelColor=161B22&label=ci&logo=githubactions&logoColor=white"></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/node/v/threadvault?style=flat-square&labelColor=161B22&color=6D3BEB&logo=nodedotjs&logoColor=white"></a>
  <a href="https://github.com/Het101/threadvault/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/threadvault?style=flat-square&labelColor=161B22&color=6D3BEB"></a>
</p>

**Your Azure Communication Services chat resource should be disposable. Right now it isn't.**


ACS gives you no history export, and every identity it mints is scoped to one resource — `8:acs:<resourceGuid>_<userGuid>`. Move, rotate, or lose that resource and every identity you stored turns to garbage in the same instant. The only way back is a full REST walk plus a replay you write yourself, under pressure, at the worst possible time.

Threadvault is that walk and that replay, already written, already survived.

<p align="center">
  <img src="https://raw.githubusercontent.com/Het101/threadvault/main/docs/assets/data-flow.png" alt="Azure Communication Services chat flowing into your own PostgreSQL database" width="760">
</p>

Mirror once and ACS becomes a cache. Every message lands in **your** database under **your** user IDs, with the **original** timestamps — so the day you need a new resource, you replay instead of negotiate.

<p align="center">
  <img src="https://raw.githubusercontent.com/Het101/threadvault/main/docs/assets/without-with.png" alt="Without Threadvault, moving the resource makes every stored identity garbage. With Threadvault, you replay from your own Postgres." width="760">
</p>

---

> ### Born from a production incident
>
> A resource move replayed 7,200 threads with participants turned off. Two defects followed: 7,022 messages showed the wrong author, and every thread rejected replies with `CommunicationError Forbidden`. Both were repairable only because the extract had preserved `metadata.originalSenderUserId` and the participant lists.
>
> Every rule below is a scar from that week. `doctor` exists to find these five things before they find you.
>
> **The full write-up, including what we got wrong and what to do if it is happening to you right now: [post-mortem](docs/postmortem-acs-chat-migration.md).**

---

## Install

Nothing to install — `doctor` never reads or changes a message, so it is safe to point at a resource and see what it says:

```bash
npx threadvault doctor
```

<p align="center">
  <img src="https://raw.githubusercontent.com/Het101/threadvault/main/docs/assets/doctor-output.png" alt="threadvault doctor output: five named checks, four clean, one reporting a thread whose only participant is the system identity" width="760">
</p>

Or keep it around:

```bash
npm install -g threadvault
threadvault doctor
```

`npx threadvault`, not `npm threadvault` — the latter is not an npm subcommand,
so npm ignores the word and answers about itself. `npm threadvault --version`
prints *npm's* version, which looks like an answer and is not one.

**Node 22.12 or newer.** The current Azure SDK will not install on 20, and `commander` requires 22.12 — which is where Node 22 entered LTS, so anything earlier in the 22 line is already unsupported upstream.

Published with [npm provenance](https://www.npmjs.com/package/threadvault), so you can verify the package was built by CI from this repository rather than uploaded by hand.

## The 60-second version

```bash
export ACS_CONNECTION_STRING='endpoint=https://<resource>.communication.azure.com/;accesskey=<key>'
export DATABASE_URL='postgres://…'

npx threadvault probe               # which resource am I even pointing at?
npx threadvault doctor              # what is already broken?
npx threadvault mirror backfill --reader-acs-id 8:acs:… --commit
```

That's it. ACS is now disposable.

## Commands

| Command | What it does | Writes? |
|---|---|---|
| `probe` | Mints one throwaway identity to discover the resource GUID. Prints host + GUID, never the key. | Not your data. Mints and deletes one throwaway identity\* |
| `doctor` | Audits ACS + your database for the five failure modes below. | Not your data. Mints and deletes one throwaway identity\* |
| `mirror backfill` | Copies threads, participants, and messages into Postgres. | Only with `--commit` |
| `migrate extract` | Exports ACS chat history to a portable JSONL file. | No — read-only |
| `migrate plan` | Inspects a dump and flags every gap before you replay. | No — read-only |
| `migrate rehearse` | Writes one synthetic thread, asserts four durability goals, deletes it. | Yes (target resource) |
| `migrate apply` | Replays a dump onto a new ACS resource. Resumable. | Your data: only with `--commit`. Probes the target either way\* |
| `migrate verify` | Reads the replayed estate back and proves it matches the source. | Not your data. Mints and deletes one reader unless `--reader-acs-id` is given\* |

**Every write is a dry run until you pass `--commit`.** The dry run walks the entire source and reports exactly what the real run would do — it never opens a write path.

\* ACS offers no way to ask which resource a connection string belongs to. The only way to find out is to mint an identity and read the GUID out of it. So `probe`, `doctor`, `verify` and `apply` each create one and delete it immediately — `apply` does this even on a dry run, because confirming you are pointed at the intended resource is the whole point of the guard.

Nothing else is touched by any of them: no thread, message or participant is created, changed or removed, and no message body is ever read. `doctor --no-acs` does not contact ACS at all, and `migrate plan` never does.

## The five failure modes `doctor` catches

Each of these has cost somebody a weekend. `doctor` finds all five in seconds, without reading a single message body.

| # | Failure | Symptom you'd otherwise debug blind |
|---|---|---|
| 1 | **Stale identities** | A stored `acsUserId` belongs to a different resource GUID. Your app treats it as valid; ACS rejects it. |
| 2 | **System-only threads** | The only participant is the system identity, so nobody can reply. `CommunicationError Forbidden`. |
| 3 | **Misattributed messages** | ACS says the sender is the system, but the metadata names a real person. Every message shows the wrong author. |
| 4 | **Missing system identity** | No system-user identity on this resource. History is unrecoverable until one is minted. |
| 5 | **Split-brain threads** | A thread exists in ACS with no database row, or a row points at a thread that isn't there. |

```console
$ threadvault doctor
threadvault doctor
  resource  aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  endpoint  example.communication.azure.com

  [1] stale-identities         649
  [2] system-only-threads      7200
  [3] misattributed-messages   7022
  [4] missing-system-identity  ok
  [5] split-brain-threads      ok

  - (1) user 4f3c… holds an identity that does not belong to resource aaaaaaaa-…
  - (2) thread 19:… has only the system identity as a participant — nobody else can reply
  … 14869 more (pass --json for the full list)
```

Exit codes: **0** clean · **1** findings · **2** could not run. Wire it into CI or a cron alert.

```bash
threadvault doctor --json          # pipe to jq, dashboards, alerting
threadvault doctor --no-acs        # database-only checks when ACS is unreachable
threadvault doctor --concurrency 8 # widen the ACS walk
```

## Mirroring into Postgres

```bash
threadvault mirror backfill --reader-acs-id 8:acs:…            # dry run: counts, writes nothing
threadvault mirror backfill --reader-acs-id 8:acs:… --commit   # for real
threadvault mirror backfill --reader-acs-id 8:acs:… --to-jsonl dump.jsonl
threadvault mirror backfill --reader-acs-id 8:acs:… --concurrency 8 --commit
```

`--concurrency` (default 4) is how many threads are walked at once. Overlapping request latency rather than waiting out each round trip is roughly the difference between 2 and 25 ACS operations per second, which on a real estate is the difference between an afternoon and a coffee. Messages *inside* a thread always stay serial — ACS assigns `sequenceId` on receipt, so ordering them concurrently would scramble the thread.

The schema is created for you (`threadvault_*` tables, `CREATE TABLE IF NOT EXISTS`). It does not touch your own tables.

It also records who each participant is, in `threadvault_identities`, keyed on
your user ID and the resource GUID taken from the ACS id. That is what lets a
second run recognise people it has already seen, and what gives `doctor`
somebody to check when you have no `threadvault.yml` mapping.

Three properties the mirror guarantees, all of them learned the hard way:

- **`sender_user_id` is your UUID, never an ACS identity.** ACS identities die with the resource. Yours don't.
- **`sent_at` is the original timestamp.** ACS stamps its own `createdOn` on replay; the true value is preserved separately and always wins.
- **Re-running is a no-op.** Upserts key on `external_id` / `external_message_id`, and participants without a host mapping get a *derived* stand-in id — so a second pass updates rows instead of duplicating them.

## Migrating to a new resource

```bash
# 1. Export the old resource. Read-only.
threadvault migrate extract --out dump.jsonl --reader-acs-id 8:acs:… --concurrency 8

# 2. Read the dump before you trust it.
threadvault migrate plan --from-jsonl dump.jsonl
```

```console
threads:                           7200
participants:                      15843
messages:                          41207
  of those, ACS control messages:  2104
  replayable by apply:             39103
unique ACS identities:             1962
messages missing original sender:  0
messages missing original time:    0
resource GUIDs in dump:            aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
```

`plan` is the step people skip. Don't. `messages missing original sender` above zero means that many messages will land on the new resource with no recoverable author — and you will not notice until someone opens a thread.

```bash
# 3. Rehearse on a throwaway resource first.
threadvault migrate rehearse \
  --system-acs-id 8:acs:… \
  --non-system-acs-id 8:acs:… \
  --non-system-our-user-id <uuid>

# 4. Replay for real.
export ACS_EXPECT_RESOURCE='<new-resource-guid>'
threadvault migrate apply --from-jsonl dump.jsonl --state replay.jsonl
threadvault migrate apply --from-jsonl dump.jsonl --state replay.jsonl --commit
```

### Keep the replay ledger

`--state` is an append-only JSONL record of everything the replay has done: every identity minted on the new resource, and how far each thread got. It does two jobs, and both of them are the difference between a migration and an incident.

**It is the only link between the replayed threads and the people in them.** `migrate apply` mints an identity on the new resource for every participant. Lose that mapping and you have a byte-perfect copy of your chat history that nobody — not even the system user — can open.

**It makes the replay resumable.** A replay of a real estate takes a while, and ACS throttles. If the run dies at thread 5,000 of 7,200, re-running *without* a ledger creates 5,000 duplicate threads on the target, and cleaning that up means deleting threads by hand. With one, the re-run skips finished threads entirely and picks a half-delivered thread back up at the message it reached:

```console
$ threadvault migrate apply --from-jsonl dump.jsonl --state replay.jsonl --commit
Resuming from replay.jsonl: 1962 identit(ies), 4981 thread(s) already replayed
Skipping thread 19:… — already replayed
Flushing thread 19:… to target 19:… (resuming after 3 message(s))
```

Run the dry run with the same `--state` first and it will tell you exactly how much is left rather than how much there is.

It is append-only on purpose: rewriting a whole state file after every thread is O(n) per thread and O(n²) over an estate, and a crash that truncates the last line costs one record instead of the whole ledger.

Back the file up, and use it to update your own user rows once the replay lands.

### Prove it worked

`apply` reports what it sent. `verify` reports what actually arrived, which is the only number worth trusting after a migration:

```bash
export ACS_CONNECTION_STRING='…'   # the NEW resource
threadvault migrate verify --from-jsonl dump.jsonl --state replay.jsonl
```

```console
threadvault migrate verify

  threads in source   7200
  verified clean      7199

  never-replayed       ok
  incomplete           ok
  unreadable           ok
  message-count        1
  participant-count    ok
  unattributed         ok
  untimed              ok

  - (message-count) thread 19:…: source has 14 message(s), target has 13
```

It walks the replayed threads and compares message counts, participant counts, and whether every replayed message still carries a recoverable author and original timestamp. ACS control messages are excluded — the resource emits those itself, and counting them would make a correct replay look wrong.

Read-only, and never reads a message body: every check runs on counts and metadata. Exit code `0` if the estate matches, `1` if it does not, so it can gate a cutover.

**The full migration is then:** `extract` → `plan` → `rehearse` → `apply` → `verify`. Nothing in that chain asks you to trust it.

## Safety model

| Guarantee | How |
|---|---|
| **Dry run by default** | Every writing command needs `--commit`. The dry run never opens a write connection. |
| **Resumable replay** | With `--state`, an interrupted `migrate apply` resumes instead of duplicating the estate. Progress is recorded as it happens, not at the end. |
| **One bad thread is not a failed run** | A thread that cannot be read is reported and skipped, with a count at the end. An extract over thousands of threads does not end on one of them. |
| **Resource GUID guard** | `ACS_EXPECT_RESOURCE` is required for any ACS write. The command probes the target and refuses on mismatch. |
| **Participants always restored** | There is no flag to skip them. Both production defects came from skipping them. |
| **PHI-safe logging** | `content` / `text` / `html` / `body` are stripped before anything is printed, `--json` output included. `doctor` discards message bodies at the SDK boundary and never reads them at all. A test fails the build if any source file writes to stdout without going through the redacting logger. |
| **Secrets never printed** | ACS access keys and Postgres URL passwords are redacted from every log line, including error messages. |
| **Read-only connections** | `doctor` opens Postgres with `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`. |
| **Verified TLS** | Remote Postgres connections verify the server certificate by default. |

## Configuration

### Setting the connection string

```bash
export ACS_CONNECTION_STRING='endpoint=https://<resource>.communication.azure.com/;accesskey=<key>'
```

**The quotes are not optional.** Without them your shell ends the command at the
`;`, the variable holds only the endpoint, and the key disappears with no
warning — you get `Invalid connection string` and no clue why. It is the most
common way to lose an hour with this tool, so `probe` now detects it and says
so. On Windows PowerShell:

```powershell
$env:ACS_CONNECTION_STRING = 'endpoint=https://<resource>.communication.azure.com/;accesskey=<key>'
```

A `.env` file in the working directory is read automatically and needs no
quoting. Copy [`.env.example`](https://github.com/Het101/threadvault/blob/main/.env.example) to `.env` to start.

### What each command needs

| Command | `ACS_CONNECTION_STRING` | `ACS_EXPECT_RESOURCE` | `DATABASE_URL` | Also |
|---|---|---|---|---|
| `probe` | **required** | optional — compared if set | — | — |
| `doctor` | required unless `--no-acs` | required with `--no-acs` | optional; without it, only what ACS lists | `threadvault.yml` to read your own tables |
| `mirror backfill` | required unless `--from-jsonl` | — | required with `--commit` | `--reader-acs-id`, or `--to-jsonl` to skip Postgres |
| `migrate extract` | **required** | — | — | `--reader-acs-id`, `--out` |
| `migrate plan` | — | optional — enables the stale-identity count | required with `--from-mirror` | `--from-jsonl` or `--from-mirror` |
| `migrate rehearse` | **required** | **required** — it writes | — | `--system-acs-id`, `--non-system-acs-id`, `--non-system-our-user-id` |
| `migrate apply` | **required** | **required** — it writes | required with `--from-mirror` | `--state`, and `--commit` to write |
| `migrate verify` | **required** (the *new* resource) | — | required with `--from-mirror` | `--state` |

`migrate plan` needs nothing at all to inspect a JSONL dump, which is why it is
the safe first thing to run on an extract from someone else's machine.

### Every variable

| Variable | Default | Purpose |
|---|---|---|
| `ACS_CONNECTION_STRING` | — | The resource to read or write. `ACS_NEW_CONNECTION_STRING` and `AZURE_COMMUNICATION_CONNECTION_STRING` are also accepted, in that order of preference. |
| `ACS_EXPECT_RESOURCE` | — | The resource GUID you intend to write to. Every ACS write refuses without it, probes the target, and refuses again if the GUID differs. Get it from `probe`. |
| `DATABASE_URL` | — | Standard Postgres URL. `doctor` opens it read-only. |
| `ACS_RETRY_ATTEMPTS` | `8` | Retries through ACS throttling; `retry-after` is honoured when ACS sends it. Permission and not-found errors fail at once rather than backing off through a schedule that cannot succeed. |
| `PG_SSL_NO_VERIFY` | `false` | Skips TLS certificate verification for remote Postgres. An escape hatch for a private CA. Leave it off — that connection carries credentials and message bodies. |
| `PG_HOST_OVERRIDE` | — | `host=address` pairs, comma-separated, for pinned DNS. |
| `PG_CONNECT_ATTEMPTS` | `5` | Connection retries, with backoff. |

Threadvault never prints the value of any of these. Access keys and database
passwords are stripped from every log line, error message and `--json` payload.

### Flags worth knowing

- `--commit` — every writing command is a dry run without it.
- `--state <path>` on `migrate apply` and `migrate verify` — the replay ledger.
  Not required, but committing without it warns, and it should.
- `--concurrency <n>` on `migrate extract` and `mirror backfill` — threads walked
  at once, default 4.
- `--json` on `doctor`, `migrate plan` and `migrate verify` — same data, machine
  readable, same redaction.


### Reading your own tables

`doctor` can audit your app's existing schema before you have mirrored anything — no migrations, no schema changes. Drop a `threadvault.yml` next to where you run it:

```yaml
host:
  usersTable: UserDetails
  usersIdColumn: user_id
  usersAcsIdColumn: acsUserId
  usersSystemColumn: isSystemUser
  threadsTable: ChatThread
  threadsIdColumn: id
  threadsExternalIdColumn: externalId
  participantsTable: ChatParticipant
  participantsThreadColumn: threadId
  participantsUserColumn: userId
```

Every value is validated as a bare SQL identifier and quoted. They are never interpolated as SQL.

## Troubleshooting

Everything here has happened to a real person.

### `npm threadvault --version` prints something like `10.8.2`

That is npm's version, not Threadvault's. `threadvault` is not an npm
subcommand, so npm ignores it and answers `--version` about itself. Use:

```bash
npx threadvault --version        # without installing
threadvault --version            # if installed globally
```

### `Invalid connection string`, or `no accesskey= in the connection string`

Your shell ate the key. This:

```bash
export ACS_CONNECTION_STRING=endpoint=https://x.communication.azure.com/;accesskey=abc123
```

ends the command at the `;`, so the variable holds only the endpoint and
`accesskey=abc123` is run as a separate command. Quote it:

```bash
export ACS_CONNECTION_STRING='endpoint=https://x.communication.azure.com/;accesskey=abc123'
```

A `.env` file needs no quoting, which is why it is the less error-prone option.

### `INCONCLUSIVE: could not read the resource GUID`

`probe` could not mint an identity, so it does not know which resource you are
pointed at and will not guess. The line above it says why — usually the
connection string above, or a key without `Contributor` on the ACS resource.
It exits `2`; it does not exit `0` and shrug.

### `CommunicationError Forbidden` when replying to a thread

The user is not a participant of that thread on the ACS resource, which is what
a replay that skipped participants leaves behind. `doctor` reports it as
`system-only-threads`. The [post-mortem](https://github.com/Het101/threadvault/blob/main/docs/postmortem-acs-chat-migration.md)
covers what to do about it.

### `migrate apply` refuses to start

It requires `ACS_EXPECT_RESOURCE`, probes the target, and refuses if the GUID
differs. That is deliberate: it is the check that stops a replay landing on the
wrong resource. `migrate rehearse` requires it too, for the same reason.

### Exit codes

`0` clean · `1` findings, or a mismatch · `2` could not run. Safe to gate a
deploy on.

## Design rules

These aren't style preferences — each one is a bug that reached production.

- **An ACS identity is never an identifier you store as truth.** It is resource-scoped and temporary. Your UUID is the identifier.
- **`metadata.originalSenderUserId` is the only attribution read path.** `originalSenderAcsId` is written for forensics and never read back — it names an identity on a resource that may not exist.
- **The original timestamp travels in metadata.** ACS cannot backdate `createdOn`.
- **An identity that belongs to another resource is exactly as broken as no identity.** Code that only re-mints on *empty* is how 649 stale identities became permanent.
- **Messages inside a thread stay serial.** ACS assigns `sequenceId` on receipt. Concurrency goes across threads, never within one.

## Development

```bash
npm install
npm run dev -- doctor     # tsx, no build step
npm test                  # vitest
npm run typecheck
npm run build             # tsup → dist/
```

Test fixtures are synthetic — lorem text, never real names, never clinical content. Message bodies never appear in tests, logs, or issues.

## Contributing

Issues and pull requests welcome. Please don't include real chat content, connection strings, or resource GUIDs from a live tenant in a bug report — a redacted `doctor --json` is almost always enough.

## Project

| | |
|---|---|
| [Troubleshooting](#troubleshooting) | The things that have actually gone wrong for people |
| [First real run](https://github.com/Het101/threadvault/blob/main/docs/first-real-run.md) | Pointing it at an actual ACS resource for the first time, one safe stage at a time |
| [CONTRIBUTING.md](https://github.com/Het101/threadvault/blob/main/CONTRIBUTING.md) | How to build it, the rules a PR is held to, and why each one exists |
| [SECURITY.md](https://github.com/Het101/threadvault/blob/main/SECURITY.md) | How to report a vulnerability, and the guarantees the code is built to keep |
| [CHANGELOG.md](https://github.com/Het101/threadvault/blob/main/CHANGELOG.md) | What changed, including the breaking bits |
| [ROADMAP.md](https://github.com/Het101/threadvault/blob/main/ROADMAP.md) | Where it is going, and what it will deliberately not do |
| [Post-mortem](https://github.com/Het101/threadvault/blob/main/docs/postmortem-acs-chat-migration.md) | The incident that produced this tool, in full |
| [CODE_OF_CONDUCT.md](https://github.com/Het101/threadvault/blob/main/CODE_OF_CONDUCT.md) | How we behave here |

Threadvault is pre-1.0. The commands and their guarantees are stable; flags may still move, and anything that does will be called out in the changelog.

## License

Apache-2.0. See [LICENSE](https://github.com/Het101/threadvault/blob/main/LICENSE).
