# Roadmap

What Threadvault is for, what is coming, and what it will not do. Dated
2026-09-24; this file is updated when the plan changes, not when it slips.

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

## Now

- [ ] A recorded walkthrough of the full pipeline against a real resource
- [ ] Get the post-mortem in front of people searching for the error it is about

## Next — 1.0

**1.0 means someone other than the author has migrated a real estate with it.**
That is the bar; polish is not a substitute for it.

- [ ] An end-to-end run against a real non-production ACS resource, written up
      in full, including what went wrong
- [ ] A scheduled or watching mode for `doctor`, so drift is caught as it
      happens rather than during the next migration
- [ ] Finish the `--from-mirror` identity story: replaying from the Postgres
      mirror still needs host user IDs mapped back onto new identities
- [ ] Stable flags. After 1.0 they follow semver

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
