import type { OwnerMemoryEditorSnapshot } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { memoryNoteHref, memoryNoteReturnTo } from './memory-note-context';
import { buildOwnerMemoryEditorView, ownerMemoryReadOnlyMessage } from './owner-memory-editor-view';

const ownerId = '33333333-3333-4333-8333-333333333333';
const memoryId = '11111111-1111-4111-8111-111111111111';
const context = { ownerId, epoch: '22222222-2222-4222-8222-222222222222', privacyGeneration: null };
const session = { ownerId, formSessionScope: 'a-valid-owner-session-scope' };
const snapshot: OwnerMemoryEditorSnapshot = {
  memoryId,
  ownerId,
  content: 'Synthetic saved memory body.',
  contentHash: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  ownerCorrection: null,
  sourceLabel: 'Synthetic source',
  eligible: true,
};
const input = (overrides = {}) => ({
  snapshot,
  context,
  formSessionScope: session.formSessionScope,
  secret: 'synthetic-secret',
  enabled: true,
  now: 1_800_000_000_000,
  ...overrides,
});

describe('owner memory editor view admission', () => {
  it('issues a correction grant for this exact eligible snapshot, owner, and session', () => {
    const view = buildOwnerMemoryEditorView(input());
    expect(view.snapshot).toBe(snapshot);
    expect(view.session).toEqual(session);
    expect(view.grant).toMatchObject({ command: 'correct_owner_memory' });
    expect(view.grant?.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(view.grant?.issuedOperationHandle).toMatch(/^oe1\./);
    expect(view.unavailableReason).toBeNull();
  });

  it.each([
    ['maintenance', { enabled: false }, 'Editing is temporarily paused for maintenance.'],
    [
      'editing_not_enabled',
      { context: null },
      'Editing has not been enabled for this installation.',
    ],
    [
      'refresh_session',
      { formSessionScope: undefined },
      'Refresh your session before editing this saved note.',
    ],
    [
      'shared_source',
      { snapshot: { ...snapshot, eligible: false, readOnlyReason: 'shared_source' } },
      'This note has shared evidence and cannot be changed here.',
    ],
    [
      'unverified_source',
      { snapshot: { ...snapshot, revision: 'bad' } },
      'The exact source of this note could not be verified, so it is read-only here.',
    ],
    [
      'unverified_source',
      { context: { ...context, ownerId: '44444444-4444-4444-8444-444444444444' } },
      'The exact source of this note could not be verified, so it is read-only here.',
    ],
  ] as const)('keeps %s read-only with an explanatory reason', (reason, overrides, message) => {
    const view = buildOwnerMemoryEditorView(input(overrides));
    expect(view.grant).toBeNull();
    expect(view.session).toBeNull();
    expect(view.unavailableReason).toBe(reason);
    expect(ownerMemoryReadOnlyMessage(view.snapshot.readOnlyReason ?? view.unavailableReason)).toBe(
      message,
    );
  });
});

describe('memory note context links', () => {
  it.each([
    [
      '/profile/knowledge?view=library&query=family#knowledge-item',
      '/profile/knowledge?view=library&query=family#knowledge-item',
    ],
    ['/profile/knowledge?view=map&memory=source', '/profile/knowledge?view=map&memory=source'],
    ['//attacker.test/profile/knowledge?view=library', null],
    [
      '/profile/knowledge?view=library&returnTo=https://attacker.test',
      '/profile/knowledge?view=library&returnTo=https://attacker.test',
    ],
    ['/profile/knowledge?view=other', null],
    ['/profile/knowledge?view=library#other', '/profile/knowledge?view=library'],
  ])('validates return destination %s', (candidate, expected) => {
    expect(memoryNoteReturnTo(candidate)).toBe(expected);
  });

  it('creates bounded direct links from Memory library and map source contexts', () => {
    expect(memoryNoteHref(memoryId, '/profile/knowledge?view=library&query=family')).toBe(
      `/profile/knowledge/notes/${memoryId}?returnTo=${encodeURIComponent('/profile/knowledge?view=library&query=family')}`,
    );
    expect(memoryNoteHref(memoryId, '/profile/knowledge?view=map&memory=source')).toBe(
      `/profile/knowledge/notes/${memoryId}?returnTo=${encodeURIComponent('/profile/knowledge?view=map&memory=source')}`,
    );
    expect(memoryNoteHref('not-a-uuid', '/profile/knowledge?view=library')).toBeNull();
  });
});
