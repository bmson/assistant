import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildDeps: vi.fn(),
  firestoreMaintenanceReady: vi.fn(),
  expireStaleApprovals: vi.fn(),
  resumeResolvedApprovalTasks: vi.fn(),
  renotifyStalledApprovals: vi.fn(),
  runDueSchedules: vi.fn(),
  expireStaleSuggestions: vi.fn(),
  renotifyStalledAttention: vi.fn(),
  emitBudgetNotices: vi.fn(),
  backfillMessageEmbeddings: vi.fn(),
  purgeExpired: vi.fn(),
  purgeAgedHistory: vi.fn(),
  repairMissionReports: vi.fn(),
  pinnedMemoryEmbed: vi.fn(),
  prepareGoalSession: vi.fn(),
  releaseStaleReservations: vi.fn(),
  executeSqlOnlySweep: vi.fn(),
  notifyApproval: vi.fn(),
  notifyOwner: vi.fn(),
}));

vi.mock('@assistant/config', () => ({
  isModuleEnabled: () => true,
  loadConfig: () => ({ INTERNAL_AUTH_MODE: 'shared-secret' }),
  parseFirestoreEmbeddingSpace: (value: string) => JSON.parse(value),
}));
vi.mock('@assistant/core', () => ({
  evaluateCanaryHealth: vi.fn(),
  expireStaleApprovals: mocks.expireStaleApprovals,
  expireStaleSuggestions: mocks.expireStaleSuggestions,
  findDueTasks: mocks.executeSqlOnlySweep,
  resumeResolvedApprovalTasks: mocks.resumeResolvedApprovalTasks,
  renotifyStalledApprovals: mocks.renotifyStalledApprovals,
  renotifyStalledAttention: mocks.renotifyStalledAttention,
  runDueSchedules: mocks.runDueSchedules,
  prepareGoalSession: mocks.prepareGoalSession,
  releaseStaleReservations: mocks.releaseStaleReservations,
  isCodeJobEnabled: () => true,
  firestoreCodeJobUnavailable: (job: string) => (job === 'dream.run' ? 'unavailable' : null),
  backfillMessageEmbeddings: mocks.backfillMessageEmbeddings,
  emitBudgetNotices: mocks.emitBudgetNotices,
  getAgent: mocks.executeSqlOnlySweep,
  getQueueNotifier: mocks.executeSqlOnlySweep,
  purgeAgedHistory: mocks.purgeAgedHistory,
  purgeExpired: mocks.purgeExpired,
  repairMissionReports: mocks.repairMissionReports,
}));
vi.mock('@assistant/firestore', () => ({
  FirestoreScheduleRepository: class {
    readonly kind = 'schedule-repository';
    constructor(readonly store: unknown) {}
  },
}));
vi.mock('../deps.js', () => ({
  agentServices: vi.fn(),
  buildDeps: mocks.buildDeps,
  composedModuleMetas: [],
  firestoreMaintenanceReady: mocks.firestoreMaintenanceReady,
  pinnedMemoryEmbed: mocks.pinnedMemoryEmbed,
}));
vi.mock('../google-oidc.js', () => ({
  oidcAudienceForPath: (_audience: string, path: string) => path,
  verifyInternalAuthorization: vi.fn(async () => true),
}));
vi.mock('../canaries.js', () => ({ latestCanaryRun: vi.fn(), runCanaries: vi.fn() }));
vi.mock('../executor-deps.js', () => ({
  executorDeps: (deps: { persistence?: unknown }) => ({
    persistence: deps.persistence,
    notifyApproval: mocks.notifyApproval,
    notifyOwner: mocks.notifyOwner,
  }),
}));

const { internal } = await import('./internal.js');

function responseDoc(data: Record<string, unknown>) {
  return {
    exists: true,
    get: (field: string) => data[field],
  };
}

