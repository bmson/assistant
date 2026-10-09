import {
  asGraphEntityKind,
  GRAPH_EXTRACTION_VERSION,
  getKnowledgeGraphOverview,
  getKnowledgeGraphReviewQueue,
  presentKnowledgeGraphRelation,
  searchKnowledgeGraphEntities,
} from '@assistant/application';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  getFirestoreKnowledgeGraphOverview,
  getFirestoreKnowledgeGraphReviewQueue,
} from '@assistant/firestore';
import { getFirestoreKnowledgeCuration } from '@/lib/firestore-knowledge';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import {
  addOwnerKnowledgeGraphFactForCurrentPersistence,
  getDb,
  getFirestoreInstallationStore,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

function withPresentation<
  T extends { subject: { label: string }; predicate: string; object: { label: string } },
>(row: T) {
  return {
    ...row,
    presentation: presentKnowledgeGraphRelation({
      subjectLabel: row.subject.label,
      predicate: row.predicate,
      objectLabel: row.object.label,
    }),
  };
}

/**
 * Find-as-you-type over graph items. Reads names and kinds only: the browse
 * overview below loads every entity, relation and memory to answer one page,
 * and a burst of keystrokes against it ran the server out of memory.
 */
async function searchEntities(raw: string) {
  const query = raw.trim().slice(0, 120);
  if (!query) return [];
  const input = { query, limit: 50 };
  const rows =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await getFirestoreKnowledgeCuration().searchEntities(input)
      : await searchKnowledgeGraphEntities(getDb(), input);
  // Names that start with what was typed come first, then names with a word
  // that does — "Bal" should find Baldvin before Annabel.
  const needle = query.toLocaleLowerCase();
  const rank = (label: string) => {
    const name = label.toLocaleLowerCase();
    if (name.startsWith(needle)) return 0;
    return name.split(/\s+/).some((word) => word.startsWith(needle)) ? 1 : 2;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.label) - rank(b.row.label) || a.index - b.index)
    .slice(0, 30)
    .map(({ row }) => row);
}

/** Compact graph browsing plus the owner-backed connection creator for iPhone. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const url = new URL(request.url);
  const config = loadConfig();
  if (url.searchParams.get('mode') === 'search') {
    return mobileJson({ entities: await searchEntities(url.searchParams.get('q') ?? '') });
  }
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = getFirestoreInstallationStore();
    if (url.searchParams.get('mode') === 'review') {
      const rows = await getFirestoreKnowledgeGraphReviewQueue(
        store,
        config.FIRESTORE_AGENT_ID,
        GRAPH_EXTRACTION_VERSION,
        undefined,
        parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
      );
      return mobileJson({ relations: rows.map(withPresentation) });
    }
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const graph = await getFirestoreKnowledgeGraphOverview(
      store,
      config.FIRESTORE_AGENT_ID,
      GRAPH_EXTRACTION_VERSION,
      {
        query: url.searchParams.get('q') ?? '',
        kind: asGraphEntityKind(url.searchParams.get('kind') ?? undefined),
        page: Number.isFinite(page) && page > 0 ? page : 1,
      },
      undefined,
      config.GRAPH_SYNC_BATCH_LIMIT,
      parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
    );
    return mobileJson({ ...graph, relations: graph.relations.map(withPresentation) });
  }
  if (url.searchParams.get('mode') === 'review') {
    return mobileJson({ relations: await getKnowledgeGraphReviewQueue(getDb()) });
  }
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  return mobileJson(
    await getKnowledgeGraphOverview(getDb(), {
      query: url.searchParams.get('q') ?? '',
      kind: asGraphEntityKind(url.searchParams.get('kind') ?? undefined),
      page: Number.isFinite(page) && page > 0 ? page : 1,
    }),
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'note',
    'objectId',
    'objectKind',
    'objectLabel',
    'predicate',
    'subjectId',
    'subjectKind',
    'subjectLabel',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  if (!body) return mobileJson({ error: 'invalid connection body' }, { status: 400 });
  const result = await addOwnerKnowledgeGraphFactForCurrentPersistence({
    subjectLabel: typeof body.subjectLabel === 'string' ? body.subjectLabel : '',
    subjectKind: typeof body.subjectKind === 'string' ? body.subjectKind : '',
    subjectId: typeof body.subjectId === 'string' ? body.subjectId : undefined,
    predicate: typeof body.predicate === 'string' ? body.predicate : '',
    objectLabel: typeof body.objectLabel === 'string' ? body.objectLabel : '',
    objectKind: typeof body.objectKind === 'string' ? body.objectKind : '',
    objectId: typeof body.objectId === 'string' ? body.objectId : undefined,
    note: typeof body.note === 'string' ? body.note : '',
  });
  return result.error ? mobileJson(result, { status: 400 }) : mobileJson(result, { status: 201 });
}
