import { getAgent } from '@assistant/core/chat';
import {
  CARD_AUTO_FACTS_PER_DOMAIN,
  CARD_AUTO_MIN_IMPORTANCE,
} from '@assistant/core/memory/consolidation';
import type { MemoryHealth } from '@assistant/core/memory/health';
import { detectOccasionInText } from '@assistant/core/memory/occasions';
import type { VoiceSampleStats } from '@assistant/core/memory/voice-ingest';
import {
  createPostgresProfileLibraryRepository,
  createPostgresProfileMemoryHubRepository,
  createPostgresProfileOverviewRepository,
  createPostgresProfilePeopleReadRepository,
  createPostgresProfileVoiceOverviewRepository,
  type Db,
  findDuplicateContactSuggestions,
} from '@assistant/db';
import {
  isProfileMemoryHubRepository,
  isProfileOverviewRepository,
  isProfilePeopleReadRepository,
  isProfileVoiceOverviewRepository,
  type ProfileMemoryHubOverview,
  type ProfileMemoryHubRepository,
  type ProfileOverviewRepository,
  type ProfilePeopleReadRepository,
  type ProfileVoiceOverview,
  type ProfileVoiceOverviewRepository,
} from '@assistant/persistence';
import {
  type MemoryLibraryFilters,
  type MemoryLibraryInput,
  type MemoryProjectionStatus,
  profileLibraryQueries,
} from './library-queries.js';

export type {
  MemoryFilter,
  MemoryLibraryFilters,
  MemoryProjectionStatus,
  MemoryState,
} from './library-queries.js';
export { profileLibraryQueries } from './library-queries.js';

export interface MemorySnapshot {
  id: string;
  content: string;
  kind: string;
  domain: string | null;
  confidence: string;
  importance: number;
  ownerConfirmed: boolean;
  pinned: boolean;
  lastConsolidatedAt: Date | null;
  originTrust: string;
  sourceTaskId: string | null;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
}

export interface ContactSnapshot {
  id: string;
  name: string;
  aliases: string[];
  relationship: string;
  trust: string;
  /** Exact native version of these displayed values; absent on older read adapters. */
  identityRevision?: string | null;
}

export interface ProfileOverview {
  owner?: ContactSnapshot;
  people: Array<{ contact: ContactSnapshot; factCount: number }>;
  ownerFacts: MemorySnapshot[];
  quarantined: MemorySnapshot[];
  card: { content: string; compiledAt: Date } | null;
  cardFactIds: string[];
  voiceStats: VoiceSampleStats;
  /** The distilled voice the rewriter imitates — owner-editable on Profile. */
  voiceProfile: { description: string; dos: string[]; donts: string[]; signature: string };
  voiceImports: Array<{
    source: string;
    status: string;
    itemsTotal: number | null;
    itemsProcessed: number;
    memoriesSaved: number;
    taskId: string | null;
    error: string | null;
  }>;
  memoryHealth: MemoryHealth;
  latestOrganizer: {
    id: string;
    status: string;
    progress: string;
    updatedAt: Date;
  } | null;
}

const PROFILE_FACT_LIMIT = 250;

const CARD_DOMAINS = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;

/**
 * Which owner facts the compiled card would pick: everything pinned, plus the
 * most important few per domain. Shared by the overview and the About page so
 * the "In profile" marker on a fact row means the same thing on both.
 */
function selectedCardFactIds(ownerFacts: MemorySnapshot[]): Set<string> {
  const ids = new Set<string>();
  for (const domain of CARD_DOMAINS) {
    const facts = ownerFacts.filter((memory) => (memory.domain ?? 'other') === domain);
    for (const memory of facts.filter((fact) => fact.pinned)) ids.add(memory.id);
    for (const memory of facts
      .filter((fact) => !fact.pinned && fact.importance >= CARD_AUTO_MIN_IMPORTANCE)
      .slice(0, CARD_AUTO_FACTS_PER_DOMAIN)) {
      ids.add(memory.id);
    }
  }
  return ids;
}

/** Load the complete memory overview without exposing persistence to Next.js. */
export async function getProfileOverview(
  source: Db | ProfileOverviewRepository,
): Promise<ProfileOverview> {
  const repository = isProfileOverviewRepository(source)
    ? source
    : createPostgresProfileOverviewRepository(source);
  const overview = await repository.load();
  return { ...overview, cardFactIds: [...selectedCardFactIds(overview.ownerFacts)] };
}

/**
 * The Memory hub's own read.
 *
 * `getProfileOverview` returns everything the old single-page Memory screen
 * needed — owner facts, the voice corpus, the people list — and is still the
 * shape the mobile workspace endpoint serves, so it stays as it is. The hub
 * only shows health, the review inbox, and counts to route by, and loading six
 * unused result sets to render four numbers is a cost paid on every visit.
 */
export type MemoryHubOverview = ProfileMemoryHubOverview;

export async function getMemoryHubOverview(
  source: Db | ProfileMemoryHubRepository,
): Promise<MemoryHubOverview> {
  const repository = isProfileMemoryHubRepository(source)
    ? source
    : createPostgresProfileMemoryHubRepository(source);
  return repository.load();
}

