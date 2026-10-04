# Help migrating off ACS Chat

Threadvault is free and open source. Everything below can be done yourself with
the commands in the [README](../README.md).

If you would rather not do it yourself, or `doctor` found problems you do not
have time to untangle, I run migrations as a fixed-price job.

## Why now

- **23 October 2026:** new customers can no longer sign up for the retiring ACS services.
- **30 September 2028:** ACS Chat retires, and its data goes with it.

Details and sources: [ACS Chat retirement](acs-chat-retirement.md).

## What the job covers

1. **Scoping call (30 minutes, free).** Thread count, where the history needs to
   end up, and your deadline. You get a fixed quote afterwards.
2. **Audit.** `threadvault doctor` against your resource and database, with every
   finding explained and fixed before anything moves.
3. **Mirror.** Every thread, participant and message copied into your own
   Postgres under your own user ids, with the original timestamps.
4. **Move.** Export to your new provider, or replay onto a new resource.
5. **Proof.** A `migrate verify` report showing the destination matches the
   source. That report is the sign-off.

All writes are dry runs until you approve them. The tools run on your
infrastructure, so message content moves only between your old provider, your
database and your new provider. It is never logged.

## Get in touch

Email **patel.x.het@gmail.com** with:

- roughly how many threads you have
- where the history needs to go
- your deadline

You will get a reply within two working days.

Built by [Het Patel](https://hetops.dev), who wrote Threadvault after
[migrating 7,200 threads in production](postmortem-acs-chat-migration.md).
