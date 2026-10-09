import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreWorkspaceAnomalyRepository,
  FirestoreWorkspaceImprovementRepository,
} from '@assistant/firestore';
import type { ImprovementActionResult } from '@assistant/persistence';
import { getApplication, getFirestoreInstallationStore } from './server';

/**
 * Anomaly and improvement review for the configured persistence driver. The
 * web pages, their Server Actions, and the mobile routes share these so the
 * two clients agree on which rows are open and what a decision changes.
 */
function firestoreReviews() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return null;
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = getFirestoreInstallationStore();
  return {
    agentId: config.FIRESTORE_AGENT_ID,
    anomalies: new FirestoreWorkspaceAnomalyRepository(store),
    improvements: new FirestoreWorkspaceImprovementRepository(store),
  };
}

/** The newest open anomalies for the owner. */
export function listOpenAnomalies() {
  const firestore = firestoreReviews();
  return firestore
    ? firestore.anomalies.listOpen(firestore.agentId)
    : getApplication().listAnomalies();
}

/** Dismiss a false positive. False when no owned anomaly matched (Firestore only). */
export async function dismissOwnerAnomaly(anomalyId: string): Promise<boolean> {
  const firestore = firestoreReviews();
  if (firestore) return firestore.anomalies.dismiss(firestore.agentId, anomalyId);
  return getApplication().dismissAnomaly(anomalyId);
}

/** Disable the policy behind an anomaly and mark the anomaly acted on. */
export async function suspendOwnerAnomalyPolicy(anomalyId: string): Promise<boolean> {
  const firestore = firestoreReviews();
  if (firestore) return firestore.anomalies.suspendPolicy(firestore.agentId, anomalyId);
  return getApplication().suspendAnomaly(anomalyId);
}

/** The newest open improvement proposals for the owner. */
export function listOpenImprovements() {
  const firestore = firestoreReviews();
  return firestore
    ? firestore.improvements.listOpen(firestore.agentId)
    : getApplication().listImprovementProposals();
}

/** Apply or dismiss one owner proposal; repeated decisions are no-ops. */
export function decideOwnerImprovement(
  id: string,
  action: 'apply' | 'dismiss',
): Promise<ImprovementActionResult> {
  const firestore = firestoreReviews();
  if (firestore) return firestore.improvements.applyAction(firestore.agentId, id, action);
  return action === 'apply'
    ? getApplication().applyImprovementProposal(id)
    : getApplication().dismissImprovementProposal(id);
}
