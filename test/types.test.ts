import { describe, expect, it } from 'vitest';
import { parseRec } from '../src/mirror/types.ts';

describe('parseRec', () => {
  it('parses the three legacy-compatible kinds and skips junk', () => {
    expect(parseRec('')).toBeNull();
    expect(parseRec('{')).toBeNull();
    expect(parseRec('{"kind":"nope"}')).toBeNull();
    const thread = parseRec(
      JSON.stringify({
        kind: 'thread',
        ourThreadId: 't1',
        legacyThreadId: '19:x@thread.v2',
        topic: 'lorem',
        createdOn: '2024-01-01T00:00:00.000Z',
        createdByAcsId: null,
        deletedOn: null,
        readerAcsId: '8:acs:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_1',
      }),
    );
    expect(thread?.kind).toBe('thread');
    const part = parseRec(
      JSON.stringify({
        kind: 'participant',
        legacyThreadId: '19:x@thread.v2',
        acsId: '8:acs:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_2',
        displayName: 'Pat',
        ourUserId: '00000000-0000-0000-0000-000000000001',
      }),
    );
    expect(part?.kind).toBe('participant');
    const msg = parseRec(
      JSON.stringify({
        kind: 'message',
        legacyThreadId: '19:x@thread.v2',
        messageId: '1',
        type: 'text',
        sequenceId: '1',
        content: 'lorem ipsum',
        senderAcsId: null,
        senderDisplayName: 'Pat',
        ourSenderUserId: '00000000-0000-0000-0000-000000000001',
        createdOn: '2024-01-01T00:00:00.000Z',
        editedOn: null,
        deletedOn: null,
        metadata: { originalCreatedOn: '2024-01-01T00:00:00.000Z' },
      }),
    );
    expect(msg?.kind).toBe('message');
  });
});
