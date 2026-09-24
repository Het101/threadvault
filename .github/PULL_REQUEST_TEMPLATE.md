## What breaks without this

<!-- The problem, not the diff. If it fixes a bug, what went wrong? -->

## What changed

<!-- Keep it short; the diff has the detail. -->

## Checklist

- [ ] A test fails without this change
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass locally
- [ ] No message bodies, credentials, real names or production identifiers anywhere in the diff
- [ ] README updated if behaviour changed
- [ ] One concern in this PR

## Domain rules

<!-- Tick only those your change touches. See CONTRIBUTING.md. -->

- [ ] Attribution still reads `metadata.originalSenderUserId`, never `originalSenderAcsId`
- [ ] `sentAt` is still the original timestamp, not the replay date
- [ ] Participants are still always restored
- [ ] Writes are still dry-run until `--commit`
- [ ] Messages inside a thread are still sent serially
