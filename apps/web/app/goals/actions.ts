'use server';

import {
  archiveGoalRecord,
  archiveInactiveGoalRecords,
  changeGoalAutonomy,
  changeGoalStatus,
  createGoalWithWork,
  type GoalInput,
  type GoalStatus,
  restoreGoalRecord,
  startExistingGoalWork,
  updateGoalSettings,
} from '@assistant/application/goals';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreGoalMutationRepository } from '@assistant/firestore';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import { parseGoalTargetDate } from '@/lib/goal-input';
import {
  createFirestoreGoalWithWork,
  getDb,
  getFirestoreGoalScheduleUpdate,
  getFirestoreInstallationStore,
  startFirestoreGoalWork,
} from '@/lib/server';

export interface GoalFormState {
  error: string | null;
  /** Submitted fields echoed back on error — React resets the form after every action. */
  values?: Record<string, string>;
}

const FORM_FIELDS = ['title', 'description', 'priority', 'targetDate', 'progress', 'nextAction'];

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

function echo(formData: FormData): Record<string, string> {
  return Object.fromEntries(FORM_FIELDS.map((name) => [name, field(formData, name)]));
}

function parseGoalForm(formData: FormData): { form: GoalInput } | { error: string } {
  const title = field(formData, 'title');
  if (!title) return { error: 'Title is required.' };

  const priority = Number.parseInt(field(formData, 'priority') || '3', 10);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    return { error: 'Priority must be between 1 and 5.' };
  }

  const parsedTargetDate = parseGoalTargetDate(field(formData, 'targetDate'));
  if (!parsedTargetDate.ok) return { error: parsedTargetDate.error };

  return {
    form: {
      title,
      description: field(formData, 'description'),
      priority,
      targetDate: parsedTargetDate.value,
      progress: field(formData, 'progress'),
      nextAction: field(formData, 'nextAction'),
      mirrorToPrimary: formData.get('mirrorToPrimary') != null,
    },
  };
}

function revalidateGoalViews(): void {
  revalidatePath('/');
  revalidatePath('/goals');
  revalidatePath('/settings');
}

function workChatUrl(work: {
  conversationId: string;
  taskId: string;
  messageCursor: string;
}): string {
  const query = new URLSearchParams({ task: work.taskId, cursor: work.messageCursor });
  return `/chat/${work.conversationId}?${query.toString()}`;
}

function firestoreGoals(): FirestoreGoalMutationRepository {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  return new FirestoreGoalMutationRepository(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
}

export async function createGoal(_prev: GoalFormState, formData: FormData): Promise<GoalFormState> {
  await requireOwner();
  const parsed = parseGoalForm(formData);
  if ('error' in parsed) return { error: parsed.error, values: echo(formData) };

  const work =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await createFirestoreGoalWithWork(parsed.form)
      : await createGoalWithWork(getDb(), parsed.form);
  revalidateGoalViews();
  redirect(workChatUrl(work));
}

export async function startGoalWork(goalId: string): Promise<void> {
  await requireOwner();
  const work =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await startFirestoreGoalWork(goalId)
      : await startExistingGoalWork(getDb(), goalId);
  revalidateGoalViews();
  redirect(workChatUrl(work));
}

export async function updateGoal(_prev: GoalFormState, formData: FormData): Promise<GoalFormState> {
  await requireOwner();
  const goalId = String(formData.get('goalId') ?? '');
  if (!goalId) return { error: 'Missing goal id.', values: echo(formData) };
  const parsed = parseGoalForm(formData);
  if ('error' in parsed) return { error: parsed.error, values: echo(formData) };

  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await firestoreGoals().updateSettings(
      goalId,
      parsed.form,
      getFirestoreGoalScheduleUpdate(goalId, parsed.form),
    );
  } else {
    await updateGoalSettings(getDb(), goalId, parsed.form);
  }
  revalidateGoalViews();
  return { error: null };
}

export async function setGoalStatus(goalId: string, status: GoalStatus): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    await firestoreGoals().setStatus(goalId, status);
  else await changeGoalStatus(getDb(), goalId, status);
  revalidateGoalViews();
}

export async function setGoalAutonomy(goalId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    await firestoreGoals().setAutonomy(goalId, enabled);
  else await changeGoalAutonomy(getDb(), goalId, enabled);
  revalidateGoalViews();
}

export async function archiveGoal(goalId: string): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') await firestoreGoals().archive(goalId);
  else await archiveGoalRecord(getDb(), goalId);
  revalidateGoalViews();
  redirect('/goals');
}

export async function restoreGoal(goalId: string): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') await firestoreGoals().restore(goalId);
  else await restoreGoalRecord(getDb(), goalId);
  revalidateGoalViews();
  redirect('/goals');
}

export async function archiveInactiveGoals(): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') await firestoreGoals().archiveInactive();
  else await archiveInactiveGoalRecords(getDb());
  revalidateGoalViews();
  redirect('/goals');
}
