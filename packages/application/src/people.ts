/**
 * The People section's reads.
 *
 * A person's page is assembled from four stores that never had a join between
 * them: `contacts` for identity, `occasions` for birthdays, `memories` for
 * facts and for what happened, and the knowledge graph for connections to
 * other people and places. This module is the one place that composition
 * lives, so the pages stay declarative and the shape is testable on its own.
 *
 * It reuses `getPersonProfile` wholesale rather than restating its queries —
 * the person page must keep every control it has today, and duplicating the
 * fact/occasion/merge reads would be two things to keep in step.
 */

import { getAgent } from '@assistant/core/chat';
import { daysUntilOccurrence, listOccasionsForContact } from '@assistant/core/memory/occasions';
import {
  contacts,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  type OccasionRow,
  occasions as occasionsTable,
} from '@assistant/db';
import type { ProfileContact, Records } from '@assistant/persistence';
import { and, count, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  activeKnowledgeGraphWhere,
  getKnowledgeGraphNeighborhood,
  type KnowledgeGraphEntityView,
  type KnowledgeGraphNeighborEdge,
} from './knowledge-graph.js';
import { type PersonGraphEdgeInput, projectPersonGraph } from './people-graph-projection.js';
import {
  type BirthdayView,
  derivePersonGroup,
  type PersonGroup,
  turningAge,
} from './people-presentation.js';
import { getPersonProfile, type MemorySnapshot, type PersonProfile } from './profile/queries.js';
import { presentKnowledgeGraphRelation } from './relationship-presentation.js';

export type {
  BirthdayView,
  PersonGroup,
} from './people-presentation.js';

/**
 * The same 500 the memory overview uses. Beyond it the directory searches
 * server-side rather than silently truncating.
 */
const DIRECTORY_LIMIT = 500;
const NEIGHBOUR_LIMIT = 120;
const TIMELINE_LIMIT = 20;

/** Predicates that answer "where do they live" and "how did we meet". */
const LOCATION_PREDICATE = 'lives_in';
const ORIGIN_PREDICATES = new Set(['met', 'met_at', 'met_during']);

export interface PersonSummary {
  id: string;
  name: string;
  /** Free text the owner typed; '' when unset. */
  relationship: string;
  trust: string;
  group: PersonGroup;
  /** Object label of an open `lives_in` edge; null when none is recorded. */
  location: string | null;
  factCount: number;
  birthday: BirthdayView | null;
  /** Newest recorded happening. Null when nothing has been recorded. */
  lastContactAt: Date | null;
}

/** Apply the SQL directory's display derivation to an adapter-backed row. */
export function personSummaryFromStoredRow(
  row: {
    contact: ProfileContact;
    factCount: number;
    birthday: Records['occasions'] | null;
    lastContactAt: Date | null;
    location: string | null;
  },
  now: Date,
): PersonSummary {
  const { contact, birthday } = row;
  const daysUntil = birthday ? daysUntilOccurrence(birthday, now) : null;
  return {
    id: contact.id,
    name: contact.name,
    relationship: contact.relationship,
    trust: contact.trust,
    group: derivePersonGroup(contact),
    location: row.location,
    factCount: row.factCount,
    birthday:
      birthday && daysUntil !== null
        ? {
            month: birthday.month,
            day: birthday.day,
            year: birthday.year,
            daysUntil,
            turningAge: turningAge(birthday.year, daysUntil, now),
          }
        : null,
    lastContactAt: row.lastContactAt,
  };
}

export interface PersonRelation {
  id: string;
  /** "Élise and Marc are partners." — from the shared presenter. */
  sentence: string;
  /** "Partner" — compact label for the row. */
  label: string;
  otherLabel: string;
  /** Set when the other end is itself a contact, so the row can link. */
  otherContactId: string | null;
  otherEntityId: string;
  validFrom: string | null;
  validUntil: string | null;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
}

/** A connection to something that is not a person — a place, employer, event. */
export interface PersonConnection {
  id: string;
  sentence: string;
  label: string;
  otherLabel: string;
  otherKind: string;
  validFrom: string | null;
  validUntil: string | null;
}

/**
 * One recorded happening. `occurredAt` prefers the stated date over the row's
 * creation time: an episode saved today may describe last Tuesday's lunch.
 */
