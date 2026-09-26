import { belongsToResource, parseAcsId } from '../acs/identity.ts';
import { log } from '../log.ts';
import { isReplayable, type Rec } from '../mirror/types.ts';
import { shadowUserId } from '../mirror/sink-postgres.ts';

export type PlanReport = {
  threads: number;
  participants: number;
  messages: number;
  /** ACS control messages. `apply` skips these, so plan must not imply it won't. */
  controlMessages: number;
  uniqueAcsIds: number;
  /**
   * Participants whose `ourUserId` the mirror derived rather than received.
   *
   * `mirror backfill` stands in a deterministic id for anyone the host never
   * mapped, so re-running is a no-op. Replaying that mints an identity keyed
   * to a synthetic id: attribution holds inside the estate, but the person it
   * names matches no row in the caller’s users table.
   */
  participantsWithDerivedId: number;
  messagesMissingOriginalSender: number;
  messagesMissingOriginalCreatedOn: number;
  staleAcsIds: number;
  parseableAcsIds: number;
  resourceGuids: string[];
};

/**
 * Inspect a Rec stream. No writes. Used before apply to catch missing
 * originalSenderUserId, missing originalCreatedOn, and mixed-resource identities.
 */
export async function migratePlan(
  stream: AsyncIterable<Rec>,
  targetResourceGuid?: string,
): Promise<PlanReport> {
  const acsIds = new Set<string>();
  const guids = new Set<string>();
  const report: PlanReport = {
    threads: 0,
    participants: 0,
    messages: 0,
    controlMessages: 0,
    uniqueAcsIds: 0,
    participantsWithDerivedId: 0,
    messagesMissingOriginalSender: 0,
    messagesMissingOriginalCreatedOn: 0,
    staleAcsIds: 0,
    parseableAcsIds: 0,
    resourceGuids: [],
  };

  const noteAcsId = (id: string | null) => {
    if (!id) return;
    acsIds.add(id);
    const parsed = parseAcsId(id);
    if (parsed) {
      report.parseableAcsIds++;
      guids.add(parsed.resourceGuid);
      if (targetResourceGuid && !belongsToResource(id, targetResourceGuid)) {
        report.staleAcsIds++;
      }
    }
  };

  for await (const rec of stream) {
    if (rec.kind === 'thread') {
      report.threads++;
      noteAcsId(rec.createdByAcsId);
    } else if (rec.kind === 'participant') {
      report.participants++;
      // shadowUserId is deterministic, so this is exact rather than a guess.
      if (rec.ourUserId && rec.acsId && rec.ourUserId === shadowUserId(rec.acsId)) {
        report.participantsWithDerivedId++;
      }
      noteAcsId(rec.acsId);
    } else if (rec.kind === 'message') {
      report.messages++;
      if (!isReplayable(rec)) report.controlMessages++;
      noteAcsId(rec.senderAcsId);
      const sender = rec.ourSenderUserId || rec.metadata?.originalSenderUserId;
      if (!sender || sender.startsWith('8:acs:')) report.messagesMissingOriginalSender++;
      const created = rec.metadata?.originalCreatedOn || rec.createdOn;
      if (!created) report.messagesMissingOriginalCreatedOn++;
    }
  }

  report.uniqueAcsIds = acsIds.size;
  report.resourceGuids = [...guids].sort();
  return report;
}

function attributionRow(report: PlanReport): string {
  const have = report.messages - report.messagesMissingOriginalSender;
  return `${have} of ${report.messages}`;
}

/**
 * A participant with a derived id is a different problem from a message with no
 * sender, and the message metric hides it entirely: every message can carry our
 * user id while a participant carries one this tool invented.
 */
function derivedIdNote(report: PlanReport): string | null {
  const n = report.participantsWithDerivedId;
  if (n === 0) return null;
  return [
    `note: ${n} of ${report.participants} participant(s) carry an id this tool`,
    '      derived, not one your application gave it. `mirror backfill` stands',
    "      one in for anyone the host tables did not map, so that re-running is a",
    '      no-op. Replaying them mints an identity against that synthetic id: the',
    '      thread is whole and the messages are attributed, but that person',
    '      matches no row in your users table and never will.',
    '',
    '      Map them before replaying if you want that link: point threadvault.yml',
    '      at your users table and re-run `mirror backfill`, which repairs rows',
    '      rather than duplicating them.',
  ].join('\n');
}

/**
 * The count alone is unreadable, and read wrongly it is alarming.
 *
 * `originalSenderUserId` is metadata that `migrate apply` writes during a
 * replay. No chat provider stores our user ids, so a first extract from an
 * estate that has never been replayed carries none at all - every message
 * "missing" it, which looks like total attribution loss and is simply how the
 * providers work.
 *
 * A partial count is the real signal: it means some messages have the id and
 * others lost it, which is the defect this tool was written for.
 */
function attributionNote(report: PlanReport): string | null {
  const missing = report.messagesMissingOriginalSender;
  if (report.messages === 0 || missing === 0) return null;

  if (missing === report.messages) {
    return [
      'note: no message carries our own user id. Expected for a first extract:',
      '      no chat provider stores your user id, and `migrate apply` is what',
      '      writes it. A replay from this dump maps each old sender id to one new',
      '      identity, so attribution holds inside the estate - but the new',
      '      identities are not linked to your users. Extract through `mirror',
      '      backfill` against your own tables if you need that link.',
    ].join('\n');
  }

  return [
    `WARNING: ${report.messages - missing} message(s) carry our user id and ${missing} do not.`,
    '         A mixed dump means attribution was lost for some messages and not',
    '         others. Replaying it attributes those to whoever runs the replay.',
    '         Find out why before `migrate apply --commit`.',
  ].join('\n');
}

export function formatPlan(report: PlanReport, targetResourceGuid?: string): string {
  // padEnd, then an unconditional space: a label longer than the column must
  // still separate from its value.
  const row = (label: string, value: string | number) => `${(label + ':').padEnd(33)} ${value}`;
  const lines = [
    row('threads', report.threads),
    row('participants', report.participants),
    row('  of those, with a derived id', report.participantsWithDerivedId),
    row('messages', report.messages),
    row('  of those, ACS control messages', report.controlMessages),
    row('  replayable by apply', report.messages - report.controlMessages),
    row('unique ACS identities', report.uniqueAcsIds),
    row('messages carrying our user id', attributionRow(report)),
    row('messages missing original time', report.messagesMissingOriginalCreatedOn),
    row('resource GUIDs in dump', report.resourceGuids.join(', ') || '(none parseable)'),
  ];
  if (targetResourceGuid) {
    lines.push(row(`stale ACS ids vs ${targetResourceGuid}`, report.staleAcsIds));
  }
  const note = attributionNote(report);
  if (note) lines.push('', note);
  const derived = derivedIdNote(report);
  if (derived) lines.push('', derived);
  return lines.join('\n');
}

export function logPlan(report: PlanReport, targetResourceGuid?: string): void {
  log(formatPlan(report, targetResourceGuid));
}
