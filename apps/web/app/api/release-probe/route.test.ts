import { beforeEach, describe, expect, it, vi } from 'vitest';

const diagnostics = vi.hoisted(() => ({
  get: vi.fn(),
  config: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock('@/lib/capabilities', () => ({
  getCapabilityDiagnostics: diagnostics.get,
}));
vi.mock('@assistant/config', () => ({ loadConfig: diagnostics.config }));
vi.mock('@/lib/agent-readiness-source', () => ({
  createCloudRunAgentReadinessSource: () => ({ read: diagnostics.readiness }),
}));

import { GET } from './route';

describe('release readiness probe', () => {
  beforeEach(() => {
    diagnostics.get.mockReset();
    diagnostics.readiness.mockReset();
    diagnostics.config
      .mockReset()
      .mockReturnValue({ PERSISTENCE_DRIVER: 'postgres', ASSISTANT_RELEASE_WRITES_PAUSED: false });
  });

  it('returns only a secret-safe successful cross-service readiness receipt', async () => {
    diagnostics.get.mockResolvedValue({
      statusAvailable: true,
      diagnostics: [{ detail: 'secret detail' }],
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ready: true, apiContract: 1, writesPaused: false });
  });

  it('reports the temporary write pause independently of agent readiness', async () => {
    diagnostics.config.mockReturnValue({
      PERSISTENCE_DRIVER: 'postgres',
      ASSISTANT_RELEASE_WRITES_PAUSED: true,
    });
    diagnostics.get.mockResolvedValue({ statusAvailable: true, diagnostics: [] });
    expect(await (await GET()).json()).toEqual({ ready: true, apiContract: 1, writesPaused: true });
  });

  it('fails closed when the agent readiness source is unavailable', async () => {
    diagnostics.get.mockResolvedValue({ statusAvailable: false, diagnostics: [] });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false, apiContract: 1, writesPaused: false });
  });

  it('uses the owner-bound Firestore agent readiness source for Firestore releases', async () => {
    diagnostics.config.mockReturnValue({
      PERSISTENCE_DRIVER: 'firestore',
      ASSISTANT_RELEASE_WRITES_PAUSED: false,
      FIRESTORE_AGENT_ID: 'agent-1',
    });
    diagnostics.readiness.mockResolvedValue({ ready: true });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(diagnostics.readiness).toHaveBeenCalledWith('agent-1');
    expect(diagnostics.get).not.toHaveBeenCalled();
  });
});
