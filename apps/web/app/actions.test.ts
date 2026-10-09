import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mode: 'google',
  signOut: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));
vi.mock('@/auth', () => ({
  get authMode() {
    return mocks.mode;
  },
  signOut: mocks.signOut,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/owner-auth/runtime', () => ({ clearOwnerSessionCookie: mocks.clear }));

import { signOutAction } from './actions';

describe('per-browser sign out action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('uses the Google session sign-out handler', async () => {
    mocks.mode = 'google';
    await signOutAction();
    expect(mocks.signOut).toHaveBeenCalledWith({ redirectTo: '/' });
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it('removes only the passkey browser cookie before redirecting', async () => {
    mocks.mode = 'passkey';
    await expect(signOutAction()).rejects.toThrow('redirect:/signin');
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
