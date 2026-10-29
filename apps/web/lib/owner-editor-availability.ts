import { isValidFormSessionScope } from '@/app/auth-form-session-scope';

const INTERNAL_ORIGIN = 'https://owner-editor.invalid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OwnerEditorAvailability =
  | { kind: 'available' }
  | {
      kind: 'sign_in_again';
      message: string;
      signInHref: '/signin';
    }
  | {
      kind: 'unavailable';
      message: string;
    };

/**
 * Return only a canonical internal page path. Query strings are intentionally
 * dropped so sign-in recovery cannot carry unreviewed selectors or redirects.
 */
export function approvedOwnerEditorReturnPath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return null;

  try {
    const url = new URL(value, INTERNAL_ORIGIN);
    if (url.origin !== INTERNAL_ORIGIN || url.username || url.password || url.hash) return null;
    const path = url.pathname;
    if (
      path === '/people' ||
      (path.startsWith('/people/') && UUID.test(path.slice('/people/'.length))) ||
      path === '/profile/memories' ||
      path === '/profile/knowledge' ||
      (path.startsWith('/profile/knowledge/notes/') &&
        UUID.test(path.slice('/profile/knowledge/notes/'.length)))
    )
      return path;
    return null;
  } catch {
    return null;
  }
}

/**
 * A valid owner cookie can predate the form-session scope claim. Only a real
 * sign-in mints that claim; page reads must not repair it or issue a grant.
 */
export function ownerEditorAvailability(input: {
  formSessionScope: unknown;
  editorAvailable: boolean;
  currentPath: unknown;
}): OwnerEditorAvailability {
  if (isValidFormSessionScope(input.formSessionScope)) {
    return input.editorAvailable
      ? { kind: 'available' }
      : {
          kind: 'unavailable',
          message:
            'Editing is temporarily unavailable. You can still browse this saved information.',
        };
  }

  const returnPath = approvedOwnerEditorReturnPath(input.currentPath);
  return returnPath
    ? {
        kind: 'sign_in_again',
        message: 'Your sign-in needs refreshing before you can edit. Sign in again to continue.',
        signInHref: '/signin',
      }
    : {
        kind: 'unavailable',
        message:
          'Editing is unavailable in this view. You can still browse this saved information.',
      };
}
