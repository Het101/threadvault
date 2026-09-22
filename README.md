# threadvault

Mirror [Azure Communication Services](https://learn.microsoft.com/en-us/azure/communication-services/) chat into Postgres so the ACS resource is disposable.

ACS identities are resource-scoped (`8:acs:<resourceGuid>_<userGuid>`). ACS has no history export. When the resource changes, every stored identity is garbage and the only recovery path is a REST walk plus replay. Threadvault is that walk, pointed at *your* database, with *your* user ids.

```
npx threadvault doctor              # read-only audit — start here
npx threadvault probe               # which resource does this connection string hit?
npx threadvault mirror backfill     # ACS → Postgres
npx threadvault migrate rehearse    # synthetic thread assertion test
```

Status: **0.1.0 — `doctor`, `probe`, `mirror backfill`, and `migrate rehearse` ship.**

## Why this exists

A production ACS resource move that replayed 7,200 threads with participants left off produced two defects from one flag:

1. Every replayed message was sent as the system identity, so a read path that compared ACS ids displayed the wrong author.
2. ACS requires the sender to be a thread participant. Replayed threads had exactly one — the system identity — so nobody could reply (`CommunicationError Forbidden`).

Both were repairable only because the extract had written `metadata.originalSenderUserId` and kept the participant lists. The structural cause: chat history lived only inside a vendor that cannot export it. Email in the same product had its own table and would have survived untouched.

`doctor` looks for those five failure modes before they bite anyone else.

## Install

Node **20+**. Node 18 is unsupported — `globalThis.crypto.randomUUID` is missing and the Azure SDK throws.

```bash
npm install -g threadvault
# or
npx threadvault doctor --help
```

## `doctor`

Read-only. Talks to ACS and optionally Postgres. Writes nothing. Postgres connections are opened with `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`.

| # | Check | What it means |
|---|---|---|
| 1 | Stale identities | A stored `acsUserId` belongs to a different resource GUID. The app will treat it as valid; ACS will reject it; a remint-on-empty path will never fire. |
| 2 | System-only threads | The only ACS participant is the system identity. Nobody else can reply. |
| 3 | Misattributed messages | ACS sender is the system identity, but `metadata.originalSenderUserId` names a real user. |
| 4 | Missing system identity | No system-user ACS identity on this resource. History is unrecoverable without it. |
| 5 | Split-brain threads | A thread exists on ACS with no database row, or a row whose `externalId` is missing from ACS. |

```bash
export ACS_CONNECTION_STRING='endpoint=https://<resource>.communication.azure.com/;accesskey=<key>'
export ACS_EXPECT_RESOURCE='<resource-guid>'          # from `threadvault probe`
export DATABASE_URL='postgres://…'
cp threadvault.example.yml threadvault.yml            # map your User / Thread tables

npx threadvault doctor
npx threadvault doctor --json
npx threadvault doctor --no-acs                       # database checks only
```

Exit codes: `0` clean, `1` findings, `2` could not run.

`threadvault.yml` lets doctor read an existing app (the mapping below is Wizlo's schema). Without it, doctor reads `threadvault_*` tables if they exist, plus ACS.

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

## `probe`

Mints one identity, reads the resource GUID, deletes the identity. Prints host + GUID. Never prints the access key.

```bash
npx threadvault probe
```

If both sides of a comparison fail they both read `-`, which compares equal. Probe treats unknown GUIDs as **inconclusive**, never as a match.

## PHI

Chat message bodies are protected health information in any healthcare deployment. Threadvault never logs `content` / `text` / `html` / `body`. Do not put message bodies in issues, fixtures, or commit messages.

## `mirror backfill`

Takes an Azure Communication Services thread resource and mirrors the threads, messages, and participants into a local Postgres database. Uses SQL `ON CONFLICT DO UPDATE` so you can resume mid-run and keep up with a live stream.

```bash
export DATABASE_URL='postgres://...'
npx threadvault mirror backfill --commit
```

*Note: You can `--to-jsonl` and `--from-jsonl` to snapshot the dataset outside the DB.*

## `migrate rehearse`

Rehearses the migration assertions by simulating a thread interaction with synthetic operations, validating 4 specific attributes for durability (timestamps, original senders, replying capabilities, and participant parity):

```bash
npx threadvault migrate rehearse --system-acs-id 8:acs:... --non-system-acs-id 8:acs:... --non-system-our-user-id u-123
```

## Writes

- Dry-run unless `--commit`.
- `ACS_EXPECT_RESOURCE` is **required** for any ACS write. The command refuses if the target GUID does not match.
- Participants are **always** restored. There is no `--participants` flag.

## License

Apache-2.0. See [LICENSE](LICENSE).
