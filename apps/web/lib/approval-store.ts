import type { ApprovalRememberStore } from '@assistant/application/approvals';
import { loadConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';

type ApprovalStore = ReturnType<typeof getDb> | ApprovalRememberStore;

export function getApprovalStore(): ApprovalStore {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return getDb();
  return {
    agentId: config.FIRESTORE_AGENT_ID,
    approvals: new FirestoreApprovalRepository(getFirestoreInstallationStore()),
  };
}

/** Owner decisions are also fenced against concurrent privacy erasure. */
export async function withApprovalDecisionStore<T>(
  run: (store: ApprovalStore) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return run(getDb());
  const installationStore = getFirestoreInstallationStore();
  const fence = await readPrivacyErasureFence(installationStore, config.FIRESTORE_AGENT_ID);
  const result = await run({
    agentId: config.FIRESTORE_AGENT_ID,
    approvals: new FirestoreApprovalRepository(installationStore),
  });
  await assertPrivacyErasureFenceUnchanged(installationStore, config.FIRESTORE_AGENT_ID, fence);
  return result;
}

/** Read policies through the same authenticated installation composition. */
export function getApprovalPolicyStore() {
  const config = loadConfig();
  return config.PERSISTENCE_DRIVER === 'firestore'
    ? {
        agentId: config.FIRESTORE_AGENT_ID,
        policies: new FirestoreApprovalPolicyRepository(getFirestoreInstallationStore()),
      }
    : getDb();
}
