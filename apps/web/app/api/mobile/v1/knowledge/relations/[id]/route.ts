import {
  GRAPH_EXTRACTION_VERSION,
  getKnowledgeGraphRelation,
  presentKnowledgeGraphRelation,
  reviewKnowledgeGraphRelation,
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
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import {
  correctOwnerKnowledgeGraphFactForCurrentPersistence,
  getDb,
  getFirestoreInstallationStore,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function reviewRelation(id: string, status: 'confirmed' | 'rejected') {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    return new FirestoreKnowledgeGraphRelationMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).review(id, status);
  }
  return reviewKnowledgeGraphRelation(getDb(), id, status);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid relationship id' }, { status: 400 });
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const relation = await getFirestoreKnowledgeGraphRelation(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
      GRAPH_EXTRACTION_VERSION,
      id,
      undefined,
      parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
    );
    return relation
      ? mobileJson({
          ...relation,
          presentation: presentKnowledgeGraphRelation({
            subjectLabel: relation.subject.label,
            predicate: relation.predicate,
            objectLabel: relation.object.label,
          }),
        })
      : mobileJson({ error: 'relationship not found' }, { status: 404 });
  }
  const relation = await getKnowledgeGraphRelation(getDb(), id);
  return relation
    ? mobileJson(relation)
    : mobileJson({ error: 'relationship not found' }, { status: 404 });
}

/** Retain the rejected record so removing a claim does not erase its shared source. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid relationship id' }, { status: 400 });
  const removed = await reviewRelation(id, 'rejected');
  return removed
    ? mobileJson({ ok: true })
    : mobileJson({ error: 'relationship not found' }, { status: 404 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid relationship id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, [
    'action',
    'note',
    'objectId',
    'objectKind',
    'objectLabel',
    'predicate',
    'sourceDisposition',
    'subjectId',
    'subjectKind',
    'subjectLabel',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  if (body?.action === 'confirm' || body?.action === 'reject') {
    const reviewed = await reviewRelation(id, body.action === 'confirm' ? 'confirmed' : 'rejected');
    return reviewed
      ? mobileJson({ ok: true })
      : mobileJson({ error: 'relationship not found' }, { status: 404 });
  }
  if (body?.action === 'correct') {
    if (
      body.sourceDisposition !== undefined &&
      body.sourceDisposition !== 'graph_only' &&
      body.sourceDisposition !== 'whole_fact'
    )
      return mobileJson({ error: 'invalid source disposition' }, { status: 400 });
    const input = {
      sourceDisposition: (body.sourceDisposition ?? 'graph_only') as 'graph_only' | 'whole_fact',
      subjectLabel: typeof body.subjectLabel === 'string' ? body.subjectLabel : '',
      subjectKind: typeof body.subjectKind === 'string' ? body.subjectKind : '',
      subjectId: typeof body.subjectId === 'string' ? body.subjectId : undefined,
      predicate: typeof body.predicate === 'string' ? body.predicate : '',
      objectLabel: typeof body.objectLabel === 'string' ? body.objectLabel : '',
      objectKind: typeof body.objectKind === 'string' ? body.objectKind : '',
      objectId: typeof body.objectId === 'string' ? body.objectId : undefined,
      note: typeof body.note === 'string' ? body.note : '',
    };
    const result = await correctOwnerKnowledgeGraphFactForCurrentPersistence(id, input);
    return result.error ? mobileJson(result, { status: 400 }) : mobileJson(result, { status: 201 });
  }
  return mobileJson({ error: 'action must be confirm, reject, or correct' }, { status: 400 });
}
