import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  buildDeps: vi.fn(),
  firestoreMaintenanceReady: vi.fn(),
  generate: vi.fn(),
}));

vi.mock('@assistant/config', () => ({
  isModuleEnabled: () => true,
  loadConfig: () => mocks.config,
}));
vi.mock('@assistant/core', () => ({
  evaluateCanaryHealth: vi.fn(),
  expireStaleApprovals: vi.fn(),
  expireStaleSuggestions: vi.fn(),
  findDueTasks: vi.fn(),
  resumeResolvedApprovalTasks: vi.fn(),
}));
vi.mock('@assistant/firestore', () => ({ FirestoreScheduleRepository: class {} }));
vi.mock('../deps.js', () => ({
  agentServices: vi.fn(),
  buildDeps: mocks.buildDeps,
  composedModuleMetas: [],
  firestoreMaintenanceReady: mocks.firestoreMaintenanceReady,
}));
vi.mock('../google-oidc.js', () => ({
  oidcAudienceForPath: (_audience: string, path: string) => path,
  verifyInternalAuthorization: vi.fn(
    async (authorization: string | undefined) => authorization === 'Bearer internal-test-token',
  ),
}));
vi.mock('../canaries.js', () => ({ latestCanaryRun: vi.fn(), runCanaries: vi.fn() }));

const { internal } = await import('./internal.js');

describe('private Vertex model probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = {
      INTERNAL_AUTH_MODE: 'oidc',
      INTERNAL_OIDC_AUDIENCE: 'https://agent.example',
      INTERNAL_OIDC_SERVICE_ACCOUNT: 'agent@example.iam.gserviceaccount.com',
      QUEUE_DRIVER: 'local',
      VERTEX_MODEL_PROBE_ENABLED: true,
      PERSISTENCE_DRIVER: 'firestore',
      LLM_PROVIDER: 'vertex',
    };
    mocks.firestoreMaintenanceReady.mockResolvedValue(true);
    mocks.generate.mockResolvedValue({ ok: true, text: 'PROBE_OK', modelId: 'vertex/test-model' });
    mocks.buildDeps.mockReturnValue({
      config: mocks.config,
      router: { generate: mocks.generate },
      firestoreStore: {},
    });
  });

  it('requires the existing internal authentication before building deps', async () => {
    const response = await internal.request('/model-probe/vertex', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(mocks.buildDeps).not.toHaveBeenCalled();
  });

  it('uses the seeded draft route with a fixed prompt and hard bounds, without a task id', async () => {
    const response = await internal.request('/model-probe/vertex', {
      method: 'POST',
      headers: { authorization: 'Bearer internal-test-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      matched: true,
      modelId: 'vertex/test-model',
    });
    expect(mocks.firestoreMaintenanceReady).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledOnce();
    const [role, options] = mocks.generate.mock.calls[0] as [string, Record<string, unknown>];
    expect(role).toBe('draft');
    expect(options).toMatchObject({
      system: 'This is a bounded internal connectivity probe. Reply with exactly PROBE_OK.',
      prompt: 'Reply with exactly PROBE_OK.',
      temperature: 0,
      maxOutputTokens: 16,
      maxEstimatedCostUsd: 0.005,
    });
    expect(options).not.toHaveProperty('taskId');
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('does not call the model while a Firestore import awaits activation', async () => {
    mocks.firestoreMaintenanceReady.mockResolvedValue(false);

    const response = await internal.request('/model-probe/vertex', {
      method: 'POST',
      headers: { authorization: 'Bearer internal-test-token' },
    });

    expect(response.status).toBe(503);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('hides the endpoint in SQL mode and rejects caller-controlled prompts', async () => {
    mocks.config = { ...mocks.config, PERSISTENCE_DRIVER: 'postgres' };
    const hidden = await internal.request('/model-probe/vertex', {
      method: 'POST',
      headers: { authorization: 'Bearer internal-test-token' },
    });
    expect(hidden.status).toBe(404);
    expect(mocks.buildDeps).not.toHaveBeenCalled();

    mocks.config = {
      ...mocks.config,
      PERSISTENCE_DRIVER: 'firestore',
    };
    const withBody = await internal.request('/model-probe/vertex', {
      method: 'POST',
      headers: {
        authorization: 'Bearer internal-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'caller-controlled prompt' }),
    });
    expect(withBody.status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('returns no model output when the fixed response differs', async () => {
    mocks.generate.mockResolvedValue({
      ok: true,
      text: 'sensitive unexpected output',
      modelId: 'vertex/test-model',
    });
    const response = await internal.request('/model-probe/vertex', {
      method: 'POST',
      headers: { authorization: 'Bearer internal-test-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      matched: false,
      modelId: 'vertex/test-model',
    });
  });
});
