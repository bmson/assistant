import { describe, expect, it } from 'vitest';
import {
  approvedOwnerEditorReturnPath,
  ownerEditorAvailability,
} from './owner-editor-availability';

const scope = 'current-form-session-scope-1234';
const personId = '123e4567-e89b-42d3-a456-426614174000';
const noteId = '223e4567-e89b-42d3-a456-426614174000';

describe('owner editor availability', () => {
  it('asks a valid old owner cookie to sign in again without minting a form scope', () => {
    const result = ownerEditorAvailability({
      formSessionScope: undefined,
      editorAvailable: false,
      currentPath: `/people/${personId}?q=Ada&external=https%3A%2F%2Fattacker.test`,
    });
    expect(result).toEqual({
      kind: 'sign_in_again',
      message:
        'Your sign-in needs refreshing before you can edit. Open Account, choose Sign out of this browser, then sign in again.',
    });
  });

  it('distinguishes a scoped session whose editor backend is unavailable', () => {
    expect(
      ownerEditorAvailability({
        formSessionScope: scope,
        editorAvailable: false,
        currentPath: '/profile/knowledge/notes/223e4567-e89b-42d3-a456-426614174000',
      }),
    ).toEqual({
      kind: 'unavailable',
      message: 'Editing is temporarily unavailable. You can still browse this saved information.',
    });
  });

  it('reports availability only when a valid session scope and an actual editor view exist', () => {
    expect(
      ownerEditorAvailability({
        formSessionScope: scope,
        editorAvailable: true,
        currentPath: '/people',
      }),
    ).toEqual({ kind: 'available' });
    expect(
      ownerEditorAvailability({
        formSessionScope: undefined,
        editorAvailable: true,
        currentPath: '/people',
      }).kind,
    ).toBe('sign_in_again');
  });

  it.each([
    '/people',
    `/people/${personId}`,
    '/profile/memories',
    '/profile/knowledge',
    `/profile/knowledge/notes/${noteId}`,
  ])('approves the internal return path %s', (path) => {
    expect(approvedOwnerEditorReturnPath(path)).toBe(path);
  });

  it.each([
    'https://attacker.test/people',
    '//attacker.test/people',
    '/people/anything',
    '/profile/knowledge/notes/not-a-uuid',
    '/profile/knowledge/notes/223e4567-e89b-42d3-a456-426614174000/extra',
    '/profile/memories/extra',
    '/settings',
    '/people\\\\attacker.test',
  ])('rejects an unapproved return path: %s', (path) => {
    expect(approvedOwnerEditorReturnPath(path)).toBeNull();
    expect(
      ownerEditorAvailability({
        formSessionScope: undefined,
        editorAvailable: false,
        currentPath: path,
      }).kind,
    ).toBe('unavailable');
  });

  it('drops query selectors and rejects overlong path input', () => {
    expect(approvedOwnerEditorReturnPath('/profile/knowledge?view=library&memory=secret')).toBe(
      '/profile/knowledge',
    );
    expect(approvedOwnerEditorReturnPath(`/people?${'q'.repeat(2048)}`)).toBeNull();
  });
});
