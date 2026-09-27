# Azure Communication Services Chat is retiring. Get your history out.

Microsoft announced in September 2026 that **ACS Chat retires on 30 September 2028**, and that after that date the data goes with it.

This page is about the part the migration guidance covers least: **getting your
messages out**, in a form you can still use afterwards, whatever you migrate to.

Everything here is sourced from Microsoft's
[retirement and breaking changes guide](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide),
which describes itself as *"the authoritative documentation outlining Azure
Communication Services retirement timelines and impacted services"*. Where this
page quotes it, the quotes are exact. Where it draws a conclusion, that is
clearly this project's opinion and not Microsoft's.

## The dates

| | |
|---|---|
| Announced | September 2026 |
| Chat continues to work | until 30 September 2028 |
| Chat history retained | *"according to your storage policies until the retirement date"* |
| After the retirement date | *"the supporting data and telemetry for retired and standalone services will be decommissioned"* |

Two years is less than it sounds for a data migration that needs identity
decisions, legal sign-off, and a cutover.

## What this means for your messages

Read that last row again, because it is the one that has a deadline attached:

> After the retirement date, the supporting data and telemetry for retired and
> standalone services will be decommissioned.

Your chat history is not migrated for you and it does not persist somewhere for
collection later. If it matters to your business — a care conversation, a
support thread, anything you might be asked to produce in two years — it has to
leave ACS before the service does.

## The official path, and who it suits

Microsoft's stated replacement for ACS Chat is the **Microsoft Graph Chat APIs**,
which the retirement guide lists as requiring a **Teams license**.

That is a genuinely good fit for a large set of customers: if your chat is
between people who already have Microsoft 365 identities, and you are content
for Teams to own the conversation experience and its governance, the official
path is the one to take. This page is not an argument against it.

## Who it does not suit — in Microsoft's own words

The retirement guide is unusually direct about this:

> Workloads that require anonymous or application-defined identities, a
> white-label embedded client, or consumer-scale chat outside Teams should
> evaluate other communication providers or redesign the experience.

If you are reading that sentence and recognising your own product, you are in
the group with the most work to do and the least guidance. Worth being concrete
about who that is:

- **Application-defined identities.** ACS lets your application mint
  communication users that are not people in your directory. Patients,
  customers, delivery drivers, marketplace counterparties. There is no Entra
  identity to map them to, because they were never meant to have one.
- **A white-label embedded client.** Chat inside your product, in your branding,
  where sending users to Teams is not an option you can offer.
- **Consumer-scale chat.** More participants than you have, or want, Microsoft
  365 licences for.

For these workloads the destination is an open question. **The extraction is
not.** Whatever you choose, the messages have to come out of ACS first, and that
work is the same in every case.

## Why extraction is harder than it looks

This is where most of the surprise lives, and it is worth knowing before you
scope the work.

**There is no "export my chat history" button.** There is no bulk export API.
Getting your estate out means walking the REST API thread by thread.

**ACS identities are scoped to the resource that created them.** They look like
`8:acs:<resourceGuid>_<userGuid>`. The resource GUID is part of the identity, so
an identity does not survive its resource. Any identity you have stored in your
own database becomes unusable the moment the resource does — which, in 2028, is
all of them. If your `users` table stores ACS ids as the link between a person
and their messages, that link is on a timer.

**You can only list threads an identity participates in.** There is no
administrative "list all threads" call. If no identity you control is a
participant in a thread, you cannot enumerate it — so part of extraction is
working out who can see what.

**It is long enough to fail partway.** A real estate is thousands of threads and
tens of thousands of messages, with throttling. Any extraction you write needs
paging, retries and the ability to resume, because it will not finish on the
first attempt.

None of this is exotic. It is all just work that has to be done correctly once,
under a deadline, usually by a team that has other plans for those weeks.

## A plan that works backwards from the date

1. **Now — find out what you actually have.** Thread count, message count, how
   many stored identities are already stale, whether any threads have lost their
   participants. You cannot scope the migration without this, and the answer is
   often not what people expect.
2. **Well before the date — get the history into a store you own**, keyed to
   **your** user ids rather than ACS ones. Once it is in your own database, the
   deadline stops being a data-loss risk and becomes an ordinary project.
3. **Then — decide the destination.** Teams via Graph, another vendor, or
   something you build. That decision is much easier to make calmly when your
   history is already somewhere safe, and much harder when it is still in a
   service with a shutdown date.
4. **Before the date — verify.** Counts, attribution and timestamps, checked
   rather than assumed. A migration that finished is not the same as a migration
   that is correct.

Step 2 before step 3 is the whole point. Choosing a destination first makes the
data migration part of a much larger project, all of it racing the same date.

## Where this project fits

[Threadvault](https://github.com/Het101/threadvault) is an open-source CLI
(Apache-2.0) that does steps 1, 2 and 4. It exists because its author lived
through a smaller version of this problem — an ACS resource move that left 7,022
messages attributed to the wrong person and 649 stored identities unusable —
and wrote the recovery afterwards, so nobody else has to write it at 2am.

It is deliberately not a chat platform and not a Teams migration tool.

| | |
|---|---|
| `threadvault doctor` | Audits your estate for five failure modes, read-only. Never reads a message body. Start here — it takes seconds and gives you a number. |
| `threadvault mirror backfill` | Copies threads, participants and messages into **your own Postgres**, keyed to your user ids, preserving original timestamps. Re-running repairs rather than duplicates. |
| `threadvault migrate extract` / `plan` | A portable JSONL dump and a report of what a replay would do. `--no-bodies` writes every field *except* message text, so the analysis can run where the content cannot leave. |
| `threadvault migrate verify` | Reads a replayed estate back and proves it matches the source: counts, attribution, timestamps. |

**What it does not do:** it will not move your history into Teams. Its replay
target is another ACS resource, which is useful today for a resource move and
will stop being a destination when ACS Chat retires. The part with a future is
the mirror — your messages in your database, under your ids, where the next
decision is yours rather than a vendor's.

Every command has been run against real infrastructure rather than test doubles;
[what is verified](../ROADMAP.md#what-is-verified) lists which command against
what, and what each run found.

## Start with the number

```bash
npx threadvault doctor
```

Read-only, takes seconds, never reads a message body, and tells you how much of
your estate is already in trouble before the deadline gets involved.

If you run it, [say what it found](https://github.com/Het101/threadvault/issues/new?template=run_report.yml)
— including if the answer was nothing. That is genuinely the most useful thing
anyone can contribute.

## Sources

- [Retirement and breaking changes guide for Azure Communication Services](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide) — Microsoft Learn, updated 24 September 2026
- [Post-mortem: 7,022 chat messages with the wrong author after an ACS resource move](postmortem-acs-chat-migration.md) — this project's own incident, in full

*This page is maintained by the Threadvault project and is not affiliated with
or endorsed by Microsoft. Dates and quotations were accurate as of 26 September
2026; the retirement guide is the authoritative source and may change.*