function fixture() {
  const approvals = {
    expireStale: vi.fn(),
    resumeResolved: vi.fn(),
  };
  const messages = { append: vi.fn() };
  const watches = { expire: vi.fn() };
  const ownerDoc = responseDoc({ id: 'agent-1', timezone: 'America/Los_Angeles' });
  const migrationDoc = responseDoc({ status: 'active' });
  const store = {
    doc: vi.fn((collection: string, id: string) => ({
      get: async () => (collection === 'agents' && id === 'agent-1' ? ownerDoc : migrationDoc),
    })),
  };
  const db = {
    execute: vi.fn(async () => {
      throw new Error('SQL must not run');
    }),
  };
  const costs = { kind: 'cost-repository' };
  const maintenance = { kind: 'maintenance-repository' };
  const goals = { kind: 'goal-runtime-repository' };
  const tasks = { kind: 'task-lease-repository' };
  const recallMetrics = { kind: 'recall-metrics-repository' };
  const modelRouting = { kind: 'model-routing-repository' };
  const persistence = {
    driver: 'firestore',
    approvals,
    messages,
    watches,
    costs,
    maintenance,
    goals,
    tasks,
    recallMetrics,
    modelRouting,
  };
  const deps = {
    config: {
      PERSISTENCE_DRIVER: 'firestore',
      FIRESTORE_AGENT_ID: 'agent-1',
      FIRESTORE_EMBEDDING_SPACE:
        '{"provider":"synthetic","model":"sweep-fixture","dimensions":1536,"revision":"1"}',
    },
    db,
    persistence,
    firestoreStore: store,
    router: {},
    modules: { sweepSteps: [] },
  };
  return { deps, db, ownerDoc, migrationDoc, persistence, store, approvals, watches };
}

