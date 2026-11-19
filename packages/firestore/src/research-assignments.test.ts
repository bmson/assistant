import {
  createResearchAssignment,
  type Records,
  type ResearchAssignmentOptionsSubmission,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { FirestoreGoalMutationRepository } from './goal-mutations.js';
import { FirestoreResearchAssignmentRepository } from './research-assignments.js';
import { encodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore research assignments', () => {
  it('creates and reopens a draft without creating tasks or schedules', async () => {
    const store = emulatorStore();
    const agentId = 'owner';
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      const repository = new FirestoreResearchAssignmentRepository(store, agentId);
      const goalMutations = new FirestoreGoalMutationRepository(store, agentId);
      const created = await repository.create({
        outcome: 'Research three gardening gifts',
        recipientName: 'Synthetic recipient',
        interests: ['gardening'],
        completionCondition: 'Owner accepts the shortlist',
        now: new Date('2026-11-06T18:00:00.000Z'),
      });
      const initial = (await store.doc('goals', created.goalId).get()).data();
      expect(initial?.researchAssignment.status).toBe('draft');
      expect(initial?.researchAssignment.scope).toEqual({
        kind: 'research_only',
        contactAllowed: false,
        purchaseAllowed: false,
      });
      const foreignAssignment = createResearchAssignment({
        assignmentId: 'synthetic-foreign-assignment',
        outcome: 'Synthetic foreign-owner assignment',
        completionCondition: 'Owner accepts the shortlist',
        now: new Date('2026-11-06T18:00:00.000Z'),
      });
      const foreignGoal: Records['goals'] = {
        id: 'synthetic-foreign-goal',
        agentId: 'synthetic-foreign-owner',
        title: foreignAssignment.outcome,
        description: '',
        status: 'active',
        priority: 3,
        progress: '',
        nextAction: '',
        targetDate: null,
        mirrorToPrimary: false,
        taintedOrigin: false,
        autonomy: false,
        archivedAt: null,
        researchAssignment: foreignAssignment,
        createdAt: new Date('2026-11-06T18:00:00.000Z'),
        updatedAt: new Date('2026-11-06T18:00:00.000Z'),
      };
      await store.doc('goals', foreignGoal.id).set(encodeRecord(foreignGoal));
      await expect(
        repository.edit(foreignGoal.id, { outcome: 'Unauthorized update' }),
      ).rejects.toThrow('Research assignment not found');
      expect((await store.doc('goals', foreignGoal.id).get()).data()?.researchAssignment).toEqual(
        foreignAssignment,
      );
      await expect(
        goalMutations.startWork(created.goalId, () => ({
          cron: '0 9 * * *',
          instruction: 'run',
          nextRunAt: () => new Date('2026-11-07T09:00:00.000Z'),
        })),
      ).rejects.toThrow('Research assignments');
      await expect(goalMutations.setStatus(created.goalId, 'paused')).rejects.toThrow(
        'Research assignments',
      );
      await expect(goalMutations.setAutonomy(created.goalId, true)).rejects.toThrow(
        'Research assignments',
      );
      await expect(
        goalMutations.updateSettings(
          created.goalId,
          {
            title: 'Changed',
            description: '',
            priority: 3,
            targetDate: null,
            progress: '',
            nextAction: '',
            mirrorToPrimary: false,
          },
          { cron: '0 9 * * *', instruction: 'run' },
        ),
      ).rejects.toThrow('Research assignments');
      const afterRejectedMutations = (await store.doc('goals', created.goalId).get()).data();
      expect(afterRejectedMutations?.status).toBe('active');
      expect(afterRejectedMutations?.autonomy).toBe(false);
      expect(afterRejectedMutations?.title).toBe('Research three gardening gifts');
      expect(
        (await store.collection('tasks').where('goalId', '==', created.goalId).get()).size,
      ).toBe(0);
      expect(
        (await store.collection('schedules').where('name', '==', `goal:${created.goalId}`).get())
          .size,
      ).toBe(0);

      const firstResultInput: ResearchAssignmentOptionsSubmission = {
        expectedBriefRevision: 1,
        expectedResultRevision: null,
        options: [
          {
            id: 'synthetic-option',
            title: 'Synthetic seed kit',
            description: '',
            sourceName: 'Synthetic catalog',
            itemCost: '40',
            taxCost: '4',
            deliveryCost: null,
            currency: 'USD',
            availability: 'stale',
            deliveryConfidence: 'unknown',
          },
        ],
      };
      await repository.recordOptions(created.goalId, firstResultInput);
      await repository.recordOptions(created.goalId, {
        ...firstResultInput,
        expectedResultRevision: 1,
      });
      const researched = (await store.doc('goals', created.goalId).get()).data();
      expect(researched?.researchAssignment.status).toBe('waiting_for_decision');
      expect(researched?.researchAssignment.evidence.options[0].totalCost).toBeNull();
      expect(researched?.researchAssignment.evidence.unverifiedCount).toBe(1);

      await repository.edit(created.goalId, { outcome: 'Updated synthetic gift research' });
      await repository.edit(created.goalId, { exclusions: ['synthetic exclusion'] });
      await expect(
        repository.recordOptions(created.goalId, {
          expectedBriefRevision: 1,
          expectedResultRevision: 1,
          options: [
            {
              id: 'stale-option',
              title: 'Stale',
              description: '',
              sourceName: 'Synthetic catalog',
              itemCost: null,
              taxCost: null,
              deliveryCost: null,
              currency: null,
              availability: 'unknown',
              deliveryConfidence: 'unknown',
            },
          ],
        }),
      ).rejects.toThrow('brief changed');
      const currentInput = {
        expectedBriefRevision: 3,
        expectedResultRevision: 2,
        options: [
          {
            id: 'current-option',
            title: 'Current',
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
      await repository.recordOptions(created.goalId, currentInput);
      await expect(repository.recordOptions(created.goalId, currentInput)).rejects.toThrow(
        'result changed',
      );

      const acceptanceAssignment = await repository.create({
        outcome: 'Synthetic acceptance counter research',
        completionCondition: 'Owner accepts the shortlist',
        now: new Date('2026-11-06T18:00:00.000Z'),
      });
      await repository.edit(acceptanceAssignment.goalId, { outcome: 'Edited once' });
      await repository.edit(acceptanceAssignment.goalId, { exclusions: ['synthetic'] });
      await repository.recordOptions(acceptanceAssignment.goalId, {
        expectedBriefRevision: 3,
        expectedResultRevision: null,
        options: firstResultInput.options,
      });
      await repository.acceptShortlist(acceptanceAssignment.goalId, 1);
      const acceptedReadback = (await store.doc('goals', acceptanceAssignment.goalId).get()).data();
      expect(acceptedReadback?.researchAssignment).toMatchObject({
        status: 'completed',
        briefRevision: 3,
        resultBriefRevision: 3,
        evidence: { resultRevision: 1 },
        completion: { resultRevision: 1 },
      });

      await repository.reopen(created.goalId);
      const reopened = (await store.doc('goals', created.goalId).get()).data();
      expect(reopened?.researchAssignment.status).toBe('needs_recheck');
      expect(reopened?.researchAssignment.evidence.options).toHaveLength(1);
      expect(
        (await store.collection('tasks').where('goalId', '==', created.goalId).get()).size,
      ).toBe(0);
      expect(
        (await store.collection('schedules').where('name', '==', `goal:${created.goalId}`).get())
          .size,
      ).toBe(0);
    } finally {
      await disposeStore(store);
    }
  });
});