export interface PersonEvent {
  id: string;
  content: string;
  occurredAt: Date;
  /** True when the date is the assistant's write time rather than a stated one. */
  dateIsRecordTime: boolean;
  kind: string;
  originTrust: string;
}

export interface UpcomingOccasionView {
  kind: string;
  label: string;
  daysUntil: number;
  month: number;
  day: number;
}

export interface PersonDossier {
  /** Everything today's person page already shows, unchanged. */
  profile: PersonProfile;
  group: PersonGroup;
  /** Null when the contact has no graph node yet — every edge below is empty. */
  entityId: string | null;
  /**
   * The same node as a graph entity, so a caller can offer to connect this
   * person to something without first going to the knowledge graph to look
   * them up. Null exactly when `entityId` is.
   */
  entity: KnowledgeGraphEntityView | null;
  location: string | null;
  origins: PersonConnection[];
  relations: PersonRelation[];
  connections: PersonConnection[];
  events: PersonEvent[];
  lastContactAt: Date | null;
  birthday: BirthdayView | null;
  /** Within its own lead window, so the card can say a reminder is coming. */
  upcomingOccasion: UpcomingOccasionView | null;
}

/** Active knowledge facts: the same predicate `getPersonProfile` counts on. */
function activeMemory() {
  return and(
    eq(memories.quarantined, false),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );
}

/**
 * Rows that record something that happened, as opposed to something that is
 * true. `category = 'experience'` is the extractor's own distinction
 * ("knowledge = durable fact; experience = what happened"), which makes it the
 * honest basis for a contact timeline — a knowledge fact's `createdAt` says
 * when the assistant learned it, not when you last met.
 *
 * Note these rows expire after 90 days, so the timeline is a rolling window
 * rather than a permanent history.
 */
function experienceMemory() {
  return and(
    eq(memories.category, 'experience'),
    eq(memories.quarantined, false),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );
}

/** `coalesce(valid_from, created_at)` — when the thing happened. */
const occurredAt = sql<Date>`coalesce(${memories.validFrom}, ${memories.createdAt})`;

function toBirthday(
  rows: Array<Pick<OccasionRow, 'kind' | 'quarantined' | 'month' | 'day' | 'year' | 'recurrence'>>,
  now: Date,
): BirthdayView | null {
  const birthday = rows.find((row) => row.kind === 'birthday' && !row.quarantined);
  if (!birthday) return null;
  const daysUntil = daysUntilOccurrence(birthday, now);
  return {
    month: birthday.month,
    day: birthday.day,
    year: birthday.year,
    daysUntil,
    turningAge: turningAge(birthday.year, daysUntil, now),
  };
}

/** `contact:<uuid>` is the canonical key the extractor gives a person node. */
function contactIdFromCanonicalKey(key: string): string | null {
  const match = /^contact:([0-9a-f-]{36})$/i.exec(key);
  return match?.[1] ?? null;
}

/**
 * A stored edge is directed, and the presenter needs it in stored order. When
 * the queried person is the *object* of the edge, the other party is the
 * subject — feeding the pair in page order instead would render "Léa is
 * Élise's parent" for an edge that says the opposite.
 */
function presentEdge(edge: KnowledgeGraphNeighborEdge, selfLabel: string) {
  // `label` already carries the owner's preferred spelling — the neighbourhood
  // query coalesces it in SQL.
  const otherLabel = edge.other.label;
  return edge.outbound
    ? presentKnowledgeGraphRelation({
        subjectLabel: selfLabel,
        predicate: edge.predicate,
        objectLabel: otherLabel,
      })
    : presentKnowledgeGraphRelation({
        subjectLabel: otherLabel,
        predicate: edge.predicate,
        objectLabel: selfLabel,
      });
}

/**
 * The whole person page in one call.
 *
 * Returns null for an unknown id and for the owner — `getPersonProfile` already
 * refuses the owner contact, and the People section is other people.
 */
