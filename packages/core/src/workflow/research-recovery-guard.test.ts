import type { GoalRuntimeRepository, Records, TaskRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { prepareGoalSession } from './schedules.js';

describe('research recovery preparation', () => {
  it.each([false, 0, '', {}, { version: 1 }])(
    'disables future assignment %j before session admission',
    async (researchAssignment) => {
      const ownerRepliedSince = vi.fn(() => {
        throw new Error('must not run session gate');
      });
      const goal = {
        id: 'goal',
        agentId: 'owner',
        status: 'active',
        archivedAt: null,
        researchAssignment,
      } as unknown as Records['goals'];
      const goals = {
        sessionState: vi.fn().mockResolvedValue({ goal, openTasks: [], recentSessions: [] }),
        ownerRepliedSince,
      } as unknown as GoalRuntimeRepository;
      expect(
        await prepareGoalSession({ goals, tasks: {} as TaskRepository }, 'owner', {
          goalId: 'goal',
        }),
      ).toEqual({ action: 'disable' });
      expect(ownerRepliedSince).not.toHaveBeenCalled();
    },
  );
});
