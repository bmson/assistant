import { describe, expect, it, vi } from 'vitest';
import { TaskStateSchema } from '../../events.js';
import {
  OUTPUT_VERIFICATION_SYSTEM,
  REASONING_VERIFICATION_SYSTEM,
} from '../output-verification.js';
import { stageModelFinalResponse } from './finalize.js';
import type { ExecutorDeps } from './types.js';

describe('executor supplied-context review', () => {
  it.each([
    ['Use only this fictional scenario. Compare two plans.', 'reason'],
    ['Rewrite this sentence: "Use only this fictional scenario. Compare two plans."', 'rewrite'],
  ])('classifies the authored request before reviewing: %s', async (request, role) => {
    const object = vi.fn(async (_role: string, _options: { system: string }) => ({
      ok: true,
      object: {
        decision: 'publish',
        reasons: [],
        checks: Object.fromEntries(
          ['grounding', 'feasibility', 'causalClaims', 'usefulness', 'actionScope'].map((key) => [
            key,
            { status: 'pass', explanation: 'This reply preserves the supplied facts.' },
          ]),
        ),
      },
    }));
    const state = TaskStateSchema.parse({ untrustedContext: true });
    const text = 'Compare both plans before choosing.';
    const checkpoint = vi.fn(async () => false);
    const deps = {
      db: {},
      router: { object },
      persistence: {
        tasks: { kind: 'task-lease-repository', checkpoint },
        executionEvidence: {
          kind: 'execution-evidence-repository',
          taskEvidence: async () => [],
          conversationEvidence: async () => [],
          recordResponseCheck: async () => true,
          checklistDecisions: async () => [],
        },
      },
    } as unknown as ExecutorDeps;
    await stageModelFinalResponse(
      deps,
      {
        id: 'scenario-review',
        agentId: 'owner',
        conversationId: null,
        trust: 'owner',
        type: 'adhoc',
        trigger: { source: 'internal', payload: { text: request } },
        createdAt: new Date('2026-10-18T12:00:00Z'),
      } as never,
      state,
      [{ role: 'user', content: request }],
      { text, progress: 'Answer ready.', outcome: 'done', terminalStatus: 'done' },
    );
    expect(object).toHaveBeenCalledOnce();
    expect(object.mock.calls[0]?.[0]).toBe(role);
    expect(object.mock.calls[0]?.[1].system).toBe(
      role === 'reason' ? REASONING_VERIFICATION_SYSTEM : OUTPUT_VERIFICATION_SYSTEM,
    );
    expect(state.pendingFinal?.text).toBe(text);
    expect(checkpoint).toHaveBeenCalledOnce();
  });
});
