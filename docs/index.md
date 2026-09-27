---
title: "Threadvault — get your chat history out before the vendor retires it"
description: "Azure Communication Services Chat retires 30 September 2028 and the data is decommissioned with it. What that means for your message history, and how to get it into a database you own."
---

# Threadvault

**Your chat history should outlive your chat vendor.**

Threadvault is an open-source CLI ([Apache-2.0](https://github.com/Het101/threadvault/blob/main/LICENSE))
that mirrors Azure Communication Services or Twilio Conversations chat into your
own PostgreSQL — keyed to **your** user IDs, with the **original** timestamps —
and then audits, replays and verifies it.

```bash
npx threadvault doctor
```

Read-only. Takes seconds. Never reads a message body. Gives you a number.

---

## If you run ACS Chat, start here

> **Azure Communication Services Chat retires on 30 September 2028.** Microsoft
> announced it in September 2026 and states that after the retirement date
> *"the supporting data and telemetry for retired and standalone services will
> be decommissioned"*.
>
> From **23 October 2026**, new customers can no longer sign up for the retiring
> services.

Most of the coverage so far is about mapping your dependencies and choosing a
destination. The part with a hard deadline, and the part that is identical
whatever destination you pick, is **getting the messages out**.

**[Azure Communication Services Chat is retiring. Get your history out. →](acs-chat-retirement)**

---

## The pages here

| | |
|---|---|
| [ACS Chat is retiring](acs-chat-retirement) | What the 2028 retirement means for your message history, who the official Teams path suits, who it does not, and a plan that works backwards from the date |
| [Post-mortem: 7,022 messages with the wrong author](postmortem-acs-chat-migration) | The incident that produced this tool. An ACS resource move, 649 stored identities turned to garbage, and what it took to recover |
| [Your first real run](first-real-run) | Pointing it at an actual resource, one safe stage at a time. Stages 1–5 cannot write to ACS at all |

---

## Why the identities are the hard part

ACS identities look like `8:acs:<resourceGuid>_<userGuid>`. The resource GUID is
part of the identity, so an identity does not survive its resource. Every ACS ID
stored in your own database becomes unusable the moment that resource changes —
which, by 2028, is all of them.

If your `users` table links a person to their messages through an ACS ID, that
link is on a timer.

Threadvault mirrors under *your* IDs instead, which is the only version of this
that survives the vendor.

---

## Verified against real infrastructure

Every command has been run against production and UAT Azure resources, a live
Twilio account, and PostgreSQL 17 — not against test doubles.
[What is verified](https://github.com/Het101/threadvault/blob/main/ROADMAP.md#what-is-verified)
lists which command against what, and what each run found. Ten defects, none of
which the test suite caught.

It is not 1.0, and that is deliberate:
[1.0 means somebody other than the author has migrated a real estate with it](https://github.com/Het101/threadvault/issues/93).

---

[GitHub](https://github.com/Het101/threadvault) ·
[npm](https://www.npmjs.com/package/threadvault) ·
[Report a run](https://github.com/Het101/threadvault/issues/new?template=run_report.yml)
