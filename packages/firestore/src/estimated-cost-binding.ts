import { createHash } from 'node:crypto';
import {
  canonicalEstimatedCostJson,
  type EstimatedCostActor,
  type EstimatedCostSourceBinding,
  estimatedCostConnectionId,
} from '@assistant/persistence';
import { type DocumentSnapshot, Timestamp, type Transaction } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import type { InstallationStore } from './store.js';

/** Convert Firestore native timestamps losslessly before canonical hashing. */
function sourceValue(value: unknown): unknown {
  if (value instanceof Timestamp) return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof Date) return { date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(sourceValue);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error('Unsupported source value');
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sourceValue(item),
      ]),
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  throw new Error('Unsupported source value');
}

function digest(snapshot: DocumentSnapshot): string {
  if (!snapshot.exists || !snapshot.updateTime) throw new Error('Missing binding source');
  return createHash('sha256')
    .update(
      canonicalEstimatedCostJson({
        data: sourceValue(snapshot.data()),
        updateTime: {
          seconds: snapshot.updateTime.seconds,
          nanoseconds: snapshot.updateTime.nanoseconds,
        },
      }),
    )
    .digest('hex');
}

function configuredConnection(snapshot: DocumentSnapshot, id: string): boolean {
  if (!snapshot.exists || snapshot.get('id') !== id || snapshot.get('enabled') !== true)
    return false;
  const kind =
    id === 'vertex'
      ? 'vertex'
      : id === 'openai'
        ? 'openai'
        : id === 'openrouter'
          ? 'openrouter'
          : 'openai_compatible';
  if (snapshot.get('kind') !== kind) return false;
  if (id === 'vertex')
    return (
      typeof snapshot.get('vertexProject') === 'string' &&
      Boolean(snapshot.get('vertexProject')) &&
      typeof snapshot.get('vertexLocation') === 'string' &&
      Boolean(snapshot.get('vertexLocation'))
    );
  return (
    typeof snapshot.get('apiKeyEncrypted') === 'string' && Boolean(snapshot.get('apiKeyEncrypted'))
  );
}

export interface FirestoreEstimatedCostBindingInput {
  actor: EstimatedCostActor;
  taskId: string;
  role: string;
  selectedModelId: string;
  routingDigest: string;
  critical: boolean;
  additionalRoles?: string[];
}