export async function getPersonDossier(
  db: Db,
  contactId: string,
  opts: { factLimit?: number; now?: Date } = {},
): Promise<PersonDossier | null> {
  const now = opts.now ?? new Date();
  const profile = await getPersonProfile(db, contactId, opts.factLimit);
  if (!profile) return null;

  const agent = await getAgent(db);
  const [entityRow] = await db
    .select({ id: knowledgeGraphEntities.id })
    .from(knowledgeGraphEntities)
    .where(
      and(
        eq(knowledgeGraphEntities.agentId, agent.id),
        eq(knowledgeGraphEntities.contactId, contactId),
      ),
    )
    .limit(1);
  const entityId = entityRow?.id ?? null;

  const [neighbourhood, eventRows] = await Promise.all([
    entityId
      ? getKnowledgeGraphNeighborhood(db, { entityId, limit: NEIGHBOUR_LIMIT })
      : Promise.resolve({ entity: null, edges: [], total: 0 }),
    db
      .select({
        id: memories.id,
        content: memories.content,
        kind: memories.kind,
        originTrust: memories.originTrust,
        createdAt: memories.createdAt,
        validFrom: memories.validFrom,
        occurredAt,
      })
      .from(memories)
      .where(and(experienceMemory(), eq(memories.subjectContactId, contactId)))
      .orderBy(desc(occurredAt))
      .limit(TIMELINE_LIMIT),
  ]);

  const name = profile.contact.name;
  const relations: PersonRelation[] = [];
  const connections: PersonConnection[] = [];
  const origins: PersonConnection[] = [];
  let location: string | null = null;

  for (const edge of neighbourhood.edges) {
    if (edge.reviewStatus === 'rejected') continue;
    const presentation = presentEdge(edge, name);
    const otherLabel = edge.other.label;

    if (edge.other.kind === 'person') {
      relations.push({
        id: edge.id,
        sentence: presentation.sentence,
        label: presentation.label,
        otherLabel,
        otherContactId: contactIdFromCanonicalKey(edge.other.canonicalKey),
        otherEntityId: edge.other.id,
        validFrom: edge.validFrom,
        validUntil: edge.validUntil,
        reviewStatus: edge.reviewStatus,
      });
      if (ORIGIN_PREDICATES.has(edge.predicate)) {
        origins.push({
          id: edge.id,
          sentence: presentation.sentence,
          label: presentation.label,
          otherLabel,
          otherKind: edge.other.kind,
          validFrom: edge.validFrom,
          validUntil: edge.validUntil,
        });
      }
      continue;
    }

    const connection: PersonConnection = {
      id: edge.id,
      sentence: presentation.sentence,
      label: presentation.label,
      otherLabel,
      otherKind: edge.other.kind,
      validFrom: edge.validFrom,
      validUntil: edge.validUntil,
    };

    // Only an open `lives_in` is where they live now; a closed one is a past
    // address, and `born_in`/`grew_up_in` were never the current one. The edge
    // that becomes the header location is not repeated below it.
    if (edge.predicate === LOCATION_PREDICATE && edge.outbound && edge.validUntil === null) {
      if (location === null) {
        location = otherLabel;
        continue;
      }
    }
    if (ORIGIN_PREDICATES.has(edge.predicate)) origins.push(connection);
    else connections.push(connection);
  }

  const occasionRows = await listOccasionsForContact(db, contactId);
  const birthday = toBirthday(occasionRows, now);
  const upcomingOccasion = nextOccasionWithinLead(occasionRows, now);

  const events: PersonEvent[] = eventRows.map((row) => ({
    id: row.id,
    content: row.content,
    occurredAt: new Date(row.occurredAt),
    dateIsRecordTime: row.validFrom === null,
    kind: row.kind,
    originTrust: row.originTrust,
  }));

  return {
    profile,
    group: derivePersonGroup({ relationship: profile.contact.relationship }),
    entityId,
    entity: neighbourhood.entity,
    location,
    origins,
    relations,
    connections,
    events,
    lastContactAt: events[0]?.occurredAt ?? null,
    birthday,
    upcomingOccasion,
  };
}

/**
 * Apply the SQL dossier's derivations to adapter-backed parts: the same graph
 * buckets, header location, birthday, and reminder window, so a Firestore
 * person page renders exactly what the PostgreSQL one does.
 */
