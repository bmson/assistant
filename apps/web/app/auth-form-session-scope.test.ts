import { describe, expect, it, vi } from 'vitest';
import { formSessionScopeForJwt, isValidFormSessionScope } from './auth-form-session-scope';

describe('form session scope claims', () => {
  it('preserves a valid scope across refresh and fails closed for old or malformed cookies', () => {
    const createScope = vi.fn(() => 'fresh-signin-scope-0001');
    expect(
      formSessionScopeForJwt({
        accountPresent: false,
        existingScope: 'existing-scope-0001',
        createScope,
      }),
    ).toBe('existing-scope-0001');
    expect(
      formSessionScopeForJwt({ accountPresent: false, existingScope: undefined, createScope }),
    ).toBeNull();
    expect(
      formSessionScopeForJwt({ accountPresent: false, existingScope: 'bad', createScope }),
    ).toBeNull();
    expect(createScope).not.toHaveBeenCalled();
  });

  it('mints once only when a verified provider account is supplied', () => {
    const createScope = vi.fn(() => 'fresh-signin-scope-0001');
    expect(
      formSessionScopeForJwt({
        accountPresent: true,
        existingScope: 'old-scope-0001',
        createScope,
      }),
    ).toBe('fresh-signin-scope-0001');
    expect(createScope).toHaveBeenCalledOnce();
    expect(isValidFormSessionScope('fresh-signin-scope-0001')).toBe(true);
  });
});
