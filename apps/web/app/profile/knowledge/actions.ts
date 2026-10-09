'use server';

import {
  cleanKnowledgeProjectionOrphans,
  GRAPH_EXTRACTION_VERSION,
  getKnowledgeGraphNeighborhood,
  getKnowledgeGraphRelation,
  getKnowledgeSourceImpact,
  type KnowledgeGraphEntityView,
  type KnowledgeGraphNeighborEdge,
  mergeKnowledgeGraphEntities,
  presentKnowledgeGraphRelation,
  reextractRelativeDateSources,
  renameKnowledgeGraphEntity,
  retryQuarantinedKnowledgeGraphSources,
  retypeKnowledgeGraphEntity,
  reviewKnowledgeGraphRelation,
  searchKnowledgeGraphEntities,
} from '@assistant/application';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  FirestoreKnowledgeGraphRelationMutationRepository,
  getFirestoreKnowledgeGraphRelation,
} from '@assistant/firestore';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import {
  getFirestoreKnowledgeCuration,
  getFirestoreKnowledgeWorkspace,
} from '@/lib/firestore-knowledge';
import {
  addOwnerKnowledgeGraphFactForCurrentPersistence,
  correctOwnerKnowledgeGraphFactForCurrentPersistence,
  getDb,
  getFirestoreInstallationStore,
  getOwnerMemoryCommands,
} from '@/lib/server';

/**
 * Saving a connection has to embed its source note first, so an unreachable
 * embedding provider throws out of the action. useActionState has no state to
 * show for a thrown action, so the owner used to get a dead Save button and no
 * message at all. Turn it into the error the form already knows how to render,
 * and keep the real cause in the server log.
 */
async function reportable<T extends { error?: string | null }>(
  work: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (cause) {
    console.error('[knowledge] owner relation write failed', cause);
    return { error: 'That could not be saved right now. Check the connection and try again.' };
  }
}

/** Firestore curation commands, or null when PostgreSQL serves the workspace. */
function firestoreCuration() {
  return loadConfig().PERSISTENCE_DRIVER === 'firestore' ? getFirestoreKnowledgeCuration() : null;
}

function revalidateKnowledgeGraph(): void {
  revalidatePath('/profile');
  revalidatePath('/profile/knowledge');
  revalidatePath('/people', 'layout');
}

async function reviewRelation(relationId: string, status: 'confirmed' | 'rejected') {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    return new FirestoreKnowledgeGraphRelationMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).review(relationId, status);
  }
  return reviewKnowledgeGraphRelation(getDb(), relationId, status);
}

/**
 * Shared shape for the curation forms, so each can report what happened. A
 * 'use server' module may only export async functions, so the initial value
 * lives with the components that seed useActionState.
 */
export interface KnowledgeActionState {
  error: string | null;
  success: string | null;
}

export async function confirmKnowledgeRelation(relationId: string): Promise<void> {
  await requireOwner();
  await reviewRelation(relationId, 'confirmed');
  revalidateKnowledgeGraph();
}

export async function rejectKnowledgeRelation(relationId: string): Promise<void> {
  await requireOwner();
  await reviewRelation(relationId, 'rejected');
  revalidateKnowledgeGraph();
}

export async function retryQuarantinedKnowledgeSources(): Promise<void> {
  await requireOwner();
  const curation = firestoreCuration();
  await (curation
    ? curation.retryBlockedSources()
    : retryQuarantinedKnowledgeGraphSources(getDb()));
  revalidateKnowledgeGraph();
}

/**
 * Rename and merge both return a reason when they decline. Those used to be
 * dropped on the floor, so a rejected merge was indistinguishable from a
 * successful one — the page simply re-rendered unchanged.
 */
/**
 * Costs one model call per source, so it is a button rather than a schedule.
 * The nightly backfill has already taken the free share of this work.
 */
export async function reextractDatedSources(): Promise<void> {
  await requireOwner();
  const curation = firestoreCuration();
  await (curation ? curation.requeueRelativeDateSources() : reextractRelativeDateSources(getDb()));
  revalidateKnowledgeGraph();
}

export async function renameKnowledgeEntity(
  entityId: string,
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  await requireOwner();
  const label = String(formData.get('label') ?? '');
  const curation = firestoreCuration();
  const result = curation
    ? await curation.rename(entityId, label)
    : await renameKnowledgeGraphEntity(getDb(), entityId, label);
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Display name updated.' };
}

export async function mergeKnowledgeEntity(
  sourceId: string,
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  await requireOwner();
  const targetId = String(formData.get('targetId') ?? '');
  if (!targetId) return { error: 'Choose an item to merge into.', success: null };
  const curation = firestoreCuration();
  const result = curation
    ? await curation.merge(sourceId, targetId)
    : await mergeKnowledgeGraphEntities(getDb(), sourceId, targetId);
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Items merged. Future extractions will use the one you kept.' };
}

export async function retypeKnowledgeEntity(
  entityId: string,
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  await requireOwner();
  const kind = String(formData.get('kind') ?? '');
  const curation = firestoreCuration();
  const result = curation
    ? await curation.retype(entityId, kind)
    : await retypeKnowledgeGraphEntity(getDb(), entityId, kind);
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Type updated. Existing connections are unchanged.' };
}

/** Type-ahead for the merge picker; reaches any entity, not a fixed prefix. */
export async function searchKnowledgeEntities(
  query: string,
  excludeId: string,
  kind: string,
): Promise<KnowledgeGraphEntityView[]> {
  await requireOwner();
  const input = { query, excludeId, kind: kind || undefined };
  const curation = firestoreCuration();
  return curation ? curation.searchEntities(input) : searchKnowledgeGraphEntities(getDb(), input);
}

