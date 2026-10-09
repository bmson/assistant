import {
  normalizeBudgetCaps,
  updateBudgetCaps,
  updateBudgetCapsWithRepository,
} from '@assistant/application/costs';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore, FirestoreBudgetCapsRepository } from '@assistant/firestore';
import { readBoundedJson } from '@/lib/bounded-json';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Update the same default-task, daily, and monthly hard caps as the web costs form. */
export async function PATCH(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return mobileJson({ error: parsed.error }, { status: parsed.status });
  const body = parsed.value as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return mobileJson({ error: 'invalid cost limits body' }, { status: 400 });
  }
  const unknownKeys = Object.keys(body).filter(
    (key) => !['taskDefault', 'daily', 'monthly'].includes(key),
  );
  if (unknownKeys.length)
    return mobileJson({ error: `Unknown cost limit field: ${unknownKeys[0]}.` }, { status: 400 });
  for (const key of ['taskDefault', 'daily', 'monthly']) {
    if (key in body && typeof body[key] !== 'string') {
      return mobileJson({ error: `${key} must be a USD amount string.` }, { status: 400 });
    }
  }
  const values = {
    ...(typeof body.taskDefault === 'string' ? { task_default: body.taskDefault } : {}),
    ...(typeof body.daily === 'string' ? { daily: body.daily } : {}),
    ...(typeof body.monthly === 'string' ? { monthly: body.monthly } : {}),
  };
  const normalized = normalizeBudgetCaps(values);
  if (normalized.error) return mobileJson({ error: normalized.error }, { status: 400 });
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
      await updateBudgetCapsWithRepository(
        new FirestoreBudgetCapsRepository(store),
        config.FIRESTORE_AGENT_ID,
        normalized.caps ?? {},
      );
    } finally {
      await store.db.terminate();
    }
  } else await updateBudgetCaps(getDb(), normalized.caps ?? {});
  return mobileJson({ ok: true, appliedCaps: normalized.caps });
}
