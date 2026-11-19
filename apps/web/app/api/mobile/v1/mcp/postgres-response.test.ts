import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  auth: vi.fn(),
  app: {
    addMcpConnection: vi.fn(),
    refreshMcpConnection: vi.fn(),
    setMcpConnectionEnabled: vi.fn(),
  },
}));
vi.mock('@assistant/config', () => ({
  loadConfig: () => ({ PERSISTENCE_DRIVER: 'postgres' }),
  validateAgentPersistenceConfig: () => [],
}));
vi.mock('@/lib/server', () => ({
  getApplication: () => state.app,
  getFirestoreInstallationStore: vi.fn(),
  discoverFirestoreMcpConnection: vi.fn(),
  encryptMcpConnectionBearerToken: vi.fn(),
  isMcpOAuthConfigured: () => true,
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: state.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST as update } from './[id]/route';
import { POST as create } from './route';

const connectionId = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: connectionId }) };
const request = (body: unknown) =>
  new Request('https://example.test/api/mobile/v1/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('PostgreSQL mobile MCP discovery responses', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.auth.mockResolvedValue(true);
  });

  it.each(['ready', 'authorization_required', 'error'])(
    'returns the saved %s connection with its discovery details',
    async (status) => {
      const result = { connectionId, status, tools: [], error: 'Provider discovery detail' };
      state.app.addMcpConnection.mockResolvedValue(result);
      const response = await create(
        request({ name: 'Synthetic server', endpoint: 'https://example.test/mcp' }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual(result);
    },
  );

  it.each(['refresh', 'enable'])(
    'preserves saved discovery status and details during %s',
    async (action) => {
      const result = {
        connectionId,
        status: 'authorization_required',
        tools: [],
        error: 'Sign in required',
      };
      state.app.refreshMcpConnection.mockResolvedValue(result);
      state.app.setMcpConnectionEnabled.mockResolvedValue(result);
      const response = await update(request({ action }), params);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
    },
  );

  it('preserves genuine creation validation and missing-connection failures', async () => {
    state.app.addMcpConnection.mockResolvedValue({ error: 'Give this MCP connection a name.' });
    const response = await create(request({ name: '', endpoint: 'https://example.test/mcp' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Give this MCP connection a name.' });
    state.app.refreshMcpConnection.mockResolvedValue({ error: 'MCP connection not found.' });
    const missing = await update(request({ action: 'refresh' }), params);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'MCP connection not found.' });
  });
});