/**
 * The interactive map's expansion fetch. The application layer clamps the
 * limit, so a client-supplied value can never widen it past the shared cap.
 */
export async function loadKnowledgeNeighborhood(
  entityId: string,
  limit?: number,
): Promise<{ edges: KnowledgeGraphNeighborEdge[]; total: number }> {
  await requireOwner();
  const neighborhood =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await getFirestoreKnowledgeWorkspace().neighborhood({ entityId, limit })
      : await getKnowledgeGraphNeighborhood(getDb(), { entityId, limit });
  return { edges: neighborhood.edges, total: neighborhood.total };
}

export type AddKnowledgeRelationState = KnowledgeActionState;

export async function addKnowledgeRelation(
  _previous: AddKnowledgeRelationState,
  formData: FormData,
): Promise<AddKnowledgeRelationState> {
  await requireOwner();
  const subjectId = String(formData.get('subjectId') ?? '');
  const objectId = String(formData.get('objectId') ?? '');
  const result = await reportable(() =>
    addOwnerKnowledgeGraphFactForCurrentPersistence({
      subjectLabel: String(formData.get('subjectLabel') ?? ''),
      subjectKind: String(formData.get('subjectKind') ?? ''),
      subjectId: subjectId || undefined,
      subjectContactId: String(formData.get('subjectContactId') ?? '') || undefined,
      predicate: String(formData.get('predicate') ?? ''),
      objectLabel: String(formData.get('objectLabel') ?? ''),
      objectKind: String(formData.get('objectKind') ?? ''),
      objectId: objectId || undefined,
      note: String(formData.get('note') ?? ''),
    }),
  );
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Relationship saved with your note as its source.' };
}

export async function correctKnowledgeRelation(
  relationId: string,
  _previous: AddKnowledgeRelationState,
  formData: FormData,
): Promise<AddKnowledgeRelationState> {
  await requireOwner();
  const disposition = formData.get('sourceDisposition') ?? 'graph_only';
  if (disposition !== 'graph_only' && disposition !== 'whole_fact')
    return { error: 'Choose how to correct the earlier source.', success: null };
  const input = {
    sourceDisposition: disposition as 'graph_only' | 'whole_fact',
    subjectLabel: String(formData.get('subjectLabel') ?? ''),
    subjectKind: String(formData.get('subjectKind') ?? ''),
    subjectId: String(formData.get('subjectId') ?? '') || undefined,
    predicate: String(formData.get('predicate') ?? ''),
    objectLabel: String(formData.get('objectLabel') ?? ''),
    objectKind: String(formData.get('objectKind') ?? ''),
    objectId: String(formData.get('objectId') ?? '') || undefined,
    note: String(formData.get('note') ?? ''),
  };
  const result = await reportable(() =>
    correctOwnerKnowledgeGraphFactForCurrentPersistence(relationId, input),
  );
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return {
    error: null,
    success:
      'sourceDisposition' in result && result.sourceDisposition === 'whole_fact'
        ? 'Corrected connection saved; the earlier standalone fact has left recall.'
        : 'Corrected connection saved; the earlier connection is marked inaccurate. Its original source text remains available to memory recall.',
  };
}

export async function loadKnowledgeSourceImpact(memoryId: string) {
  await requireOwner();
  return loadConfig().PERSISTENCE_DRIVER === 'firestore'
    ? getFirestoreKnowledgeWorkspace().sourceImpact(memoryId)
    : getKnowledgeSourceImpact(getDb(), memoryId);
}

export async function correctKnowledgeMemory(
  memoryId: string,
  content: string,
): Promise<{ error?: string }> {
  await requireOwner();
  const result = await getOwnerMemoryCommands().correctMemory(memoryId, content);
  revalidateKnowledgeGraph();
  return result;
}

export async function forgetKnowledgeMemory(memoryId: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().forgetMemory(memoryId);
  revalidateKnowledgeGraph();
}

export async function keepKnowledgeMemory(memoryId: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().restoreMemory(memoryId);
  revalidateKnowledgeGraph();
}

export async function approveKnowledgeMemory(memoryId: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().approveQuarantinedMemory(memoryId);
  revalidateKnowledgeGraph();
}

export async function removeDisconnectedKnowledgeItems(): Promise<void> {
  await requireOwner();
  const curation = firestoreCuration();
  await (curation ? curation.removeOrphanedEntities() : cleanKnowledgeProjectionOrphans(getDb()));
  revalidateKnowledgeGraph();
}

export async function removeKnowledgeConnection(relationId: string): Promise<{ error?: string }> {
  await requireOwner();
  const removed = await reviewRelation(relationId, 'rejected');
  if (!removed) return { error: 'That connection no longer exists. Refresh and try again.' };
  revalidateKnowledgeGraph();
  return {};
}

export async function loadConnectionSource(
  relationId: string,
): Promise<{ content: string; sentence: string } | null> {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const relation = await getFirestoreKnowledgeGraphRelation(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
      GRAPH_EXTRACTION_VERSION,
      relationId,
      undefined,
      parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
    );
    return relation
      ? {
          content: relation.source.content,
          sentence: presentKnowledgeGraphRelation({
            subjectLabel: relation.subject.label,
            predicate: relation.predicate,
            objectLabel: relation.object.label,
          }).sentence,
        }
      : null;
  }
  const relation = await getKnowledgeGraphRelation(getDb(), relationId);
  return relation
    ? { content: relation.source.content, sentence: relation.presentation.sentence }
    : null;
}