async function postSweep() {
  return internal.request('/sweep', { method: 'POST' }, { INTERNAL_AUTH_MODE: 'shared-secret' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.expireStaleApprovals.mockResolvedValue(['task-expired']);
  mocks.resumeResolvedApprovalTasks.mockResolvedValue(['task-resumed']);
  mocks.renotifyStalledApprovals.mockResolvedValue(2);
  mocks.runDueSchedules.mockResolvedValue([{ schedule: 'morning', taskId: 'task-fired' }]);
  mocks.firestoreMaintenanceReady.mockResolvedValue(true);
  mocks.expireStaleSuggestions.mockResolvedValue(5);
  mocks.renotifyStalledAttention.mockResolvedValue(6);
  mocks.emitBudgetNotices.mockResolvedValue(['budget-notice:daily:80:2026-09-24']);
  mocks.backfillMessageEmbeddings.mockResolvedValue(7);
  mocks.purgeExpired.mockResolvedValue({
    cache: 1,
    memories: 1,
    reservations: 4,
    locations: 1,
    dreamNotes: 0,
    recallMetrics: 0,
    proactivePings: 0,
    modelCallAudit: 0,
  });
  mocks.purgeAgedHistory.mockResolvedValue({
    messages: 2,
    toolCalls: 1,
    modelCalls: 0,
    costEvents: 0,
  });
  mocks.repairMissionReports.mockResolvedValue(0);
  mocks.pinnedMemoryEmbed.mockReturnValue(mocks.executeSqlOnlySweep);
});

describe('POST /internal/sweep in Firestore mode', () => {
  it('runs every maintenance step through portable repositories', async () => {
    const f = fixture();
    mocks.buildDeps.mockReturnValue(f.deps);
    f.watches.expire.mockResolvedValue(3);

    const response = await postSweep();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      expiredApprovalsWoke: 1,
      expiredSuggestions: 5,
      resumedApprovalTasks: 1,
      renotifiedApprovals: 2,
      renotifiedAttention: 6,
      missionReportsRepaired: 0,
      expiredWatches: 3,
      schedulesFired: 1,
      budgetNotices: 1,
      messagesEmbedded: 7,
      purgedExpired: 3,
      agedHistory: 3,
      releasedReservations: 4,
    });
    const { maintenance, costs, tasks, recallMetrics, modelRouting } = f.persistence;
    expect(mocks.expireStaleSuggestions).toHaveBeenCalledWith(maintenance);
    expect(mocks.renotifyStalledAttention).toHaveBeenCalledWith(
      { maintenance, tasks },
      mocks.notifyOwner,
    );
    expect(mocks.emitBudgetNotices).toHaveBeenCalledWith({ costs, maintenance }, 'agent-1');
    expect(mocks.pinnedMemoryEmbed).toHaveBeenCalledWith(
      {
        provider: 'synthetic',
        model: 'sweep-fixture',
        dimensions: 1536,
        revision: '1',
      },
      modelRouting,
      expect.any(Function),
    );
    expect(mocks.backfillMessageEmbeddings).toHaveBeenCalledWith(
      maintenance,
      expect.objectContaining({
        embeddingSpace: expect.any(Function),
        embed: mocks.executeSqlOnlySweep,
      }),
    );
    const [, backfillOptions] = mocks.backfillMessageEmbeddings.mock.calls[0] ?? [];
    if (!backfillOptions || typeof backfillOptions !== 'object')
      throw new Error('Firestore sweep omitted embedding configuration');
    await expect(
      (backfillOptions as { embeddingSpace: () => Promise<unknown> }).embeddingSpace(),
    ).resolves.toEqual({
      provider: 'synthetic',
      model: 'sweep-fixture',
      dimensions: 1536,
      revision: '1',
    });
    expect(mocks.purgeExpired).toHaveBeenCalledWith({ maintenance, costs, recallMetrics });
    expect(mocks.purgeAgedHistory).toHaveBeenCalledWith(maintenance);
    expect(mocks.repairMissionReports).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', persistence: f.persistence }),
      20,
    );
    expect(mocks.expireStaleApprovals).toHaveBeenCalledWith(f.persistence.approvals);
    expect(mocks.resumeResolvedApprovalTasks).toHaveBeenCalledWith(f.persistence.approvals);
    expect(mocks.renotifyStalledApprovals).toHaveBeenCalledWith(
      f.persistence,
      mocks.notifyApproval,
    );
    expect(f.watches.expire).toHaveBeenCalledWith('agent-1', expect.any(Date));
    expect(mocks.runDueSchedules).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'schedule-repository', store: f.store }),
      'America/Los_Angeles',
      expect.objectContaining({ prepareGoal: expect.any(Function) }),
    );
    const options = mocks.runDueSchedules.mock.calls[0]?.[2] as {
      isJobEnabled: (job: string) => boolean;
      prepareGoal: (row: unknown, template: unknown) => Promise<unknown>;
    };
    expect(options.isJobEnabled('dream.run')).toBe(false);
    expect(options.isJobEnabled('memory.consolidate')).toBe(true);
    const row = { name: 'goal:goal-1', agentId: 'agent-1' };
    const template = { goalId: 'goal-1' };
    mocks.prepareGoalSession.mockResolvedValueOnce({ action: 'fire' });
    await expect(options.prepareGoal(row, template)).resolves.toEqual({ action: 'fire' });
    expect(mocks.prepareGoalSession).toHaveBeenCalledWith(
      { goals: f.persistence.goals, tasks: f.persistence.tasks },
      'agent-1',
      template,
    );
    // An unreadable goal skips its own firing instead of failing the batch.
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    mocks.prepareGoalSession.mockRejectedValueOnce(new Error('goal read failed'));
    await expect(options.prepareGoal(row, template)).resolves.toEqual({ action: 'skip' });
    expect(f.db.execute).not.toHaveBeenCalled();
    expect(mocks.executeSqlOnlySweep).not.toHaveBeenCalled();
  });

  it('blocks sweeps until the Firestore owner and migration are ready', async () => {
    const f = fixture();
    mocks.buildDeps.mockReturnValue(f.deps);
    mocks.firestoreMaintenanceReady.mockResolvedValue(false);

    const response = await postSweep();

    expect(response.status).toBe(503);
    expect(mocks.expireStaleApprovals).not.toHaveBeenCalled();
    expect(mocks.runDueSchedules).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });

  it('fails closed when a required portable repository is missing', async () => {
    const f = fixture();
    mocks.buildDeps.mockReturnValue({ ...f.deps, persistence: undefined });

    const response = await postSweep();

    expect(response.status).toBe(503);
    expect(mocks.expireStaleApprovals).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });
});

describe('POST /internal/tasks/execute in Firestore mode', () => {
  it('answers 503 so Cloud Tasks retries while the installation is not ready', async () => {
    const f = fixture();
    mocks.buildDeps.mockReturnValue(f.deps);
    mocks.firestoreMaintenanceReady.mockResolvedValue(false);

    const response = await internal.request(
      '/tasks/execute',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'task-1', generation: 0 }),
      },
      { INTERNAL_AUTH_MODE: 'shared-secret' },
    );

    expect(response.status).toBe(503);
    expect(mocks.firestoreMaintenanceReady).toHaveBeenCalledWith(f.deps);
    expect(f.db.execute).not.toHaveBeenCalled();
  });
});
