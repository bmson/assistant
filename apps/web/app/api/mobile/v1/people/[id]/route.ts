import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import {
  getPersonDossier,
  nextOccasionWithinLead,
  personSummaryFromStoredRow,
} from '@assistant/application/people';
import { projectPersonGraph } from '@assistant/application/people-graph-projection';
import { toPersonCardView, toPersonCardViewFromParts } from '@assistant/application/people-view';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  getFirestoreMobilePeopleDirectory,
  getFirestorePersonDetail,
  getFirestorePersonGraph,
  getFirestorePersonTemporalDetails,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

// Mirrors the validation the other mobile person routes use, so a malformed id
// is a 400 rather than a 500 from the query layer.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * One person's card. Editing still goes through `memory/people/<id>` — this is
 * the read the card renders from, and it is deliberately separate so the
 * existing PATCH/DELETE/merge contract keeps its shape.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const now = new Date();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = getFirestoreInstallationStore();
    const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
    const contact = await getFirestorePersonDetail(store, config.FIRESTORE_AGENT_ID, id);
    if (!contact) return mobileJson({ error: 'person not found' }, { status: 404 });
    const rows = await getFirestoreMobilePeopleDirectory(
      store,
      config.FIRESTORE_AGENT_ID,
      now,
      GRAPH_EXTRACTION_VERSION,
    );
    const row = rows.find((candidate) => candidate.contact.id === id);
    if (!row) throw new Error('Person detail exceeds the directory projection bound');
    const [temporal, graph] = await Promise.all([
      getFirestorePersonTemporalDetails(store, config.FIRESTORE_AGENT_ID, id, now),
      getFirestorePersonGraph(
        store,
        config.FIRESTORE_AGENT_ID,
        id,
        GRAPH_EXTRACTION_VERSION,
        now,
        parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
      ),
    ]);
    if (!temporal || !graph) throw new Error('Person detail changed during read');
    const current = await getFirestorePersonDetail(store, config.FIRESTORE_AGENT_ID, id);
    if (
      !current ||
      current.name !== row.contact.name ||
      current.relationship !== row.contact.relationship ||
      current.trust !== row.contact.trust
    )
      throw new Error('Person detail contact changed during read');
    await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
    const projected = projectPersonGraph(contact.name, graph.edges);
    const summary = personSummaryFromStoredRow(row, now);
    summary.location = projected.location;
    summary.lastContactAt = temporal.lastContactAt;
    return mobileJson(
      toPersonCardViewFromParts(
        {
          summary,
          origins: projected.origins,
          relations: projected.relations,
          connections: projected.connections,
          events: temporal.events,
          upcomingOccasion: nextOccasionWithinLead(temporal.occasions, now),
        },
        now,
      ),
    );
  }
  const dossier = await getPersonDossier(getDb(), id, { now });
  if (!dossier) return mobileJson({ error: 'person not found' }, { status: 404 });
  return mobileJson(toPersonCardView(dossier, now));
}
