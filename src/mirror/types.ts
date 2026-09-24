/**
 * One line of an extract dump. Discriminated so a single file stays streamable.
 * Field names are byte-compatible with the original acs-migrate-messages.ts dumps
 * so existing JSONL remains valid input to `migrate apply`.
 */
export type Rec =
  | {
      kind: 'thread';
      ourThreadId: string | null;
      legacyThreadId: string;
      topic: string;
      createdOn: string | null;
      createdByAcsId: string | null;
      deletedOn: string | null;
      readerAcsId: string;
    }
  | {
      kind: 'participant';
      legacyThreadId: string;
      acsId: string;
      displayName: string | null;
      ourUserId: string | null;
    }
  | {
      kind: 'message';
      legacyThreadId: string;
      messageId: string;
      type: string;
      sequenceId: string;
      content: string | null;
      senderAcsId: string | null;
      senderDisplayName: string | null;
      ourSenderUserId: string | null;
      createdOn: string;
      editedOn: string | null;
      deletedOn: string | null;
      metadata: Record<string, string> | null;
    };

/**
 * ACS control messages. ACS emits them itself when participants or the topic
 * change, they carry no body, and the replay's own addParticipants /
 * createChatThread re-emit them naturally. Replaying them as text posts a wall
 * of empty messages into every thread, so `migrate apply` skips them and
 * `migrate plan` counts them separately.
 */
const REPLAYABLE_TYPES = new Set(['text', 'html']);

export function isReplayable(rec: Extract<Rec, { kind: 'message' }>): boolean {
  return !rec.type || REPLAYABLE_TYPES.has(rec.type);
}

export function parseRec(line: string): Rec | null {
  if (!line.trim()) return null;
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const kind = (d as { kind?: unknown }).kind;
  if (kind === 'thread' || kind === 'participant' || kind === 'message') return d as Rec;
  return null;
}
