import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { agents, createDb, goals, schedules, tasks } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { createResearchAssignment } from '@assistant/persistence';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  changeGoalAutonomy,
  changeGoalStatus,
  startExistingGoalWork,
  updateGoalSettings,
} from './commands.js';
import {
  acceptResearchAssignmentShortlist,
  createResearchAssignmentRecord,
  editResearchAssignmentRecord,
  recordResearchAssignmentOptionsRecord,
  reopenResearchAssignmentRecord,
} from './research-assignment.js';

const databaseUrl = process.env.DATABASE_URL;
const now = new Date('2026-11-06T18:00:00.000Z');
assertAllocatedTestTarget({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});
if (!databaseUrl) throw new Error('Missing allocated test database URL');

describe('PostgreSQL research-only assignment lifecycle', () => {
  it('creates and reopens without task or schedule side effects', async () => {
    const db = createDb(databaseUrl, { max: 1, statementTimeoutMs: 10_000 });
    let goalId: string | null = null;
    let acceptanceGoalId: string | null = null;
    let foreignAgentId: string | null = null;
    let foreignGoalId: string | null = null;
    try {
      const created = await createResearchAssignmentRecord(db, {
        outcome: 'Synthetic gardening gift research',
        recipientName: 'Synthetic recipient',
        interests: ['gardening'],
        completionCondition: 'Owner accepts the shortlist',
        now: new Date('2026-11-06T18:00:00.000Z'),
      });
      goalId = created.goalId;
      const [row] = await db
        .select({ assignment: goals.researchAssignment })
        .from(goals)
        .where(eq(goals.id, goalId));
      expect(row?.assignment?.status).toBe('draft');
      expect(row?.assignment?.scope.purchaseAllowed).toBe(false);
      await expect(startExistingGoalWork(db, goalId)).rejects.toThrow('Research assignments');
      await expect(changeGoalStatus(db, goalId, 'paused')).rejects.toThrow('Research assignments');
      await expect(changeGoalAutonomy(db, goalId, true)).rejects.toThrow('Research assignments');
      await expect(
        updateGoalSettings(db, goalId, {
          title: 'changed',
          description: '',
          priority: 3,
          targetDate: null,
          progress: '',
          nextAction: '',
          mirrorToPrimary: false,
        }),
      ).rejects.toThrow('Research assignments');
      const [afterRejectedMutations] = await db
        .select({ status: goals.status, autonomy: goals.autonomy, title: goals.title })
        .from(goals)
        .where(eq(goals.id, goalId));
      expect(afterRejectedMutations).toEqual({
        status: 'active',
        autonomy: false,
        title: 'Synthetic gardening gift research',
      });

      const owner = await getAgent(db);
      foreignAgentId = randomUUID();
      foreignGoalId = randomUUID();
      await db.insert(agents).values({
        id: foreignAgentId,
        name: 'Synthetic second owner',
        email: `${foreignAgentId}@example.test`,
        workspacePrefix: foreignAgentId,
        createdAt: new Date(owner.createdAt.getTime() + 60_000),
      });
      const foreignAssignment = createResearchAssignment({
        assignmentId: randomUUID(),
        outcome: 'Synthetic foreign-owner assignment',
        completionCondition: 'Owner accepts the shortlist',
        now,
      });
      await db.insert(goals).values({
        id: foreignGoalId,
        agentId: foreignAgentId,
        title: foreignAssignment.outcome,
        researchAssignment: foreignAssignment,
      });
      await expect(
        editResearchAssignmentRecord(db, foreignGoalId, { outcome: 'Unauthorized change' }),
      ).rejects.toThrow('Research assignment not found');
      const [foreignReadback] = await db
        .select({ researchAssignment: goals.researchAssignment })
        .from(goals)
        .where(eq(goals.id, foreignGoalId));
      expect(foreignReadback?.researchAssignment).toEqual(foreignAssignment);

      const resultInput = {
        expectedBriefRevision: 1,
        expectedResultRevision: null,
        options: [
          {
            id: 'synthetic-option',
            title: 'Synthetic option',
            description: '',
            sourceName: 'Synthetic catalog',
            itemCost: null,
            taxCost: null,
            deliveryCost: null,
            currency: null,
            availability: 'unknown' as const,
            deliveryConfidence: 'unknown' as const,
          },
        ],
      };
      await recordResearchAssignmentOptionsRecord(db, goalId, resultInput);
      const secondSameBrief = {
        ...resultInput,
        expectedResultRevision: 1,
      };
      await recordResearchAssignmentOptionsRecord(db, goalId, secondSameBrief);
      await editResearchAssignmentRecord(db, goalId, { outcome: 'Updated synthetic research' });
      await editResearchAssignmentRecord(db, goalId, { exclusions: ['synthetic exclusion'] });
      await expect(recordResearchAssignmentOptionsRecord(db, goalId, resultInput)).rejects.toThrow(
        'brief changed',
      );
      const currentResultInput = {
        ...resultInput,
        expectedBriefRevision: 3,
        expectedResultRevision: 2,
      };
      await recordResearchAssignmentOptionsRecord(db, goalId, currentResultInput);
      await expect(
        recordResearchAssignmentOptionsRecord(db, goalId, currentResultInput),
      ).rejects.toThrow('result changed');

      const acceptanceAssignment = await createResearchAssignmentRecord(db, {
        outcome: 'Synthetic acceptance counter research',
        completionCondition: 'Owner accepts the shortlist',
        now,
      });
      acceptanceGoalId = acceptanceAssignment.goalId;
      await editResearchAssignmentRecord(db, acceptanceGoalId, { outcome: 'Edited once' });
      await editResearchAssignmentRecord(db, acceptanceGoalId, { exclusions: ['synthetic'] });
      await recordResearchAssignmentOptionsRecord(db, acceptanceGoalId, {
        expectedBriefRevision: 3,
        expectedResultRevision: null,
        options: resultInput.options,
      });
      await acceptResearchAssignmentShortlist(db, acceptanceGoalId, 1);
      const [acceptedReadback] = await db
        .select({ researchAssignment: goals.researchAssignment })
        .from(goals)
        .where(eq(goals.id, acceptanceGoalId));
      expect(acceptedReadback?.researchAssignment).toMatchObject({
        status: 'completed',
        briefRevision: 3,
        resultBriefRevision: 3,
        evidence: { resultRevision: 1 },
        completion: { resultRevision: 1 },
      });
      expect(
        Number(
          (await db.select({ total: count() }).from(tasks).where(eq(tasks.goalId, goalId)))[0]
            ?.total ?? 0,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await db
              .select({ total: count() })
              .from(schedules)
              .where(eq(schedules.name, `goal:${goalId}`))
          )[0]?.total ?? 0,
        ),
      ).toBe(0);

      await reopenResearchAssignmentRecord(db, goalId, new Date('2026-11-07T18:00:00.000Z'));
      const [reopened] = await db
        .select({ assignment: goals.researchAssignment })
        .from(goals)
        .where(eq(goals.id, goalId));
      expect(reopened?.assignment?.status).toBe('needs_recheck');
      expect(
        Number(
          (await db.select({ total: count() }).from(tasks).where(eq(tasks.goalId, goalId)))[0]
            ?.total ?? 0,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await db
              .select({ total: count() })
              .from(schedules)
              .where(eq(schedules.name, `goal:${goalId}`))
          )[0]?.total ?? 0,
        ),
      ).toBe(0);
    } finally {
      if (acceptanceGoalId) await db.delete(goals).where(eq(goals.id, acceptanceGoalId));
      if (foreignGoalId) await db.delete(goals).where(eq(goals.id, foreignGoalId));
      if (foreignAgentId) await db.delete(agents).where(eq(agents.id, foreignAgentId));
      if (goalId) await db.delete(goals).where(eq(goals.id, goalId));
      await db.$client.end();
    }
  });
});