/** Called within the same transaction that stores or approves a quote. */
export async function firestoreEstimatedCostSourceBinding(
  tx: Transaction,
  store: InstallationStore,
  input: FirestoreEstimatedCostBindingInput,
): Promise<EstimatedCostSourceBinding> {
  if (input.actor.installationId !== store.installationId)
    throw new Error('Installation scope changed');
  if (!/^[a-f0-9]{64}$/.test(input.routingDigest) || !input.role || !input.selectedModelId)
    throw new Error('Invalid routing binding');
  const [task, role, policy, privacy] = await tx.getAll(
    store.doc('tasks', input.taskId),
    store.doc('modelRoles', input.role),
    store.doc('coordination', 'budget-policy'),
    store.doc('privacyErasureJobs', input.actor.ownerId),
  );
  if (
    !task?.exists ||
    task.get('agentId') !== input.actor.ownerId ||
    !role?.exists ||
    !policy?.exists
  )
    throw new Error('Missing binding scope');
  if (
    privacy?.exists &&
    (privacy.get('agentId') !== input.actor.ownerId ||
      privacyErasureIsActive(privacy.get('status')) ||
      !privacy.updateTime)
  )
    throw new Error('Privacy observation unavailable');
  const privacyGeneration =
    privacy?.exists && privacy.updateTime
      ? `${privacy.updateTime.seconds}:${privacy.updateTime.nanoseconds}`
      : null;
  const primary: unknown = role.get('primaryModel');
  const fallback: unknown = role.get('fallbackModel');
  const conversationId: unknown = task.get('conversationId');
  if (
    typeof primary !== 'string' ||
    !primary ||
    typeof fallback !== 'string' ||
    !fallback ||
    typeof conversationId !== 'string' ||
    !conversationId
  )
    throw new Error('Invalid routing scope');
  const conversation = await tx.get(store.doc('conversations', conversationId));
  if (!conversation.exists || conversation.get('agentId') !== input.actor.ownerId)
    throw new Error('Missing owner conversation');
  const override: unknown = conversation.get('modelOverride');
  if (override !== undefined && override !== null && (typeof override !== 'string' || !override))
    throw new Error('Invalid model override');
  const modelIds = [
    ...new Set([
      primary,
      fallback,
      ...(typeof override === 'string' && ['reason', 'draft'].includes(input.role)
        ? [override]
        : []),
    ]),
  ].sort();
  if (!modelIds.includes(input.selectedModelId))
    throw new Error('Selected model outside routing scope');
  const connectionIds = [...new Set(modelIds.map(estimatedCostConnectionId))].sort();
  const [modelDocs, connectionDocs] = await Promise.all([
    tx.getAll(...modelIds.map((id) => store.doc('models', id))),
    tx.getAll(...connectionIds.map((id) => store.doc('modelConnections', id))),
  ]);
  if (
    modelDocs.some((doc) => !doc.exists) ||
    connectionDocs.some((doc, index) => !configuredConnection(doc, connectionIds[index] ?? ''))
  )
    throw new Error('Unproven model connection');
  const selected = modelDocs[modelIds.indexOf(input.selectedModelId)];
  if (!selected?.exists || selected.get('enabled') !== true)
    throw new Error('Selected model unavailable');
  const policyDigest = digest(policy);
  const extraRoles = [...new Set(input.additionalRoles ?? [])].sort();
  if (extraRoles.length > 8 || extraRoles.some((name) => !name || name === input.role))
    throw new Error('Invalid additional routing scope');
  const additionalRoutes: EstimatedCostSourceBinding['additionalRoutes'] = [];
  for (const name of extraRoles) {
    const extraRole = await tx.get(store.doc('modelRoles', name));
    const extraPrimary: unknown = extraRole.get('primaryModel');
    const extraFallback: unknown = extraRole.get('fallbackModel');
    if (
      !extraRole.exists ||
      typeof extraPrimary !== 'string' ||
      !extraPrimary ||
      typeof extraFallback !== 'string' ||
      !extraFallback
    )
      throw new Error('Missing additional routing scope');
    const ids = [
      ...new Set([
        extraPrimary,
        extraFallback,
        ...(typeof override === 'string' && ['reason', 'draft'].includes(name) ? [override] : []),
      ]),
    ].sort();
    const connections = [...new Set(ids.map(estimatedCostConnectionId))].sort();
    const extraModels = await tx.getAll(...ids.map((id) => store.doc('models', id)));
    const extraConnections = await tx.getAll(
      ...connections.map((id) => store.doc('modelConnections', id)),
    );
    if (
      extraModels.some((doc) => !doc.exists) ||
      extraConnections.some((doc, index) => !configuredConnection(doc, connections[index] ?? ''))
    )
      throw new Error('Unproven additional model connection');
    additionalRoutes.push({
      role: name,
      roleRowDigest: digest(extraRole),
      modelRows: ids.map((id, index) => ({
        id,
        digest: digest(extraModels[index] as DocumentSnapshot),
      })),
      connectionRows: connections.map((id, index) => ({
        id,
        digest: digest(extraConnections[index] as DocumentSnapshot),
      })),
    });
  }
  return {
    role: input.role,
    critical: input.critical,
    selectedModelId: input.selectedModelId,
    routingDigest: input.routingDigest,
    roleRowDigest: digest(role),
    modelRows: modelIds.map((id, index) => ({
      id,
      digest: digest(modelDocs[index] as DocumentSnapshot),
    })),
    connectionRows: connectionIds.map((id, index) => ({
      id,
      digest: digest(connectionDocs[index] as DocumentSnapshot),
    })),
    additionalRoutes,
    budgetRows: [
      { scope: 'daily', digest: policyDigest },
      { scope: 'monthly', digest: policyDigest },
    ],
    privacyGeneration,
  };
}
