# Your first run against a real ACS resource

Everything up to stage 5 is **read-only**. Nothing in this document writes to
ACS until stage 6, and stage 6 needs a resource you are willing to throw away.

Use a dev or test resource if you have one. If the only resource you have is
production, stages 1-5 are still open to you: use `--no-bodies` at
[stage 4](#4-extract) and no message text is read at all. Stage 6 needs a
separate, empty resource either way. Read
[SECURITY.md](../SECURITY.md#running-it-safely) first.

## What you need

| | |
|---|---|
| The resource's connection string | Azure Portal → your Communication Services resource → **Keys** → *Connection string* |
| One ACS identity that is a participant in the threads | See [stage 3](#3-find-a-reader-identity) — ACS has no API that lists identities, so this has to come from your application |
| Node 22.12 or newer | `node -v` |

## 0. Put the connection string somewhere it cannot leak

Create `.env` in the repo root — it is already in `.gitignore`:

```
ACS_CONNECTION_STRING="endpoint=https://your-resource.communication.azure.com/;accesskey=..."
```

**Keep the quotes.** Without them a shell treats the `;` as the end of the
command and the variable silently holds only the endpoint. The tool detects
this case and says so, but it is the single most common way a first run fails.

Never paste a connection string into a terminal you are sharing, a chat, or an
issue. It is a full-access key to the resource.

## 1. Probe

```bash
npx threadvault probe
```

This mints one throwaway identity, reads its resource GUID, and deletes it. It
prints the endpoint host and the GUID — never the key.

**Expect:** a host and a GUID.
**If it fails:** the message names the cause. Quoting is the usual one.

## 2. Pin the resource

Add the GUID from stage 1 to `.env`:

```
ACS_EXPECT_RESOURCE=00000000-0000-0000-0000-000000000000
```

Every command that writes to ACS refuses to run unless the target it probes
matches this. It is the reason a mistyped connection string cannot replay your
estate into the wrong resource — the two have to agree.

Set it now, even though nothing writes yet, so it is never the thing you forget
later.

## 3. Find a reader identity

ACS only lets a token list the threads **its own identity participates in**.
There is no administrative "list all threads" call and no API that enumerates
identities, so the reader has to come from your side.

Look in your application's database for the ACS identity of a user — typically
a system or bot account that was added to every thread. It looks like:

```
8:acs:<resource-guid>_<user-guid>
```

The resource GUID in the middle must match stage 1. An identity minted against
a different resource is not merely wrong, it is unusable.

> If you have the host database to hand, `threadvault doctor` finds the reader
> for you from your users table. `migrate extract` does not — it takes the
> identity explicitly, so that a read is always against an identity you chose.

## 4. Extract

```bash
npx threadvault migrate extract --out extract.jsonl --reader-acs-id "8:acs:..." --no-bodies
```

Read-only. Walks the threads that identity can see and writes one JSON object
per line. `*.jsonl` is in `.gitignore`.

### Decide about `--no-bodies` before you run this

This is the only command that writes message text to disk. Everything else here
works on counts, ids, timestamps and metadata: `doctor` discards bodies at the
SDK boundary before any caller can hold one, and `plan` and `verify` never read
them at all.

With `--no-bodies`, the extract carries every thread, participant, identity,
timestamp and attribution field and **no message text**. That is everything
stages 4 and 5 need, so you can run the whole analysis against a resource whose
contents are not allowed onto your laptop. `migrate apply` refuses such a dump,
in the dry run, before `--commit` is ever reached.

| | `--no-bodies` | full extract |
|---|---|---|
| `migrate plan` | yes | yes |
| `migrate verify` | yes | yes |
| `migrate apply` | **refused** | yes |
| Contains message text | no | **yes** |

**Use `--no-bodies` unless you are about to replay.** If the resource holds
anything regulated — patient messages, anything covered by an agreement with
the people who wrote it — a full extract moves that data somewhere new, and
that is a decision for whoever owns it, not a command-line default.

When you do take a full extract, treat the file exactly as you treat the
database it came from: no shared drives, no attachments on tickets, delete it
when you are done.

**Expect:** a count of threads, participants and messages. With `--no-bodies`
it also says so, so you cannot mistake the file for a replayable one later.
**If you get zero threads:** the reader identity is not a participant in
anything. That is stage 3, not a bug.

## 5. Plan

```bash
npx threadvault migrate plan --from-jsonl extract.jsonl
```

No network, no writes. This is the report worth reading slowly:

```
threads:                          42
participants:                     128
messages:                         3814
  of those, ACS control messages: 96
  replayable by apply:            3718
unique ACS identities:            57
messages missing original sender: 0
messages missing original time:   0
resource GUIDs in dump:           <one guid>
```

What each line is telling you:

- **replayable by apply** — control messages (*"X joined the thread"*) are
  generated by ACS and are not replayed. A gap here is expected, not loss.
- **messages missing original sender** — must be **0**. Anything else means
  those messages would arrive in the new resource attributed to whoever
  performed the replay. This is the defect the tool exists to prevent.
- **messages missing original time** — must be **0**. ACS stamps its own
  `createdOn` on replay and cannot backdate, so a missing original timestamp is
  a message that will land with today's date.
- **resource GUIDs in dump** — should be exactly one, and it should match
  stage 1. More than one means the extract spans resources.

Add `ACS_EXPECT_RESOURCE` for your *target* resource and `plan` also reports
**stale ACS ids** — identities that belong to the old resource and would be
garbage in the new one.

## 6. Rehearse (the first thing that writes)

Stages 1-5 prove the read path. Rehearse proves the write path, on **one
thread**, against a resource you are willing to delete afterwards.

Create a **second, empty** ACS resource for this. Do not rehearse into the
resource you extracted from.

Then swap both variables together:

```
ACS_CONNECTION_STRING="<the NEW resource's connection string>"
ACS_EXPECT_RESOURCE=<the NEW resource's GUID>
```

Both, or neither. If you change one and not the other the command refuses to
run — which is the guard working, not a failure.

```bash
npx threadvault migrate rehearse \
  --system-acs-id "8:acs:<new-guid>_..." \
  --non-system-acs-id "8:acs:<new-guid>_..." \
  --non-system-our-user-id "<your own UUID for that user>"
```

It creates one thread, adds both participants, sends a message as each, reads
them back, and checks the four things that matter: the thread exists, both
participants are on it, each message is attributed to the right person, and the
original timestamp survived in metadata. Then it deletes the thread unless you
pass `--keep`.

**If rehearse fails, stop.** A real `migrate apply` cannot do anything rehearse
could not.

## What to do with the result

If stages 1-6 all pass on a dev resource, the remaining unknown is scale, not
correctness. `migrate apply` is dry-run unless you pass `--commit`, and
`--state` makes it resumable, so the real run can be stopped and restarted
without duplicating anything.

Run `migrate verify` afterwards. It compares the two sides — message counts,
participants, attribution and timestamps — and is the only thing that tells you
the replay was faithful rather than merely finished.

## Things that will bite you

- **Do not rerun `extract` against a resource you have already replayed into.**
  You will extract the replay.
- **`--no-participants` exists and you should not use it.** It caused both of
  the production defects this tool was written to prevent: messages attributed
  to the wrong person, and a `Forbidden` the first time someone replies.
- **An identity from the wrong resource is as broken as no identity.** Code
  that only re-mints when the field is *empty* is how 649 stale identities
  became permanent somewhere else.
