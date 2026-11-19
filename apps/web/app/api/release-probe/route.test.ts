import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diagnostics = vi.hoisted(() => ({
  get: vi.fn(),
  config: vi.fn(),
  readiness: vi.fn(),
  source: vi.fn(),
}));

vi.mock('@/lib/capabilities', () => ({
  getCapabilityDiagnostics: diagnostics.get,
}));
vi.mock('@assistant/config', () => ({ loadConfig: diagnostics.config }));
vi.mock('@/lib/agent-readiness-source', () => ({
  createCloudRunAgentReadinessSource: diagnostics.source,
}));

import { GET } from './route';

const canonical = new Request('https://web.example/api/release-probe');

describe('release readiness probe', () => {
  beforeEach(() => {
    diagnostics.get.mockReset();
    diagnostics.readiness.mockReset();
    diagnostics.source.mockReset().mockReturnValue({ read: diagnostics.readiness });
    diagnostics.config
      .mockReset()
      .mockReturnValue({ PERSISTENCE_DRIVER: 'postgres', ASSISTANT_RELEASE_WRITES_PAUSED: false });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('returns only a secret-safe successful cross-service readiness receipt', async () => {
    diagnostics.get.mockResolvedValue({
      statusAvailable: true,
      diagnostics: [{ detail: 'secret detail' }],
    });
    const response = await GET(canonical);
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
    expect(await (await GET(canonical)).json()).toEqual({
      ready: true,
      apiContract: 1,
      writesPaused: true,
    });
  });

  it('fails closed when the agent readiness source is unavailable', async () => {
    diagnostics.get.mockResolvedValue({ statusAvailable: false, diagnostics: [] });
    const response = await GET(canonical);
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
    const response = await GET(canonical);
    expect(response.status).toBe(200);
    expect(diagnostics.readiness).toHaveBeenCalledWith('agent-1');
    expect(diagnostics.get).not.toHaveBeenCalled();
  });

  it('targets only this run’s paused peer using the bounded staged probe selector', async () => {
    diagnostics.config.mockReturnValue({
      PERSISTENCE_DRIVER: 'firestore',
      ASSISTANT_RELEASE_WRITES_PAUSED: true,
      MCP_OAUTH_ENABLED: false,
      FIRESTORE_AGENT_ID: 'agent-1',
    });
    diagnostics.readiness.mockResolvedValue({
      ready: true,
      release: {
        service: 'assistant-agent',
        revision: 'assistant-agent-p-12345-1-aaaaaaaa',
        source: 'a'.repeat(40),
        manifest: 'b'.repeat(64),
        writesPaused: true,
        mcpOAuthEnabled: false,
      },
    });
    vi.stubEnv('ASSISTANT_RELEASE_SOURCE_SHA', 'a'.repeat(40));
    vi.stubEnv('ASSISTANT_RELEASE_MANIFEST', 'b'.repeat(64));
    vi.stubEnv('ASSISTANT_RELEASE_API_CONTRACT', '3');
    vi.stubEnv('ASSISTANT_RELEASE_WORKFLOW_RUN_ID', '12345');
    vi.stubEnv('ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT', '1');
    const request = new Request('https://web.example/api/release-probe?peer=staged');
    expect((await GET(request)).status).toBe(200);
    expect(diagnostics.source).toHaveBeenLastCalledWith(
      expect.any(Object),
      undefined,
      'candidate-12345-1',
      true,
    );
    diagnostics.source.mockClear();
    vi.stubEnv('ASSISTANT_RELEASE_WORKFLOW_RUN_ID', 'foreign.example');
    expect((await GET(request)).status).toBe(503);
    expect(diagnostics.source).not.toHaveBeenCalled();
    vi.stubEnv('ASSISTANT_RELEASE_WORKFLOW_RUN_ID', '12345');
    diagnostics.config.mockReturnValue({
      PERSISTENCE_DRIVER: 'firestore',
      ASSISTANT_RELEASE_WRITES_PAUSED: false,
    });
    expect((await GET(request)).status).toBe(503);
    expect(diagnostics.source).not.toHaveBeenCalled();
  });

  it('rejects a ready canonical peer with the wrong release identity', async () => {
    diagnostics.config.mockReturnValue({
      PERSISTENCE_DRIVER: 'firestore',
      ASSISTANT_RELEASE_WRITES_PAUSED: true,
      MCP_OAUTH_ENABLED: false,
      FIRESTORE_AGENT_ID: 'agent-1',
    });
    const release = {
      service: 'assistant-agent',
      revision: 'assistant-agent-r-12345-1-aaaaaaaa',
      source: 'a'.repeat(40),
      manifest: 'b'.repeat(64),
      writesPaused: false,
      mcpOAuthEnabled: false,
    };
    vi.stubEnv('ASSISTANT_RELEASE_SOURCE_SHA', release.source);
    vi.stubEnv('ASSISTANT_RELEASE_MANIFEST', release.manifest);
    vi.stubEnv('ASSISTANT_RELEASE_API_CONTRACT', '3');
    vi.stubEnv('ASSISTANT_RELEASE_WORKFLOW_RUN_ID', '12345');
    vi.stubEnv('ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT', '1');
    const request = new Request('https://web.example/api/release-probe?peer=canonical');
    diagnostics.readiness.mockResolvedValue({ ready: true, release });
    expect((await GET(request)).status).toBe(200);
    for (const wrong of [
      { service: 'assistant-web' },
      { revision: 'assistant-agent-other' },
      { source: 'c'.repeat(40) },
      { manifest: 'c'.repeat(64) },
      { writesPaused: true },
      { mcpOAuthEnabled: true },
    ]) {
      diagnostics.readiness.mockResolvedValue({ ready: true, release: { ...release, ...wrong } });
      expect((await GET(request)).status).toBe(503);
    }
  });
});
