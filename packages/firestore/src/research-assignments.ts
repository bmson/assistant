import { randomUUID } from 'node:crypto';
import {
  acceptResearchShortlist,
  assertResearchAssignmentState,
  createResearchAssignment,
  editResearchAssignmentBrief,
  type NewResearchAssignmentInput,
  type Records,
  type ResearchAssignmentBriefPatch,
  type ResearchAssignmentOptionsSubmission,
  type ResearchAssignmentState,
  recordResearchAssignmentOptions,
  reopenResearchAssignment,
  setResearchAssignmentStoppedState,
} from '@assistant/persistence';
import {
  assertPrivacyErasureFenceUnchanged,
  privacyErasureIsActive,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Goal = Records['goals'];

/** Firestore lifecycle writes deliberately touch only the goal document. */
export class FirestoreResearchAssignmentRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async create(input: Omit<NewResearchAssignmentInput, 'assignmentId'>) {
    const goalId = randomUUID();
    const assignmentId = randomUUID();
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    const now = this.store.now();
    const assignment = createResearchAssignment({ ...input, assignmentId, now });
    if (!assignment.outcome || !assignment.completionCondition)
      throw new Error('Outcome and completion condition are required');
    await this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        !this.configuredAgentId ||
        owners.size !== 1 ||
        !owner ||
        owner.get('id') !== this.configuredAgentId ||
        owner.id !== documentKey(this.configuredAgentId)
      )
        throw new Error('Research assignments require exactly one configured owner');
      const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
      const goalRef = this.store.doc('goals', goalId);
      const [erasure, collision] = await tx.getAll(erasureRef, goalRef);
      if (erasure?.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      if (fence ? !erasure?.updateTime?.isEqual(fence) : erasure?.exists)
        throw new Error('Privacy erasure changed during assignment creation');
      if (!collision || collision.exists) throw new Error('assignment ID collision');
      const goal: Goal = {
        id: goalId,
        agentId: this.configuredAgentId,
        createdAt: now,
        updatedAt: now,
        title: assignment.outcome.slice(0, 120),
        description:
          'Research-only assignment. No contact, purchase, reservation, or checkout is allowed.',
        status: 'active',
        priority: 3,
        progress: '',
        nextAction: 'This assignment is saved as a draft. Start remains an explicit owner action.',
        targetDate: assignment.deadline.at ? new Date(assignment.deadline.at) : null,
        mirrorToPrimary: false,
        taintedOrigin: false,
        autonomy: false,
        archivedAt: null,
        researchAssignment: assignment,
      };
      tx.set(goalRef, encodeRecord(goal));
    });
    await assertPrivacyErasureFenceUnchanged(this.store, this.configuredAgentId, fence);
    return { goalId, assignmentId };
  }

  async edit(goalId: string, patch: ResearchAssignmentBriefPatch) {
    return this.mutate(goalId, (assignment, now) =>
      editResearchAssignmentBrief(assignment, patch, now),
    );
  }

  async reopen(goalId: string) {
    return this.mutate(goalId, (assignment, now) => reopenResearchAssignment(assignment, now));
  }

  async setStoppedState(goalId: string, status: 'paused' | 'cancelled') {
    return this.mutate(goalId, (assignment, now) =>
      setResearchAssignmentStoppedState(assignment, status, now),
    );
  }

  async acceptShortlist(goalId: string, resultRevision: number) {
    return this.mutate(goalId, (assignment, now) =>
      acceptResearchShortlist(assignment, resultRevision, now),
    );
  }

  async recordOptions(
    goalId: string,
    input: ResearchAssignmentOptionsSubmission,
  ) {
    return this.mutate(goalId, (assignment, now) =>
      recordResearchAssignmentOptions(assignment, input, now),
    );
  }

  private async mutate(
    goalId: string,
    update: (assignment: ResearchAssignmentState, now: Date) => ResearchAssignmentState,
  ): Promise<void> {
    if (!goalId || !this.configuredAgentId)
      throw new Error('Assignment mutation requires the configured owner');
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    await this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.get('id') !== this.configuredAgentId ||
        owner.id !== documentKey(this.configuredAgentId)
      )
        throw new Error('Research assignments require exactly one configured owner');
      const goalRef = this.store.doc('goals', goalId);
      const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
      const [goalDoc, erasure] = await tx.getAll(goalRef, erasureRef);
      if (!goalDoc || !goalDoc.exists) throw new Error('Research assignment not found');
      if (erasure?.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      if (fence ? !erasure?.updateTime?.isEqual(fence) : erasure?.exists)
        throw new Error('Privacy erasure changed during assignment mutation');
      const goal = decodeRecord<Goal>(goalDoc.data());
      if (
        documentKey(goal.id) !== goalDoc.id ||
        goal.id !== goalId ||
        goal.agentId !== this.configuredAgentId ||
        goal.archivedAt
      )
        throw new Error('Research assignment not found');
      if (!goal.researchAssignment) throw new Error('Research assignment not found');
      assertResearchAssignmentState(goal.researchAssignment);
      const now = this.store.now();
      const assignment = update(goal.researchAssignment, now);
      tx.update(
        goalRef,
        encodeRecord({
          researchAssignment: assignment,
          title: assignment.outcome.slice(0, 120),
          ...(assignment.evidence.resultRevision !== goal.researchAssignment.evidence.resultRevision
            ? { progress: `Research checked at ${now.toISOString()}.` }
            : {}),
          targetDate: assignment.deadline.at ? new Date(assignment.deadline.at) : null,
          updatedAt: now,
        }),
      );
    });
    await assertPrivacyErasureFenceUnchanged(this.store, this.configuredAgentId, fence);
  }
}
