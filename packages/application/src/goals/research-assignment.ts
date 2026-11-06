import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { type Db, goals } from '@assistant/db';
import {
  acceptResearchShortlist,
  assertResearchAssignmentState,
  createResearchAssignment,
  editResearchAssignmentBrief,
  type NewResearchAssignmentInput,
  type ResearchAssignmentBriefPatch,
  type ResearchAssignmentOptionsSubmission,
  recordResearchAssignmentOptions,
  reopenResearchAssignment,
  setResearchAssignmentStoppedState,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';

export async function createResearchAssignmentRecord(
  db: Db,
  input: Omit<NewResearchAssignmentInput, 'assignmentId'>,
): Promise<{ goalId: string; assignmentId: string }> {
  const agent = await getAgent(db);
  const goalId = randomUUID();
  const assignmentId = randomUUID();
  const assignment = createResearchAssignment({ ...input, assignmentId });
  if (!assignment.outcome || !assignment.completionCondition)
    throw new Error('Outcome and completion condition are required');
  await db.insert(goals).values({
    id: goalId,
    agentId: agent.id,
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
  });
  return { goalId, assignmentId };
}

async function getAssignmentForUpdate(db: Db, goalId: string, agentId: string) {
  const [goal] = await db
    .select({
      id: goals.id,
      archivedAt: goals.archivedAt,
      researchAssignment: goals.researchAssignment,
    })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agentId)))
    .for('update');
  if (!goal?.researchAssignment || goal.archivedAt)
    throw new Error('Research assignment not found');
  assertResearchAssignmentState(goal.researchAssignment);
  return goal.researchAssignment;
}

export async function editResearchAssignmentRecord(
  db: Db,
  goalId: string,
  patch: ResearchAssignmentBriefPatch,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const agent = await getAgent(tx as unknown as Db);
    const current = await getAssignmentForUpdate(tx as unknown as Db, goalId, agent.id);
    const next = editResearchAssignmentBrief(current, patch, now);
    await tx
      .update(goals)
      .set({
        researchAssignment: next,
        title: next.outcome.slice(0, 120),
        targetDate: next.deadline.at ? new Date(next.deadline.at) : null,
        updatedAt: now,
      })
      .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)));
  });
}

export async function reopenResearchAssignmentRecord(
  db: Db,
  goalId: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const agent = await getAgent(tx as unknown as Db);
    const current = await getAssignmentForUpdate(tx as unknown as Db, goalId, agent.id);
    const next = reopenResearchAssignment(current, now);
    await tx
      .update(goals)
      .set({ researchAssignment: next, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)));
  });
}

export async function setResearchAssignmentStoppedStateRecord(
  db: Db,
  goalId: string,
  status: 'paused' | 'cancelled',
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const agent = await getAgent(tx as unknown as Db);
    const current = await getAssignmentForUpdate(tx as unknown as Db, goalId, agent.id);
    const next = setResearchAssignmentStoppedState(current, status, now);
    await tx
      .update(goals)
      .set({ researchAssignment: next, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)));
  });
}

export async function recordResearchAssignmentOptionsRecord(
  db: Db,
  goalId: string,
  input: ResearchAssignmentOptionsSubmission,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const agent = await getAgent(tx as unknown as Db);
    const current = await getAssignmentForUpdate(tx as unknown as Db, goalId, agent.id);
    const next = recordResearchAssignmentOptions(current, input, now);
    await tx
      .update(goals)
      .set({
        researchAssignment: next,
        progress: `Research checked at ${now.toISOString()}.`,
        updatedAt: now,
      })
      .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)));
  });
}

export async function acceptResearchAssignmentShortlist(
  db: Db,
  goalId: string,
  resultRevision: number,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const agent = await getAgent(tx as unknown as Db);
    const current = await getAssignmentForUpdate(tx as unknown as Db, goalId, agent.id);
    const next = acceptResearchShortlist(current, resultRevision, now);
    await tx
      .update(goals)
      .set({ researchAssignment: next, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)));
  });
}
