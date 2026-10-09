import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: vi.fn(), token: vi.fn(), mode: 'google' }));
vi.mock('@/auth', () => ({
  requireOwner: state.owner,
  get authMode() {
    return state.mode;
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'bot.bmson.com', 'x-forwarded-proto': 'https' }),
}));
vi.mock('@assistant/config', () => ({
  loadConfig: () => ({ GCP_PROJECT: 'fixture' }),
  envFile: '/tmp/nonexistent-admin-fixture',
}));
vi.mock('@/lib/mobile-access-token', () => ({
  getMobileAccessToken: state.token,
  hasMobileTokenRotationCapability: () => true,
}));
vi.mock('./mobile-token', () => ({
  MobileTokenPanel: ({ maskedToken, serverUrl }: { maskedToken: string; serverUrl: string }) => (
    <p>
      {maskedToken} {serverUrl}
    </p>
  ),
}));
vi.mock('@/app/security/security-client', () => ({
  SecurityClient: () => <p>Create device key</p>,
}));

import SettingsPage from './page';

beforeEach(() => {
  vi.resetAllMocks();
  state.mode = 'google';
  state.owner.mockResolvedValue({});
  state.token.mockResolvedValue('abcdef-secret-token-1234');
});
it('shows mobile access immediately and sends only a masked credential', async () => {
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain('Mobile app connection');
  expect(html).toContain('https://bot.bmson.com');
  expect(html).toContain('abcdef…1234');
  expect(html).not.toContain('secret-token');
});
it('offers independent device keys in passkey mode', async () => {
  state.mode = 'passkey';
  expect(renderToStaticMarkup(await SettingsPage())).toContain('Create device key');
  expect(state.token).not.toHaveBeenCalled();
});
it('requires owner sign-in before accessing credentials', async () => {
  state.owner.mockRejectedValue(new Error('sign in required'));
  await expect(SettingsPage()).rejects.toThrow('sign in required');
  expect(state.token).not.toHaveBeenCalled();
});
