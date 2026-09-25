import type { Finding, FindingKind } from './checks.ts';

/**
 * What to do about a finding.
 *
 * `doctor` found two orphan threads on a real production resource and said
 * only that they existed. Working out what that meant, whether it mattered and
 * what to do took longer than the scan did — which is the wrong way round for
 * something people run while an incident is open.
 *
 * Every entry answers three questions and no others: what this actually means,
 * what to do about it, and how to know it worked.
 */
export type Remedy = {
  /** What the finding means, in terms of consequence rather than mechanism. */
  means: string;
  /** What to do. Never a command that writes — the decision stays with a human. */
  action: string;
  /** How to confirm it is fixed. */
  verify: string;
};

export const REMEDIES: Record<FindingKind, Remedy> = {
  'stale-identity': {
    means:
      'The user holds an ACS identity minted against a different resource. It is not merely out of date, it is unusable: tokens cannot be issued for it and the user cannot read or post anywhere on this resource.',
    action:
      'Mint a new identity on this resource for each affected user and overwrite the stored one. Re-minting only where the field is empty is what left 649 of these in place — a wrong identity and no identity need the same repair.',
    verify: 'Re-run doctor. Check 1 returns to ok once every stored identity carries this resource GUID.',
  },

  'system-only-thread': {
    means:
      'Every participant except the system identity is missing from the thread in ACS. Members see the history but any reply fails with Forbidden, because ACS refuses to accept a message from an identity that is not a participant.',
    action:
      'Add the real participants back. Their identities come from your own users table, not from ACS. If the thread was replayed by this tool, that replay ran with participants skipped.',
    verify:
      'Re-run doctor, then post one message in the thread as a non-system user. Check 2 returns to ok and the send succeeds.',
  },

  'misattributed-message': {
    means:
      'The message was sent to ACS by the system identity while its metadata names a real person. Anything reading the ACS sender shows the wrong author; anything reading the metadata shows the right one. Which of those your UI does decides whether the problem is visible.',
    action:
      'Read attribution from metadata.originalSenderUserId rather than the ACS sender. Rewriting history is not possible — ACS messages cannot be re-attributed after the fact — so the fix is in the reader, not the data.',
    verify:
      'Open an affected thread in your application. The message shows its original author. Check 3 continues to report these until the messages themselves are replaced.',
  },

  'no-system-user': {
    means:
      'No user is marked as the system account, so nothing can own replayed threads or read history as the backend. Every recovery path in this tool needs one.',
    action:
      'Mark the backend account as the system user in your users table, using the column named in threadvault.yml as usersSystemColumn.',
    verify: 'Re-run doctor. Check 4 returns to ok.',
  },

  'system-user-has-no-identity': {
    means:
      'The system user exists but holds no ACS identity on this resource. History is unreadable: there is no identity that can list the threads, so a migration cannot be planned and a backfill cannot start.',
    action:
      'Mint an identity on this resource for the system user and store it. Add it as a participant to the threads it needs to read — ACS only lists threads an identity actually belongs to.',
    verify:
      'Re-run doctor. Check 4 returns to ok and the walked line reports a non-zero thread count.',
  },

  'thread-without-external-id': {
    means:
      'The database row has no ACS thread id, so nothing links it to a conversation. It cannot be read, migrated or verified — it is a row that refers to nothing.',
    action:
      'Find the ACS thread this row was meant to point at and set its externalId, or delete the row if the conversation no longer exists. There is no way to derive one from the other.',
    verify: 'Re-run doctor. Check 5 stops reporting this row.',
  },

  'acs-thread-not-in-db': {
    means:
      'The thread exists in ACS but your database has no row for it. Your application cannot see it, and a migration driven by your database will leave it behind. The usual cause is createChatThread succeeding while the row insert that should have followed did not.',
    action:
      'Decide per thread, because both answers are reasonable. To adopt it, insert a row whose externalId is the ACS thread id. To discard it, delete the thread in ACS. Read it first — it may hold real conversation.',
    verify:
      'Re-run doctor. Check 5 stops reporting the thread, and the walked count and the on-record count agree.',
  },

  'db-thread-not-in-acs': {
    means:
      'The row points at an ACS thread that is not on this resource. Either the thread was deleted, or the id belongs to a resource that has been replaced — the second is what happens to every stored thread id when an ACS resource changes.',
    action:
      'If you have migrated resources, update the row to the new thread id produced by the replay; migrate verify reports the mapping. If the thread was genuinely deleted, delete the row or mark it closed.',
    verify: 'Re-run doctor. Check 5 stops reporting the row.',
  },
};

export type Advice = Remedy & {
  kind: FindingKind;
  /** How many findings of this kind the run produced. */
  count: number;
};

/**
 * One entry per kind present, not one per finding. A resource with 600 stale
 * identities has one problem, and printing the same paragraph 600 times buries
 * the other four.
 */
export function adviceFor(findings: Finding[]): Advice[] {
  const counts = new Map<FindingKind, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);

  const out: Advice[] = [];
  // Ordered by the check that raised them, so the advice reads in the same
  // order as the summary above it.
  for (const kind of Object.keys(REMEDIES) as FindingKind[]) {
    const count = counts.get(kind);
    if (count) out.push({ kind, count, ...REMEDIES[kind] });
  }
  return out;
}
