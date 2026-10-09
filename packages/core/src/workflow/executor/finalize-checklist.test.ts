import type { ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type PendingFinal, TaskStateSchema } from '../../events.js';
import type { TaskLease } from '../machine.js';
import { buildRequestChecklist } from '../request-checklist.js';
import type { ExecutorDeps } from './types.js';

const { checkpoint } = vi.hoisted(() => ({ checkpoint: vi.fn().mockResolvedValue(false) }));
vi.mock('../machine.js', async (original) => ({
  ...(await original<typeof import('../machine.js')>()),
  checkpointTask: checkpoint,
}));
vi.mock('./checklist.js', () => ({ refreshRequestChecklist: vi.fn() }));

import { stageFinalResponse } from './finalize.js';

describe('checklist finalization boundary', () => {
  beforeEach(() => checkpoint.mockClear());
  it('preserves the checked completed answer alongside the unfinished sibling', async () => {
    const state = TaskStateSchema.parse({
      requestChecklist: buildRequestChecklist('Find my hotel and remind me'),
    });
    const text = 'The booking confirmation identifies Harbor Hotel, check-in October 12 at 3 PM.';
    const window: ModelMessage[] = [{ role: 'assistant', content: text }];
    await stageFinalResponse({} as ExecutorDeps, {} as TaskLease, state, window, {
      text,
      outcome: 'done',
      terminalStatus: 'done',
      progress: text,
      contractBlocked: false,
    });
    expect(state.pendingFinal?.text).toContain(text);
    expect(state.pendingFinal?.text).toContain('Not completed: remind me');
    expect(state.pendingFinal?.terminalStatus).toBe('needs_attention');
  });
  it.each(['done', 'clarify'] as const)(
    'checkpoints an honest partial %s before any delivery',
    async (outcome) => {
      const state = TaskStateSchema.parse({
        requestChecklist: buildRequestChecklist('Find my hotel and remind me'),
      });
      const text = outcome === 'clarify' ? 'When should I remind you?' : 'All done.';
      const window: ModelMessage[] = [{ role: 'assistant', content: text }];
      const pending: PendingFinal = { text, outcome, terminalStatus: 'done', progress: text };
      const result = await stageFinalResponse(
        {} as ExecutorDeps,
        {} as TaskLease,
        state,
        window,
        pending,
      );
      expect(result.outcome).toBe('not_claimable');
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(state.pendingFinal?.terminalStatus).toBe('needs_attention');
      expect(state.pendingFinal?.text).toContain('Not completed: remind me');
      expect(state.pendingFinal?.text).not.toContain('All done.');
      if (outcome === 'clarify')
        expect(state.pendingFinal?.text).toContain('When should I remind you?');
      expect(window.at(-1)?.content).toBe(state.pendingFinal?.text);
    },
  );
});