export function personDossierFromStoredParts(
  parts: {
    profile: PersonProfile;
    entity: KnowledgeGraphEntityView | null;
    edges: PersonGraphEdgeInput[];
    /** Newest first, already bounded to the timeline window. */
    events: PersonEvent[];
    /** Non-quarantined occasions for this contact. */
    occasions: Array<
      Pick<
        OccasionRow,
        'quarantined' | 'kind' | 'label' | 'month' | 'day' | 'year' | 'recurrence' | 'leadDays'
      >
    >;
  },
  now: Date,
): PersonDossier {
  const graph = projectPersonGraph(parts.profile.contact.name, parts.edges);
  return {
    profile: parts.profile,
    group: derivePersonGroup({ relationship: parts.profile.contact.relationship }),
    entityId: parts.entity?.id ?? null,
    entity: parts.entity,
    location: graph.location,
    origins: graph.origins,
    relations: graph.relations,
    connections: graph.connections,
    events: parts.events,
    lastContactAt: parts.events[0]?.occurredAt ?? null,
    birthday: toBirthday(parts.occasions, now),
    upcomingOccasion: nextOccasionWithinLead(parts.occasions, now),
  };
}

/** The soonest occasion already inside its own lead window, if any. */
export function nextOccasionWithinLead(
  rows: Array<
    Pick<
      OccasionRow,
      'quarantined' | 'kind' | 'label' | 'month' | 'day' | 'year' | 'recurrence' | 'leadDays'
    >
  >,
  now: Date,
): UpcomingOccasionView | null {
  let soonest: UpcomingOccasionView | null = null;
  for (const row of rows) {
    if (row.quarantined) continue;
    const daysUntil = daysUntilOccurrence(row, now);
    if (daysUntil < 0 || daysUntil > row.leadDays) continue;
    if (soonest && soonest.daysUntil <= daysUntil) continue;
    soonest = {
      kind: row.kind,
      label: row.label,
      daysUntil,
      month: row.month,
      day: row.day,
    };
  }
  return soonest;
}

/**
 * The directory.
 *
 * Five queries regardless of how many contacts there are. The temptation is to
 * loop the per-contact helpers (`listOccasionsForContact` especially) — at 500
 * contacts that is 2000 round trips for one page, so every read below is
 * grouped and stitched in memory instead.
 */
export async function listPeopleDirectory(
  db: Db,
  opts: { now?: Date } = {},
): Promise<PersonSummary[]> {
  const now = opts.now ?? new Date();
  const agent = await getAgent(db);
  const people = await db
    .select()
    .from(contacts)
    .where(ne(contacts.trust, 'owner'))
    .orderBy(contacts.name, contacts.id)
    .limit(DIRECTORY_LIMIT);
  return summarizePeopleDirectory(db, agent.id, people, now);
}

