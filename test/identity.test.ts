import { describe, expect, it } from 'vitest';
import {
  belongsToResource,
  isKnownGuid,
  parseAcsId,
  resolveOriginalSenderUserId,
  resolveSentAt,
} from '../src/acs/identity.ts';

const RESOURCE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';
const idOn = (guid: string) => `8:acs:${guid}_99999999-aaaa-bbbb-cccc-ddddeeeeffff`;

describe('parseAcsId', () => {
  it('parses a well-formed identity', () => {
    const p = parseAcsId(idOn(RESOURCE));
    expect(p).toEqual({
      resourceGuid: RESOURCE,
      userGuid: '99999999-aaaa-bbbb-cccc-ddddeeeeffff',
    });
  });

  it('returns null for empty, garbage, and non-acs ids', () => {
    expect(parseAcsId(null)).toBeNull();
    expect(parseAcsId('')).toBeNull();
    expect(parseAcsId('8:acs:not-a-guid_x')).toBeNull();
    expect(parseAcsId('user-123')).toBeNull();
  });
});

describe('belongsToResource', () => {
  it('accepts identities minted by the resource', () => {
    expect(belongsToResource(idOn(RESOURCE), RESOURCE)).toBe(true);
    expect(belongsToResource(idOn(RESOURCE), RESOURCE.toUpperCase())).toBe(true);
  });

  it('rejects empty and other-resource identities', () => {
    expect(belongsToResource(null, RESOURCE)).toBe(false);
    expect(belongsToResource('', RESOURCE)).toBe(false);
    expect(belongsToResource(idOn(OTHER), RESOURCE)).toBe(false);
  });
});

describe('isKnownGuid', () => {
  it('treats probe-failure sentinels as unknown so they cannot match each other', () => {
    expect(isKnownGuid('-')).toBe(false);
    expect(isKnownGuid('?')).toBe(false);
    expect(isKnownGuid(null)).toBe(false);
    expect(isKnownGuid(RESOURCE)).toBe(true);
  });
});

describe('resolveSentAt', () => {
  it('prefers metadata.originalCreatedOn over ACS createdOn', () => {
    expect(
      resolveSentAt({
        createdOn: new Date('2026-09-20T12:00:00.000Z'),
        metadata: { originalCreatedOn: '2024-01-15T08:30:00.000Z' },
      }),
    ).toBe('2024-01-15T08:30:00.000Z');
  });

  it('falls back to createdOn when metadata is missing or unparseable', () => {
    expect(
      resolveSentAt({ createdOn: new Date('2026-09-20T12:00:00.000Z'), metadata: { originalCreatedOn: 'nope' } }),
    ).toBe('2026-09-20T12:00:00.000Z');
    expect(resolveSentAt({ createdOn: '2026-09-20T12:00:00.000Z' })).toBe('2026-09-20T12:00:00.000Z');
  });
});

describe('resolveOriginalSenderUserId', () => {
  it('reads our UUID and refuses an ACS identity stuffed into the field', () => {
    expect(
      resolveOriginalSenderUserId({
        metadata: { originalSenderUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      }),
    ).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(
      resolveOriginalSenderUserId({
        metadata: { originalSenderUserId: idOn(RESOURCE), originalSenderAcsId: idOn(OTHER) },
      }),
    ).toBeNull();
  });

  it('does not fall back to originalSenderAcsId', () => {
    expect(
      resolveOriginalSenderUserId({
        metadata: { originalSenderAcsId: idOn(OTHER) },
      }),
    ).toBeNull();
  });
});

describe('connectionStringProblem', () => {
  it('names the shell-quoting trap, which is what actually happens', async () => {
    const { connectionStringProblem } = await import('../src/acs/client.ts');
    // An unquoted `export X=endpoint=...;accesskey=...` in bash ends the
    // command at the ';', leaving exactly this.
    const truncated = 'endpoint=https://example.communication.azure.com/';
    expect(connectionStringProblem(truncated)).toMatch(/accesskey/);
    expect(connectionStringProblem(truncated)).toMatch(/quote it/);
  });

  it('accepts a complete connection string and rejects an empty one', async () => {
    const { connectionStringProblem } = await import('../src/acs/client.ts');
    expect(
      connectionStringProblem('endpoint=https://example.communication.azure.com/;accesskey=abc'),
    ).toBeNull();
    expect(connectionStringProblem('')).toMatch(/empty/);
    expect(connectionStringProblem('accesskey=abc')).toMatch(/endpoint/);
  });
});
