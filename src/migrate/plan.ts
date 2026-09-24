import { belongsToResource, parseAcsId } from '../acs/identity.ts';
import { log } from '../log.ts';
import { isReplayable, type Rec } from '../mirror/types.ts';

export type PlanReport = {
  threads: number;
  participants: number;
  messages: number;
  /** ACS control messages. `apply` skips these, so plan must not imply it won't. */
  controlMessages: number;
  uniqueAcsIds: number;
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

export function formatPlan(report: PlanReport, targetResourceGuid?: string): string {
  // padEnd, then an unconditional space: a label longer than the column must
  // still separate from its value.
  const row = (label: string, value: string | number) => `${(label + ':').padEnd(33)} ${value}`;
  const lines = [
    row('threads', report.threads),
    row('participants', report.participants),
    row('messages', report.messages),
    row('  of those, ACS control messages', report.controlMessages),
    row('  replayable by apply', report.messages - report.controlMessages),
    row('unique ACS identities', report.uniqueAcsIds),
    row('messages missing original sender', report.messagesMissingOriginalSender),
    row('messages missing original time', report.messagesMissingOriginalCreatedOn),
    row('resource GUIDs in dump', report.resourceGuids.join(', ') || '(none parseable)'),
  ];
  if (targetResourceGuid) {
    lines.push(row(`stale ACS ids vs ${targetResourceGuid}`, report.staleAcsIds));
  }
  return lines.join('\n');
}

export function logPlan(report: PlanReport, targetResourceGuid?: string): void {
  log(formatPlan(report, targetResourceGuid));
}
