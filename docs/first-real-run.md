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
threads:                          34
participants:                     124
messages:                         168
  of those, ACS control messages: 158
  replayable by apply:            10
unique ACS identities:            29
messages carrying our user id:    0 of 168
messages missing original time:   0
resource GUIDs in dump:           <one guid>
```

What each line is telling you:

- **replayable by apply** — control messages (*"X joined the thread"*, *"topic
  changed"*) are generated by ACS, carry no body, and are re-emitted naturally
  by the replay's own `createChatThread` and `addParticipants`. A large gap here
  is normal, not loss. In the run above, 158 of 168 messages were control
  messages and only 10 were real text.

- **messages carrying our user id** — read the note underneath it rather than
  the number.

  `0 of N` is **expected on a first extract**. That id lives in
  `metadata.originalSenderUserId`, which `migrate apply` writes during a replay.
  ACS does not store it, so a resource that has never been replayed has none.
  Plan says so in as many words.

  A **partial** count is the one to stop for. If some messages have it and
  others do not, attribution was lost for a subset, and replaying would attach
  those to whoever ran the replay. Plan prints a `WARNING` for that case and
  nothing reassuring.

  What `0 of N` costs you: a replay from this dump maps each old ACS id to one
  new identity, so attribution holds *within* the estate — the right people
  still appear to have said the right things. But those new identities are not
  linked to your application's users. If you need that link, extract through
  `mirror backfill`, which joins your own tables, rather than `migrate extract`,
  which can only see what ACS knows.

- **messages missing original time** — must be **0**. ACS stamps its own
  `createdOn` on replay and cannot backdate, so a missing original timestamp is
  a message that will land dated today.

- **resource GUIDs in dump** — should be exactly one, and it should match
  stage 1. More than one means the extract spans resources.

### Cross-check it against doctor

`doctor` and `plan` read the same estate by different routes, so their numbers
should agree. In the run above, doctor walked 34 ACS threads against 32 on
record and plan found 34 threads and 168 messages — the same totals, and the
difference of two is the two orphan threads doctor flagged.

If the two disagree about thread or message counts, stop: they are looking at
the same resource and one of them is wrong.

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
run — which is the guard working, not a failure. Run `probe` once after the
swap to confirm the two agree.

```bash
npx threadvault migrate rehearse --mint
```

### What `--mint` is for

Rehearse needs two ACS identities, and a brand-new resource has none. ACS only
creates identities through its API — there is no portal screen for it — so
without `--mint` you would have to write a script before you could run the
command whose entire purpose is to save you from writing scripts.

`--mint` creates the two it needs and removes them again at the end, including
when an assertion fails. If you already have identities in the target, pass
`--system-acs-id` and `--non-system-acs-id` instead; **identities you pass in
are never deleted**, only ones this run created.

### What it touches

It creates one thread, adds the two participants, sends a message as each,
reads them back, and then deletes that thread. Nothing else in the resource is
listed, read or removed — the only deletion is of the thread id it just
created.

```
Starting rehearse...
rehearse: minted 2 identity(ies) for this run; they are removed at the end
rehearse: all 4 assertions passed.
rehearse: cleaned up thread 19:acsV2_...@thread.v2
rehearse: removed 2 minted identity(ies)
```

The four assertions: the thread exists, both participants are on it, each
message resolves to the right person, and the original timestamp survived in
metadata. Pass `--keep` to leave the thread in place and inspect it yourself.

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

## Cleaning up a test replay

`migrate apply` does not clean up after itself. It is meant to leave an estate
behind, so a test run leaves one too. The ledger is the record of what it made:
`thread` lines carry the new thread id, `identity` lines carry each identity it
minted.

**Delete the threads before the identities, and delete each thread as one of
its own participants.** ACS only accepts `deleteChatThread` from a participant
— there is no admin delete, and the resource access key does not grant one.
Delete the identities first, or delete every thread as a single identity that
is not in all of them, and any thread you miss becomes unreachable **forever**:
no identity can open it, no new identity can be added to it, and it cannot be
removed.

That is not hypothetical. It is how this document came to have this section.

## Things that will bite you

- **Do not rerun `extract` against a resource you have already replayed into.**
  You will extract the replay.
- **`--no-participants` exists and you should not use it.** It caused both of
  the production defects this tool was written to prevent: messages attributed
  to the wrong person, and a `Forbidden` the first time someone replies.
- **An identity from the wrong resource is as broken as no identity.** Code
  that only re-mints when the field is *empty* is how 649 stale identities
  became permanent somewhere else.
