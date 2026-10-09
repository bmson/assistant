import {
  GRAPH_EXTRACTION_VERSION,
  getKnowledgeGraphOverview,
  mergeKnowledgeGraphEntities,
  presentKnowledgeGraphRelation,
  renameKnowledgeGraphEntity,
  retypeKnowledgeGraphEntity,
} from '@assistant/application';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import { getFirestoreKnowledgeGraphOverview } from '@assistant/firestore';
import { getFirestoreKnowledgeCuration } from '@/lib/firestore-knowledge';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid knowledge item id' }, { status: 400 });
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const graph = await getFirestoreKnowledgeGraphOverview(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
      GRAPH_EXTRACTION_VERSION,
      { entityId: id },
      undefined,
      config.GRAPH_SYNC_BATCH_LIMIT,
      parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
    );
    return graph.selected
      ? mobileJson({
          ...graph,
          relations: graph.relations.map((row) => ({
            ...row,
            presentation: presentKnowledgeGraphRelation({
              subjectLabel: row.subject.label,
              predicate: row.predicate,
              objectLabel: row.object.label,
            }),
          })),
        })
      : mobileJson({ error: 'knowledge item not found' }, { status: 404 });
  }
  // Keep the normal compact browse page alongside the selected detail: the
  // native guided editor needs real candidate items for its second endpoint.
  const graph = await getKnowledgeGraphOverview(getDb(), { entityId: id });
  return graph.selected
    ? mobileJson(graph)
    : mobileJson({ error: 'knowledge item not found' }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'action',
    'kind',
    'label',
    'targetId',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid knowledge item id' }, { status: 400 });
  const body = mutationBody.value as Record<string, unknown> | null;
  const action = body?.action;
  const curation =
    loadConfig().PERSISTENCE_DRIVER === 'firestore' ? getFirestoreKnowledgeCuration() : null;
  let result: { error?: string };
  if (action === 'rename') {
    const label = typeof body?.label === 'string' ? body.label : '';
    result = curation
      ? await curation.rename(id, label)
      : await renameKnowledgeGraphEntity(getDb(), id, label);
  } else if (action === 'retype') {
    const kind = typeof body?.kind === 'string' ? body.kind : '';
    result = curation
      ? await curation.retype(id, kind)
      : await retypeKnowledgeGraphEntity(getDb(), id, kind);
  } else if (action === 'merge') {
    const targetId = typeof body?.targetId === 'string' ? body.targetId : '';
    result = curation
      ? await curation.merge(id, targetId)
      : await mergeKnowledgeGraphEntities(getDb(), id, targetId);
  } else {
    return mobileJson({ error: 'action must be rename, retype, or merge' }, { status: 400 });
  }
  return result.error ? mobileJson(result, { status: 409 }) : mobileJson({ ok: true });
}
