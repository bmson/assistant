'use server';

import { updateBudgetCaps, updateBudgetCapsWithRepository } from '@assistant/application/costs';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore, FirestoreBudgetCapsRepository } from '@assistant/firestore';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { dispatchBudgetWakes } from '@/lib/budget-wakes';
import { getDb } from '@/lib/server';

/** Raise/lower the default task, daily, and monthly hard caps. */
export async function updateCaps(formData: FormData): Promise<void> {
  await requireOwner();
  const values = {
    task_default: String(formData.get('task_default') ?? ''),
    daily: String(formData.get('daily') ?? ''),
    monthly: String(formData.get('monthly') ?? ''),
  };
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    });
    try {
      const wakes = await updateBudgetCapsWithRepository(
        new FirestoreBudgetCapsRepository(store),
        config.FIRESTORE_AGENT_ID,
        values,
      );
      await dispatchBudgetWakes(config.QUEUE_DRIVER, wakes, store);
    } finally {
      await store.db.terminate();
    }
  } else {
    const wakes = await updateBudgetCaps(getDb(), values);
    await dispatchBudgetWakes(config.QUEUE_DRIVER, wakes);
  }
  revalidatePath('/costs');
}
