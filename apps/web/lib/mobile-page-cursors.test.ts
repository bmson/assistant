import { describe, expect, it } from 'vitest';
import { decodeMobileDocumentCursor, encodeMobileDocumentCursor } from './mobile-document-pages.js';
import { decodeMobilePeopleCursor, encodeMobilePeopleCursor } from './mobile-people-pages.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const rowId = '22222222-2222-4222-8222-222222222222';
const otherOwnerId = '33333333-3333-4333-8333-333333333333';

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('mobile page cursors', () => {
  it('round-trips valid owner-bound document and people cursors', () => {
    const document = {
      version: 1 as const,
      ownerId,
      id: rowId,
      createdAt: '2026-09-20T10:00:00.000Z',
    };
    expect(decodeMobileDocumentCursor(encodeMobileDocumentCursor(document), ownerId)).toEqual(
      document,
    );
    const person = { version: 1 as const, ownerId, id: rowId, name: 'Anna' };
    expect(decodeMobilePeopleCursor(encodeMobilePeopleCursor(person), ownerId)).toEqual(person);
  });

  it('rejects foreign owners and malformed UUID/timestamp fields before storage queries', () => {
    const malformedDocument = [
      { version: 1, ownerId: otherOwnerId, id: rowId, createdAt: '2026-09-20T10:00:00.000Z' },
      {
        version: 1,
        ownerId,
        id: '22222222222242228222222222222222',
        createdAt: '2026-09-20T10:00:00.000Z',
      },
      { version: 1, ownerId, id: rowId, createdAt: '2026-02-30T10:00:00.000Z' },
    ];
    for (const cursor of malformedDocument) {
      expect(() => decodeMobileDocumentCursor(rawCursor(cursor), ownerId)).toThrow(/continuation/);
    }

    for (const cursor of [
      { version: 1, ownerId: otherOwnerId, name: 'Anna', id: rowId },
      { version: 1, ownerId, name: 'Anna', id: { value: rowId } },
      { version: 1, ownerId, name: 'Anna', id: '22222222222242228222222222222222' },
    ]) {
      expect(() => decodeMobilePeopleCursor(rawCursor(cursor), ownerId)).toThrow(/continuation/);
    }
  });
});