/** Everything `/profile/about` renders: the owner's facts and the compiled card. */
export interface OwnerFactsView {
  owner?: ContactSnapshot;
  ownerFacts: MemorySnapshot[];
  card: { content: string; compiledAt: Date } | null;
  cardFactIds: string[];
}

async function profilePeopleReads(
  store: Db | ProfilePeopleReadRepository,
  opts: { includeEditingSuggestions?: boolean } = {},
): Promise<ProfilePeopleReadRepository> {
  if (isProfilePeopleReadRepository(store)) return store;
  const agent = await getAgent(store);
  return createPostgresProfilePeopleReadRepository(store, agent.id, undefined, {
    browseOnly: opts.includeEditingSuggestions === false,
  });
}

export async function getOwnerFactsView(
  store: Db | ProfilePeopleReadRepository,
): Promise<OwnerFactsView> {
  const reads = await profilePeopleReads(store);
  const [owner, card] = await Promise.all([reads.getOwnerContact(), reads.getOwnerCard()]);
  const ownerFacts = owner ? (await reads.getFacts(owner.id, PROFILE_FACT_LIMIT)).rows : [];

  return {
    ...(owner ? { owner } : {}),
    ownerFacts,
    card: card ? { content: card.content, compiledAt: card.compiledAt } : null,
    cardFactIds: [...selectedCardFactIds(ownerFacts)],
  };
}

/** Everything `/profile/voice` renders. */
export type VoiceOverview = ProfileVoiceOverview;

export async function getVoiceOverview(
  source: Db | ProfileVoiceOverviewRepository,
): Promise<VoiceOverview> {
  const repository = isProfileVoiceOverviewRepository(source)
    ? source
    : createPostgresProfileVoiceOverviewRepository(source);
  return repository.load();
}

export interface MemoryLibrary {
  rows: Array<{
    memory: MemorySnapshot;
    subjectId: string | null;
    subjectLabel: string | null;
    subjectTrust: string | null;
    /** Direct recall-eligible graph edges supported by this exact memory. */
    connectionCount: number;
    /** Explains why a source has no active graph edge without surfacing stale projections. */
    projectionStatus: MemoryProjectionStatus;
  }>;
  total: number;
  page: number;
  totalPages: number;
}

export async function listMemoryLibraryFilters(db: Db): Promise<MemoryLibraryFilters> {
  const agent = await getAgent(db);
  return profileLibraryQueries(createPostgresProfileLibraryRepository(db), agent.id).listFilters();
}

export async function listMemoryLibrary(db: Db, input: MemoryLibraryInput): Promise<MemoryLibrary> {
  const agent = await getAgent(db);
  return profileLibraryQueries(createPostgresProfileLibraryRepository(db), agent.id).list(input);
}

export interface PersonProfile {
  contact: ContactSnapshot;
  facts: MemorySnapshot[];
  totalFacts: number;
  occasions: Array<{
    id: string;
    kind: string;
    label: string;
    month: number;
    day: number;
    year: number | null;
    leadDays?: number;
    notes: string;
    quarantined: boolean;
  }>;
  occasionSuggestions: Array<{ kind: 'birthday' | 'anniversary'; month: number; day: number }>;
  mergeOptions: Array<{ id: string; label: string }>;
  duplicate?: { targetId: string; reason: string };
}

export async function getPersonProfile(
  store: Db | ProfilePeopleReadRepository,
  contactId: string,
  factLimit = 250,
  opts: { includeEditingSuggestions?: boolean } = {},
): Promise<PersonProfile | null> {
  const reads = await profilePeopleReads(store, opts);
  const contact = await reads.getContact(contactId);
  if (!contact || contact.trust === 'owner') return null;
  const [{ rows: facts, total }, allContacts, occasionRows] = await Promise.all([
    reads.getFacts(contact.id, factLimit),
    opts.includeEditingSuggestions === false ? Promise.resolve([]) : reads.listContacts(),
    reads.listOccasions(contact.id),
  ]);
  const existingDates = new Set(
    occasionRows.map((occasion) => `${occasion.month}-${occasion.day}`),
  );
  const suggestionSeen = new Set<string>();
  const occasionSuggestions: PersonProfile['occasionSuggestions'] = [];
  for (const fact of facts) {
    const detected = detectOccasionInText(fact.content);
    if (!detected) continue;
    const key = `${detected.month}-${detected.day}`;
    if (existingDates.has(key) || suggestionSeen.has(key)) continue;
    suggestionSeen.add(key);
    occasionSuggestions.push(detected);
  }
  const duplicate = findDuplicateContactSuggestions(allContacts).find(
    (suggestion) => suggestion.contactId === contact.id,
  );
  return {
    contact,
    facts,
    totalFacts: total,
    occasions: occasionRows.map((occasion) => ({
      id: occasion.id,
      kind: occasion.kind,
      label: occasion.label,
      month: occasion.month,
      day: occasion.day,
      year: occasion.year,
      leadDays: occasion.leadDays,
      notes: occasion.notes,
      quarantined: occasion.quarantined,
    })),
    occasionSuggestions,
    mergeOptions: allContacts
      .filter((person) => person.id !== contact.id)
      .map((person) => ({
        id: person.id,
        label: person.relationship ? `${person.name} (${person.relationship})` : person.name,
      })),
    ...(duplicate ? { duplicate: { targetId: duplicate.targetId, reason: duplicate.reason } } : {}),
  };
}
