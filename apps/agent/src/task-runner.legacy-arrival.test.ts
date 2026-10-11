import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from './deps.js';

const executeTaskSpy = vi.hoisted(() => vi.fn(async () => ({ outcome: 'executed' as const })));
vi.mock('@assistant/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core')>()),
  executeTask: executeTaskSpy,
}));

const { executeAgentTask } = await import('./task-runner.js');

const AGENT = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const instruction =
  'Accurate location observations at least three minutes apart suggest the owner has stopped near a new area: an unlabeled place (lat 47.1234, lng -122.5678). Decide whether one proactive note is worth a push right now.';

function task(trigger: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: TASK,
    agentId: AGENT,
    type: 'adhoc',
    trust: 'assistant',
    conversationId: null,
    parentTaskId: null,
    externalEventId: `arrival:${AGENT}:2026-09-24:47.12,-122.57`,
    trigger,
    ...overrides,
  };
}

function dependencies(record: Record<string, unknown>) {
  const lease = { id: TASK, agentId: AGENT, leaseToken: 'lease' };
  const taskRepository = {
    getTask: vi.fn(async () => record),
    claim: vi.fn(async () => lease),
    completeTask: vi.fn(async () => true),
  };
  const modules = {
    taskHandlerFor: vi.fn(() => undefined),
    taskKindUnavailable: vi.fn(() => null),
  };
  const deps = {
    db: {},
    persistence: { tasks: taskRepository },
    config: { PERSISTENCE_DRIVER: 'postgres' },
    modules,
  } as unknown as AgentDeps;
  return { deps, taskRepository, modules };
}

describe('legacy arrival retirement', () => {
  it('cancels the exact old arrival envelope before model execution and with location-free status', async () => {
    executeTaskSpy.mockClear();
    const legacyTask = task({
      source: 'internal',
      agentId: AGENT,
      trust: 'assistant',
      externalEventId: `arrival:${AGENT}:2026-09-24:47.12,-122.57`,
      payload: { instruction },
    });
    const { deps, taskRepository } = dependencies(legacyTask);

    await expect(executeAgentTask(deps, TASK, 0)).resolves.toEqual({
      outcome: 'cancelled',
      detail: 'Retired a legacy arrival task because its short-lived observation is unavailable.',
    });

    expect(taskRepository.claim).toHaveBeenCalledOnce();
    expect(taskRepository.completeTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        status: 'cancelled',
        progress:
          'Retired a legacy arrival task because its short-lived observation is unavailable.',
      }),
    );
    expect(JSON.stringify(taskRepository.completeTask.mock.calls)).not.toContain('47.1234');
    expect(JSON.stringify(taskRepository.completeTask.mock.calls)).not.toContain('-122.5678');
    expect(executeTaskSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['different trigger source', { source: 'chat' }],
    ['different agent', { agentId: '00000000-0000-4000-8000-000000000099' }],
    ['different trigger trust', { trust: 'owner' }],
    ['extra payload key', { payload: { instruction, kind: 'other' } }],
    ['different event key', { externalEventId: `arrival:${AGENT}:2026-09-24` }],
  ])('does not retire an envelope with %s', async (_label, change) => {
    executeTaskSpy.mockClear().mockResolvedValue({ outcome: 'executed' });
    const legacyTask = task({
      source: 'internal',
      agentId: AGENT,
      trust: 'assistant',
      externalEventId: `arrival:${AGENT}:2026-09-24:47.12,-122.57`,
      payload: { instruction },
      ...change,
    });
    const { deps, taskRepository } = dependencies(legacyTask);

    await expect(executeAgentTask(deps, TASK, 0)).resolves.toEqual({ outcome: 'executed' });
    expect(taskRepository.claim).not.toHaveBeenCalled();
    expect(taskRepository.completeTask).not.toHaveBeenCalled();
    expect(executeTaskSpy).toHaveBeenCalledOnce();
  });

  it('does not retire an owner conversation or a child task with the old instruction marker', async () => {
    for (const overrides of [{ conversationId: 'conversation' }, { parentTaskId: 'parent-task' }]) {
      executeTaskSpy.mockClear().mockResolvedValue({ outcome: 'executed' });
      const { deps, taskRepository } = dependencies(
        task(
          {
            source: 'internal',
            agentId: AGENT,
            trust: 'assistant',
            externalEventId: `arrival:${AGENT}:2026-09-24:47.12,-122.57`,
            payload: { instruction },
          },
          overrides,
        ),
      );

      await expect(executeAgentTask(deps, TASK, 0)).resolves.toEqual({ outcome: 'executed' });
      expect(taskRepository.claim).not.toHaveBeenCalled();
      expect(executeTaskSpy).toHaveBeenCalledOnce();
    }
  });
});