/** One bounded, resumable directory page for the configured owner. */
export async function listPeopleDirectoryPage(
  db: Db,
  input: { now?: Date; limit: number; after?: { name: string; id: string } },
): Promise<{
  people: PersonSummary[];
  hasMore: boolean;
  nextCursor: { name: string; id: string } | null;
}> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new Error('People page size must be between 1 and 100');
  const now = input.now ?? new Date();
  const agent = await getAgent(db);
  const after = input.after;
  const rows = await db
    .select()
    .from(contacts)
    .where(
      and(
        ne(contacts.trust, 'owner'),
        after
          ? or(
              gt(contacts.name, after.name),
              and(eq(contacts.name, after.name), gt(contacts.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(contacts.name, contacts.id)
    .limit(input.limit + 1);
  const selected = rows.slice(0, input.limit);
  const people = await summarizePeopleDirectory(db, agent.id, selected, now);
  const tail = selected.at(-1);
  const hasMore = rows.length > input.limit;
  return {
    people,
    hasMore,
    nextCursor: hasMore && tail ? { name: tail.name, id: tail.id } : null,
  };
}

async function summarizePeopleDirectory(
  db: Db,
  agentId: string,
  people: Array<typeof contacts.$inferSelect>,
  now: Date,
): Promise<PersonSummary[]> {
  if (people.length === 0) return [];
  const ids = people.map((person) => person.id);

  const [factRows, contactRows, occasionRows, edgeRows] = await Promise.all([
    db
      .select({ contactId: memories.subjectContactId, value: count() })
      .from(memories)
      .where(
        and(
          activeMemory(),
          eq(memories.category, 'knowledge'),
          inArray(memories.subjectContactId, ids),
        ),
      )
      .groupBy(memories.subjectContactId),
    db
      .select({
        contactId: memories.subjectContactId,
        latest: sql<string>`max(coalesce(${memories.validFrom}, ${memories.createdAt}))`,
      })
      .from(memories)
      .where(and(experienceMemory(), inArray(memories.subjectContactId, ids)))
      .groupBy(memories.subjectContactId),
    db
      .select()
      .from(occasionsTable)
      .where(
        and(
          eq(occasionsTable.agentId, agentId),
          inArray(occasionsTable.contactId, ids),
          eq(occasionsTable.quarantined, false),
        ),
      ),
    listDirectoryEdges(db, agentId, ids),
  ]);

  const factCounts = new Map(factRows.map((row) => [row.contactId, Number(row.value)]));
  const lastContact = new Map(
    contactRows.flatMap((row) =>
      row.contactId && row.latest ? [[row.contactId, new Date(row.latest)] as const] : [],
    ),
  );
  const occasionsByContact = new Map<string, OccasionRow[]>();
  for (const row of occasionRows) {
    const list = occasionsByContact.get(row.contactId);
    if (list) list.push(row);
    else occasionsByContact.set(row.contactId, [row]);
  }

  return people.map((person) => {
    const edges = edgeRows.get(person.id);
    return {
      id: person.id,
      name: person.name,
      relationship: person.relationship,
      trust: person.trust,
      group: derivePersonGroup({ relationship: person.relationship }),
      location: edges?.location ?? null,
      factCount: factCounts.get(person.id) ?? 0,
      birthday: toBirthday(occasionsByContact.get(person.id) ?? [], now),
      lastContactAt: lastContact.get(person.id) ?? null,
    };
  });
}

interface DirectoryEdges {
  location: string | null;
}

/**
 * One graph pass for the whole directory: the open `lives_in` label.
 *
 * Goes through `activeKnowledgeGraphWhere` rather than hand-written SQL so the
 * directory shows exactly the edges the map and GraphRAG consider live. That
 * contract has five parts — a non-null embedding, a `ready` source whose hash
 * still matches the memory, a current extraction version, a non-rejected
 * review status, and an evidence quote — and restating any of them by hand is
 * how the two views drift apart.
 */
async function listDirectoryEdges(
  db: Db,
  agentId: string,
  contactIds: string[],
): Promise<Map<string, DirectoryEdges>> {
  const self = alias(knowledgeGraphEntities, 'directory_self');
  const other = alias(knowledgeGraphEntities, 'directory_other');
  const rows = await db
    .select({
      contactId: self.contactId,
      predicate: knowledgeGraphRelations.predicate,
      otherLabel: sql<string>`COALESCE(${other.preferredLabel}, ${other.label})`,
      validUntil: knowledgeGraphRelations.validUntil,
      subjectId: knowledgeGraphRelations.subjectEntityId,
      selfId: self.id,
    })
    .from(knowledgeGraphRelations)
    .innerJoin(
      self,
      or(
        eq(knowledgeGraphRelations.subjectEntityId, self.id),
        eq(knowledgeGraphRelations.objectEntityId, self.id),
      ),
    )
    .innerJoin(
      other,
      eq(
        other.id,
        sql`CASE WHEN ${knowledgeGraphRelations.subjectEntityId} = ${self.id}
                 THEN ${knowledgeGraphRelations.objectEntityId}
                 ELSE ${knowledgeGraphRelations.subjectEntityId} END`,
      ),
    )
    .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
    .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
    .where(and(activeKnowledgeGraphWhere(agentId), inArray(self.contactId, contactIds)));

  const byContact = new Map<string, DirectoryEdges>();
  for (const row of rows) {
    if (!row.contactId) continue;
    const entry = byContact.get(row.contactId) ?? { location: null };
    // Only an outbound, still-open `lives_in` is where they live now.
    if (
      row.predicate === LOCATION_PREDICATE &&
      row.subjectId === row.selfId &&
      row.validUntil === null &&
      entry.location === null
    ) {
      entry.location = row.otherLabel;
    }
    byContact.set(row.contactId, entry);
  }
  return byContact;
}

export type { MemorySnapshot, PersonProfile };
