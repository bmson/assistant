import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: vi.fn(),
  token: vi.fn(),
  connections: vi.fn(),
  mode: 'google',
}));
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
vi.mock('@/lib/server', () => ({
  getWorkspaceSettings: async () => ({ policies: [] }),
  listOwnerMcpConnections: state.connections,
  isMcpOAuthConfigured: () => false,
}));
vi.mock('./actions', () => ({}));
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
  state.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
  state.connections.mockResolvedValue([]);
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

it('mounts the diagnostics on the existing owner connection', async () => {
  state.connections.mockResolvedValue([
    {
      id: 'example',
      name: 'Fixture connection',
      endpoint: 'https://example.test/mcp',
      enabled: true,
      status: 'authorization_required',
      hasBearerToken: true,
      tools: [],
    },
  ]);
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain('Fixture connection');
  expect(html).toContain('Check sign-in options');
  expect(html).toContain('Bearer authentication configured');
});

it('shows a load error when the connection inventory is unavailable', async () => {
  state.connections.mockRejectedValue(new Error('offline'));
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain('Couldn’t load connected tools');
  expect(html).not.toContain('No MCP connections yet');
});
