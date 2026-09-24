# Threadvault

**Your Azure Communication Services chat resource should be disposable. Right now it isn't.**

[![CI](https://github.com/Het101/threadvault/actions/workflows/ci.yml/badge.svg)](https://github.com/Het101/threadvault/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

ACS gives you no history export, and every identity it mints is scoped to one resource — `8:acs:<resourceGuid>_<userGuid>`. Move, rotate, or lose that resource and every identity you stored turns to garbage in the same instant. The only way back is a full REST walk plus a replay you write yourself, under pressure, at the worst possible time.

Threadvault is that walk and that replay, already written, already survived.

```
   ACS resource (rented)                    Postgres (yours)
   ┌──────────────────┐                     ┌──────────────────────────┐
   │ threads          │  mirror backfill →  │ threadvault_threads      │
   │ participants     │                     │ threadvault_identities   │
   │ messages         │  ← migrate apply    │ threadvault_participants │
   └──────────────────┘                     │ threadvault_messages     │
      throwaway                             └──────────────────────────┘
                                                  source of truth
```

Mirror once and ACS becomes a cache. Every message lands in **your** database under **your** user IDs, with the **original** timestamps — so the day you need a new resource, you replay instead of negotiate.

---

> ### Born from a production incident
>
> A resource move replayed 7,200 threads with participants turned off. Two defects followed: 7,022 messages showed the wrong author, and every thread rejected replies with `CommunicationError Forbidden`. Both were repairable only because the extract had preserved `metadata.originalSenderUserId` and the participant lists.
>
> Every rule below is a scar from that week. `doctor` exists to find these five things before they find you.

---

## Install

Not on npm yet — install from source:

```bash
git clone https://github.com/Het101/threadvault.git
cd threadvault && npm install && npm run build
npm link                        # puts `threadvault` on your PATH
```

**Node 22 or newer.** The current Azure SDK will not install on 20.

## The 60-second version

```bash
export ACS_CONNECTION_STRING='endpoint=https://<resource>.communication.azure.com/;accesskey=<key>'
export DATABASE_URL='postgres://…'

threadvault probe                   # which resource am I even pointing at?
threadvault doctor                  # what is already broken?
threadvault mirror backfill --reader-acs-id 8:acs:… --commit
```

That's it. ACS is now disposable.

## Commands

| Command | What it does | Writes? |
|---|---|---|
| `probe` | Mints one throwaway identity to discover the resource GUID. Prints host + GUID, never the key. | No |
| `doctor` | Audits ACS + your database for the five failure modes below. | No — read-only |
| `mirror backfill` | Copies threads, participants, and messages into Postgres. | Only with `--commit` |
| `migrate extract` | Exports ACS chat history to a portable JSONL file. | No — read-only |
| `migrate plan` | Inspects a dump and flags every gap before you replay. | No — read-only |
| `migrate rehearse` | Writes one synthetic thread, asserts four durability goals, deletes it. | Yes (target resource) |
| `migrate apply` | Replays a dump onto a new ACS resource. | Only with `--commit` |

**Every write is a dry run until you pass `--commit`.** The dry run walks the entire source and reports exactly what the real run would do — it never opens a write path.

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
```

The schema is created for you (`threadvault_*` tables, `CREATE TABLE IF NOT EXISTS`). It does not touch your own tables.

Three properties the mirror guarantees, all of them learned the hard way:

- **`sender_user_id` is your UUID, never an ACS identity.** ACS identities die with the resource. Yours don't.
- **`sent_at` is the original timestamp.** ACS stamps its own `createdOn` on replay; the true value is preserved separately and always wins.
- **Re-running is a no-op.** Upserts key on `external_id` / `external_message_id`, and participants without a host mapping get a *derived* stand-in id — so a second pass updates rows instead of duplicating them.

## Migrating to a new resource

```bash
# 1. Export the old resource. Read-only.
threadvault migrate extract --out dump.jsonl --reader-acs-id 8:acs:…

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
threadvault migrate apply --from-jsonl dump.jsonl --identity-map identity-map.json
threadvault migrate apply --from-jsonl dump.jsonl --identity-map identity-map.json --commit
```

### Keep the identity map

`migrate apply` mints an identity on the new resource for every participant it replays. `--identity-map` is where that old-id → new-id mapping is written.

**It is the only link between the replayed threads and the people in them.** Lose it and you have a perfect copy of your chat history that nobody can open. Keep the file, back it up, and use it to update your own user rows. Pass the same path on a re-run and Threadvault reuses those identities instead of minting a second, rival set.

The map is also written if the replay crashes halfway — identities minted before the failure are real, and the resumed run must reuse them.

## Safety model

| Guarantee | How |
|---|---|
| **Dry run by default** | Every writing command needs `--commit`. The dry run never opens a write connection. |
| **Resource GUID guard** | `ACS_EXPECT_RESOURCE` is required for any ACS write. The command probes the target and refuses on mismatch. |
| **Participants always restored** | There is no flag to skip them. Both production defects came from skipping them. |
| **PHI-safe logging** | `content` / `text` / `html` / `body` are stripped before anything is printed, `--json` output included. `doctor` discards message bodies at the SDK boundary and never reads them at all. A test fails the build if any source file writes to stdout without going through the redacting logger. |
| **Secrets never printed** | ACS access keys and Postgres URL passwords are redacted from every log line, including error messages. |
| **Read-only connections** | `doctor` opens Postgres with `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`. |
| **Verified TLS** | Remote Postgres connections verify the server certificate by default. |

## Configuration

| Variable | Required for | Purpose |
|---|---|---|
| `ACS_CONNECTION_STRING` | everything touching ACS | The resource to read or write. `ACS_NEW_CONNECTION_STRING` and `AZURE_COMMUNICATION_CONNECTION_STRING` also work. |
| `ACS_EXPECT_RESOURCE` | **any ACS write** | The resource GUID you intend to write to. Threadvault refuses if the probed GUID differs. Get it from `probe`. |
| `DATABASE_URL` | Postgres commands | Standard Postgres URL. |
| `ACS_RETRY_ATTEMPTS` | optional (8) | Retries through ACS throttling. `retry-after` is honoured when ACS sends it. Permission and not-found errors fail immediately — backing off on a `403` only wastes time. |
| `PG_SSL_NO_VERIFY` | optional (false) | Escape hatch for a private CA. Leave it off. |
| `PG_HOST_OVERRIDE` | optional | `host=address` pairs, comma-separated, for pinned DNS. |

See [`.env.example`](.env.example).

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

## License

Apache-2.0. See [LICENSE](LICENSE).
