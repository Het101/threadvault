import { asCommunicationUserId } from './identity.ts';

/**
 * What a message tells us with its body removed.
 *
 * Message bodies are PHI. They are discarded here, at the SDK boundary, so no
 * caller can accidentally hold one: everything downstream works from counts,
 * ids and metadata.
 */
export type AcsMessageMeta = {
  threadId: string;
  messageId: string;
  senderAcsId: string | null;
  metadata: Record<string, string> | null;
};

export async function listParticipantIds(tc: {
  listParticipants: () => AsyncIterable<{ id?: unknown }>;
}): Promise<string[]> {
  const ids: string[] = [];
  for await (const p of tc.listParticipants()) {
    const id = asCommunicationUserId(p.id);
    if (id) ids.push(id);
  }
  return ids;
}

export async function listMessageMeta(
  tc: {
    listMessages: () => AsyncIterable<{
      id: string;
      type?: string;
      sender?: unknown;
      metadata?: Record<string, string> | null;
    }>;
  },
  threadId: string,
): Promise<AcsMessageMeta[]> {
  const out: AcsMessageMeta[] = [];
  for await (const m of tc.listMessages()) {
    // Discard m.content here. Do not read it.
    out.push({
      threadId,
      messageId: m.id,
      senderAcsId: asCommunicationUserId(m.sender),
      metadata: m.metadata ?? null,
    });
  }
  return out;
}

/**
 * Same walk, but keeping the message type so a caller can tell a replayed
 * message from an ACS control message it emitted itself.
 */
export async function listMessageMetaWithType(
  tc: {
    listMessages: () => AsyncIterable<{
      id: string;
      type?: string;
      sender?: unknown;
      metadata?: Record<string, string> | null;
    }>;
  },
  threadId: string,
): Promise<Array<AcsMessageMeta & { type: string }>> {
  const out: Array<AcsMessageMeta & { type: string }> = [];
  for await (const m of tc.listMessages()) {
    out.push({
      threadId,
      messageId: m.id,
      senderAcsId: asCommunicationUserId(m.sender),
      metadata: m.metadata ?? null,
      type: m.type ?? 'text',
    });
  }
  return out;
}
