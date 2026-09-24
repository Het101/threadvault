# Post-mortem: 7,022 chat messages with the wrong author after an Azure Communication Services resource move

*If you are in the middle of this right now, skip to [If this is happening to you](#if-this-is-happening-to-you).*

## Summary

We moved a production chat estate from one Azure Communication Services resource to another. 7,200 threads were replayed onto the new resource. Two defects followed:

- **7,022 messages displayed the wrong author.** Every replayed message showed the system user as its sender.
- **Every replayed thread rejected replies** with `CommunicationError Forbidden` (HTTP 403).

Both were recoverable, but only because the extract had — by accident rather than design — preserved two things: the original sender's user ID in message metadata, and the participant list of every thread.

Nobody lost a message. But for the hours it took to understand, the chat history of a production system was wrong in a way that read as plausible.

## What people saw

Two separate symptoms, which is part of why it took a while to connect them.

Support saw threads where every message appeared to come from the system account. The content was intact and the ordering was right, so it looked like a rendering bug, not a data problem.

Separately, users could open a thread and read it, but sending a reply failed. The API returned:

```
CommunicationError: Forbidden
status: 403
```

A 403 on a thread the user can already read is a confusing error. It reads like an auth or token problem, and that is where we looked first. It was not.

## Root cause

**ACS identities are scoped to the resource that minted them.**

An ACS user identity looks like this:

```
8:acs:<resourceGuid>_<userGuid>
```

The first half is the resource. An identity minted by resource A is not a valid identity on resource B — it is not "expired" or "unauthorised", it simply does not exist there. Move to a new resource and every ACS identity you have stored in your own database becomes a string that refers to nothing.

We knew identities were per-resource. What we had not internalised was the blast radius: *every* stored identity, *simultaneously*, with no error at write time.

This produced both symptoms:

**Wrong author.** The replay sent each historical message using the only identity that existed on the new resource — the system identity. ACS records the sender as whoever actually sent the API call. It has no concept of "send this on behalf of someone else" and no way to backdate authorship. So every message was, as far as ACS was concerned, genuinely sent by the system user. The display was correct; the data was wrong.

**Forbidden on reply.** The replay created each thread and wrote its messages, but did not re-add the participants. In ACS, only a participant of a thread may post to it. The threads therefore had exactly one participant — the identity that created them — and every real user was locked out of a thread they could still read through our own API, because our read path served history from our database rather than from ACS.

That last detail is why the two symptoms looked unrelated. Reads came from us. Writes went to ACS.

## Contributing factors

Being honest about these matters more than the root cause, because the root cause is a property of ACS and these are ours.

**The replay had no dry run.** There was no way to see what it would do without doing it. The first observation of its behaviour was in production.

**Participants were treated as derived data.** The reasoning was that participants could be reconstructed from our own tables later. True, but irrelevant — the thread was unusable in the meantime, and reconstructing them meant a second pass over 7,200 threads.

**The replay was not resumable.** It had to be run in one shot. This discouraged testing it on a subset, because a partial run left the target in a state nobody wanted to reason about.

**There was no verification step.** The replay reported what it had sent. Nothing read the result back and compared it to the source. "It completed without errors" is not the same as "it is correct", and in this case it completed without errors.

**ACS has no chat history export.** This is worth stating plainly because it shapes everything: there is no supported way to export chat history from ACS. There is no backup product. If you need your history out, you walk the REST API thread by thread and write it somewhere yourself. That work does not exist until you need it, which is generally the worst moment to write it.

## Why it was recoverable

Two accidents of the original extract saved us.

**The dump had recorded each message's original sender as our own user UUID**, not just the ACS identity. That meant the true author of all 7,022 messages was still knowable after the ACS identities had become meaningless. Had the extract stored only ACS identities, the authorship of those messages would have been unrecoverable — the identifiers would have pointed at a resource that no longer existed.

**The dump had recorded the participant list of every thread.** So the Forbidden could be repaired by re-adding participants, rather than by asking users who had been in which conversation.

Neither of these was a deliberate resilience decision. They were in the dump because they were convenient at the time.

## The five things worth checking

These generalise beyond our incident. If you run chat on ACS, all five are worth knowing the answer to:

1. **Stale identities.** Do you store `acsUserId` values whose resource GUID is not your current resource? Code that only re-mints an identity when the stored value is *empty* will never repair these — an identity from another resource is exactly as broken as no identity, and it is not empty.
2. **System-only threads.** Are there threads whose only ACS participant is your system identity? Those threads cannot be replied to by anyone.
3. **Misattributed messages.** Are there messages whose ACS sender is the system identity but whose metadata names a real user? That is the signature of a replay that lost authorship.
4. **Missing system identity.** Is there a system-user identity on the current resource? Without one, nothing can read history as the backend, and recovery options narrow sharply.
5. **Split-brain threads.** Do you have threads in ACS with no matching database row, or rows pointing at threads that are not on this resource? Both are normal after a partial migration and both are invisible until someone opens one.

## What we changed

The durable lesson is not "be careful during migrations". It is that **ACS should be a cache, not a system of record.** Your conversation history should live in a database you control, keyed by user IDs you control, with timestamps you control. Then a resource move is an inconvenience rather than an incident.

Concretely, the rules that came out of this:

- **Store your own user ID against every message, always.** ACS identities are resource-scoped and disposable; your UUIDs are not.
- **Preserve the original timestamp separately.** ACS assigns `createdOn` server-side on receipt and cannot backdate. A replayed message carries the replay date inside ACS, so the true time must travel in metadata.
- **Always restore participants.** There is no version of this where skipping them is correct.
- **Write attribution into metadata at replay time**, and read it back from the user-ID field — never from a stored ACS identity, which names a resource that may not exist any more.
- **Dry run by default**, resume by default, verify afterwards.

## If this is happening to you

If you are reading this because you searched `CommunicationError Forbidden` at an unsociable hour, here is the short version:

**The 403 is almost certainly not an auth problem.** Check whether the user is actually a participant of that thread on the ACS resource. A replay that created threads without re-adding participants produces exactly this.

**Before you fix anything, get an extract.** Walk the threads and write them to a file — threads, participants, messages, and for each message both the ACS sender and whatever your own user ID for that sender is. If you do nothing else, do this. Everything stays recoverable while that file exists.

**Check your stored identities against the current resource GUID** before assuming they are valid. Compare the segment between `8:acs:` and `_` with the resource you are actually pointing at.

**Do not re-run a replay that is not resumable.** You will duplicate everything it already wrote, and cleaning up duplicated threads on ACS is worse than the original problem.

## The tool

Threadvault is the tool we did not have that night. It is open source and free.

```bash
npx threadvault doctor
```

That audits your ACS resource and your database for all five failure modes above. It is read-only, it never reads a message body, and it takes seconds. It exits `0` if clean, `1` if it found something.

If you need to move resources, the full path is `extract → plan → rehearse → apply → verify`: export to a portable file, inspect it for gaps before writing anything, prove the durability goals on a throwaway thread, replay resumably, then read the result back and confirm it matches the source. Every write is a dry run until you pass `--commit`.

- Repository: <https://github.com/Het101/threadvault>
- Package: <https://www.npmjs.com/package/threadvault>

No message content, customer data, or identifying details appear in this write-up.
