import { describe, expect, it } from 'vitest';
import type { Records } from './records.js';
import {
  goalAutomationEligible,
  goalOccurrenceIsCurrent,
  type ScheduleOccurrence,
} from './schedules.js';

const base = {
  id: 'goal',
  agentId: 'owner',
  status: 'active',
  archivedAt: null,
} as Records['goals'];
describe('future research records fail closed before activation', () => {
  it.each([{}, { researchAssignment: null }, { researchAssignment: undefined }])(
    'preserves legacy ordinary goals %j',
    (fields) => {
      expect(goalAutomationEligible({ ...base, ...fields })).toBe(true);
    },
  );
  it.each([false, 0, '', [], {}, { version: 1 }])(
    'rejects every present non-null assignment value %j',
    (researchAssignment) => {
      const goal = { ...base, researchAssignment };
      expect(goalAutomationEligible(goal)).toBe(false);
      const occurrence = {
        task: { agentId: 'owner', goalId: 'goal' },
        goalGuard: { goal, openTasks: [], supersedeTaskIds: [] },
      } as unknown as ScheduleOccurrence;
      expect(goalOccurrenceIsCurrent(occurrence, goal, [])).toBe(false);
    },
  );
});
