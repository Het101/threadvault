/**
 * One line of an extract dump. Discriminated so a single file stays streamable.
 * Field names are byte-compatible with Wizlo's acs-migrate-messages.ts dumps
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
