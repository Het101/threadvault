# Roadmap

What Threadvault is for, what is coming, and what it will not do. Dated
2026-09-26; this file is updated when the plan changes, not when it slips.

## The goal

Your conversation history should be yours, whoever hosts it. Threadvault starts
with Azure Communication Services because that is where the problem bit hardest,
but the aim is that losing a communications vendor is an inconvenience rather
than an incident.

## Done

- [x] Published to npm, so `npx threadvault doctor` works without cloning
- [x] ESLint, alongside typecheck and tests, enforced by CI and a pre-commit hook
- [x] Releases build, verify and stage from CI; a human approves them with their
      own 2FA, and the package carries npm provenance
- [x] **Every command exercised against real infrastructure**, not mocks. See
      [what is verified](#what-is-verified) below for which command against
      what, and what each run turned up

## Now

- [ ] A recorded walkthrough of the full pipeline against a real resource
- [ ] Get the post-mortem in front of people searching for the error it is about

## Next — 1.0

**1.0 means someone other than the author has migrated a real estate with it.**
That is the bar; polish is not a substitute for it.

- [x] An end-to-end run against a real non-production ACS resource, written up
      in full, including what went wrong — done 2026-09-26 against a UAT
      resource: `plan`, `apply --commit`, `verify`. It found that `verify` did
      not work at all
- [ ] A scheduled or watching mode for `doctor`, so drift is caught as it
      happens rather than during the next migration
- [x] Finish the `--from-mirror` identity story — done 2026-09-26. Replaying
      from the mirror works and was run end to end. Participants the host
      never mapped carry a derived id, and `migrate plan` now counts and
      explains them instead of reporting perfect attribution; mapping them is
      the caller’s data, not something this tool can invent, so it says how
      rather than guessing
- [ ] Stable flags. After 1.0 they follow semver

## What is verified

The claim this project makes is that it has been run, not merely tested. That
is worth being specific about, because "verified" is easy to say.

| Command | Run against | What it found |
|---|---|---|
| `probe` | production ACS, UAT ACS | — |
| `doctor` | production ACS + production Postgres, read-only | two orphan threads in the estate; and that a report of five `ok`s said nothing about what it had covered |
| `migrate extract` | production ACS, `--no-bodies` | that it was the only command writing message bodies to disk, which blocked any production read |
| `migrate plan` | that extract, and a synthetic one | that it reported normal data as total attribution loss |
| `migrate rehearse` | a disposable dev ACS resource | that it needed two identities nobody could create |
| `migrate apply --commit` | UAT ACS | — |
| `migrate verify` | UAT ACS, same replay | that it reported `verified clean 0` against a correct replay |
| `mirror backfill` → Twilio | a live Twilio account | that a 401 was reported as an empty estate, exit 0 — in the ACS walk too, since the beginning |
| `migrate apply --from-mirror` | Postgres 17 → UAT ACS | that `plan` reported perfect attribution while a participant carried an id the tool had invented |
| `mirror backfill` → Postgres | Postgres 17 | that a non-UUID user id died with a raw driver error mid-write, and that the identity count counted upserts |

Nine defects. None was caught by the test suite, because in every case the code
did exactly what it was written to do and the mocks agreed with it. Three times
a test was found asserting something the real system cannot do.

What this does **not** yet include is anyone other than the author. That is the
1.0 bar above, and it is deliberately not something the author can tick.

## Waiting on something we do not have

Work that is understood and not blocked on effort. Recorded here so it is not
mistaken for work nobody thought of.

| | Waiting on | Tracked |
|---|---|---|
| **1.0** | Someone other than the author migrating a real estate | [#93](https://github.com/Het101/threadvault/issues/93) |
| An orphaned chat thread in a UAT resource | Nothing. It cannot be removed: ACS accepts `deleteChatThread` only from a participant, there is no admin delete, and the access key does not grant one. Left by deleting the minted identities before the thread during a test run. Empty and unreachable | — |

The ordering trap that caused the orphan is written up in the
[runbook](docs/first-real-run.md#cleaning-up-a-test-replay), because it is
irreversible and not obvious.

## Later

- **A second vendor adapter.** Twilio Conversations is the likely first. Around
  80% of the codebase is already vendor-neutral: mirroring under your own user
  IDs, preserving original timestamps, restoring participants, dry-run and
  resume. The ACS-specific parts are one adapter.
- **Continuous mirror mode.** Run it as a daemon so Postgres stays current
  rather than being a point-in-time copy.
- **Search and export over mirrored history.** Answering "produce every message
  in this conversation" without asking the vendor.

## Not planned

- **A UI.** This is a tool for people who already live in a terminal and a
  database. A web interface would be a different product.
- **Writing to your application's tables.** Threadvault reads your schema
  through a YAML mapping and writes only to `threadvault_*`. It will not take
  responsibility for your data model.
- **Being a chat backend.** ACS is the cache; Postgres is the source of truth.
  Threadvault moves history between them and nothing more.
- **Storing your data anywhere.** It runs where you run it. Nothing leaves your
  infrastructure.

## Influencing this

Open an issue describing what you cannot do today. A concrete blocked workflow
moves things up this list faster than a feature request, and a report from
someone running it in anger outranks everything above.
