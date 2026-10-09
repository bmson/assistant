import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import {
  type PersonDossier,
  type PersonSummary,
  personDossierFromStoredParts,
  personSummaryFromStoredRow,
} from '@assistant/application/people';
import { getPersonProfile } from '@assistant/application/profile';
import { loadConfig, parseFirestoreEmbeddingSpace } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  FirestoreKnowledgeWorkspaceReadRepository,
  FirestoreProfilePeopleReadRepository,
  getFirestoreMobilePeopleDirectory,
  getFirestorePersonDetail,
  getFirestorePersonGraph,
  getFirestorePersonTemporalDetails,
  type InstallationStore,
  readPrivacyErasureFence,
} from '@assistant/firestore';

/** The People directory from the configured owner's Firestore records. */
export async function listFirestorePeopleDirectory(
  store: InstallationStore,
  agentId: string,
  now: Date,
): Promise<PersonSummary[]> {
  const rows = await getFirestoreMobilePeopleDirectory(
    store,
    agentId,
    now,
    GRAPH_EXTRACTION_VERSION,
  );
  return rows.map((row) => personSummaryFromStoredRow(row, now));
}

/**
 * The whole person page from Firestore, in the SQL dossier's shape so both
 * drivers render the same page. Null for an unknown id and for the owner.
 */
export async function getFirestorePersonDossier(
  store: InstallationStore,
  agentId: string,
  contactId: string,
  opts: { factLimit: number; now: Date },
): Promise<PersonDossier | null> {
  const fence = await readPrivacyErasureFence(store, agentId);
  if (!(await getFirestorePersonDetail(store, agentId, contactId))) return null;
  const [profile, temporal, graph] = await Promise.all([
    getPersonProfile(
      new FirestoreProfilePeopleReadRepository(store, agentId),
      contactId,
      opts.factLimit,
    ),
    getFirestorePersonTemporalDetails(store, agentId, contactId, opts.now),
    getFirestorePersonGraph(
      store,
      agentId,
      contactId,
      GRAPH_EXTRACTION_VERSION,
      opts.now,
      parseFirestoreEmbeddingSpace(loadConfig().FIRESTORE_EMBEDDING_SPACE),
    ),
  ]);
  if (!profile || !temporal || !graph) throw new Error('Person detail changed during read');
  const entity = graph.entityId
    ? await new FirestoreKnowledgeWorkspaceReadRepository(store, agentId).entity(graph.entityId)
    : null;
  if (graph.entityId && !entity) throw new Error('Person detail changed during read');
  const current = await getFirestorePersonDetail(store, agentId, contactId);
  if (
    !current ||
    current.name !== profile.contact.name ||
    current.relationship !== profile.contact.relationship ||
    current.trust !== profile.contact.trust
  )
    throw new Error('Person detail contact changed during read');
  await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
  return personDossierFromStoredParts(
    { profile, entity, edges: graph.edges, events: temporal.events, occasions: temporal.occasions },
    opts.now,
  );
}
