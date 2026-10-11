import { randomUUID } from 'node:crypto';
import { createActivityCorrectionRouteFixture } from '@assistant/application/test-support';
import { resetConfigForTest } from '@assistant/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

describe('mobile Activity checklist correction in PostgreSQL mode', () => {
  const correctionMessageId = randomUUID();
  const blockedCorrectionMessageId = randomUUID();
  let fixture: Awaited<ReturnType<typeof createActivityCorrectionRouteFixture>> | undefined;
  let taskId = '';
  let blockedTaskId = '';
  let foreignTaskId = '';
  let requestText = '';
  let replacementLabel = '';
  let lookupItemId = '';
  let route: typeof import('./route.js') | undefined;
  let conversationId = '';

  beforeAll(async () => {
    if (!process.env.ASSISTANT_TEST_TARGET_TOKEN)
      throw new Error('Requires the isolated test database allocator');
    vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
    resetConfigForTest();
    auth.allowed.mockResolvedValue(true);
    [fixture, route] = await Promise.all([
      createActivityCorrectionRouteFixture(),
      import('./route.js'),
    ]);
    taskId = fixture.taskId;
    blockedTaskId = fixture.blockedTaskId;
    foreignTaskId = fixture.foreignTaskId;
    conversationId = fixture.conversationId;
    requestText = fixture.requestText;
    replacementLabel = fixture.replacementLabel;
    lookupItemId = fixture.lookupItemId;
  });

  afterAll(async () => {
    await fixture?.dispose();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  function post(id: string, extra: Record<string, unknown> = {}): Promise<Response> {
    if (!route) throw new Error('Route fixture is not initialized');
    return route.POST(
      new Request(`http://localhost/api/mobile/v1/activity/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'correct-checklist',
          itemId: lookupItemId,
          expectedRevision: 0,
          ownerMessageId: correctionMessageId,
          replacementKind: 'lookup',
          replacementLabel,
          ...extra,
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  function getCorrection(id: string, ownerMessageId: string): Promise<Response> {
    if (!route) throw new Error('Route fixture is not initialized');
    return route.GET(
      new Request(
        `http://localhost/api/mobile/v1/activity/${id}?correctionOwnerMessageId=${ownerMessageId}`,
      ),
      { params: Promise.resolve({ id }) },
    );
  }

  it('rejects invalid, unauthorized, stale, and effect-ambiguous writes without mutation', async () => {
    auth.allowed.mockResolvedValueOnce(false);
    expect((await post(taskId)).status).toBe(401);
    expect((await post(taskId, { extra: true })).status).toBe(400);
    expect((await post(taskId, { replacementKind: 'send' })).status).toBe(400);
    expect((await post(foreignTaskId)).status).toBe(404);
    const stale = await post(taskId, { expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ outcome: 'stale_revision' });
    const blocked = await post(blockedTaskId, { ownerMessageId: blockedCorrectionMessageId });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ outcome: 'unsafe_evidence' });
    if (!fixture) throw new Error('Route fixture is not initialized');
    const unchanged = await fixture.readTask(blockedTaskId);
    expect(unchanged).toMatchObject({ status: 'needs_attention', queue_generation: 7 });
    expect(unchanged?.state).toMatchObject({
      requestChecklist: fixture.checklist,
      pendingToolBatch: { calls: [{ toolCallId: 'unresolved-effect' }] },
    });
    expect(await fixture.readMessage(blockedCorrectionMessageId)).toHaveLength(0);
  });

  it('writes the selected revision, owner message, and one queue generation through the route', async () => {
    if (!route || !fixture) throw new Error('Route fixture is not initialized');
    const accepted = await post(taskId);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      outcome: 'corrected',
      transitioned: true,
      ownerMessageId: correctionMessageId,
      queueGeneration: 3,
    });
    const task = await fixture.readTask(taskId);
    expect(task).toMatchObject({ status: 'pending', queue_generation: 3, plan: null });
    expect(task?.state).toMatchObject({
      requestChecklist: {
        request: requestText,
        revision: 1,
        revisionAudit: [
          {
            revision: 1,
            taskId,
            conversationId,
            ownerTaskId: taskId,
            ownerMessageId: correctionMessageId,
            itemId: lookupItemId,
            toLabel: replacementLabel,
            toKind: 'lookup',
          },
        ],
      },
    });
    const readback = await getCorrection(taskId, correctionMessageId);
    expect(readback.status).toBe(200);
    expect(await readback.json()).toMatchObject({
      id: taskId,
      revision: 1,
      audit: {
        revision: 1,
        ownerMessageId: correctionMessageId,
        itemId: lookupItemId,
        toLabel: replacementLabel,
        toKind: 'lookup',
      },
    });
    const savedMessage = await fixture.readMessage(correctionMessageId);
    expect(savedMessage).toMatchObject([
      {
        id: correctionMessageId,
        task_id: taskId,
        conversation_id: conversationId,
        role: 'user',
        origin: 'owner',
        text: replacementLabel,
      },
    ]);
    const replay = await post(taskId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: 'already_applied', transitioned: false });
    expect((await fixture.readTask(taskId))?.queue_generation).toBe(3);
  });
});
