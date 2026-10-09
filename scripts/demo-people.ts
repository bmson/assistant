/**
 * Demo people for looking at the People section.
 *
 * The seed creates one contact — the owner — so `/people` renders empty on a
 * fresh database and there is nothing to review a design against. This writes a
 * small cast of six with birthdays, connections, and things that happened, so
 * every state the section can be in is on screen at once, including the empty
 * ones.
 *
 *   pnpm tsx scripts/demo-people.ts [--purge] [--agent <id>]
 *
 * Runs require an allocator-owned disposable database. Each cast has an
 * owner/run source namespace and a committed ledger of its created IDs.
 * Re-running replaces that cast atomically; `--purge` removes only those IDs.
 *
 * A graph edge is only live when five separate conditions hold (see
 * `activeKnowledgeGraphWhere`): the source memory carries an embedding, its
 * extraction source row is `ready` with a matching content hash and a current
 * extraction version, the edge is not rejected, and it has an evidence quote.
 * Miss any one and the relationship silently does not render — which is most of
 * why this script exists rather than a handful of INSERTs.
 */

import { createHash, randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  agents,
  contacts,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  maintenanceCursors,
  memories,
  occasions,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { and, eq, inArray, sql } from 'drizzle-orm';

if (process.env.NODE_ENV === 'production') {
  throw new Error('demo-people writes fixture data and must never run against production.');
}

assertAllocatedTestTarget({
  databaseUrl: process.env.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
});
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing allocated database URL');
const connection = createDb(databaseUrl);
try {
  const ownership = await connection.execute(
    sql`SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`,
  );
  if (ownership[0]?.marker !== `assistant-test-target:${process.env.ASSISTANT_TEST_TARGET_TOKEN}`)
    throw new Error('Demo fixture database ownership mismatch');
  const output = await connection.transaction(async (db) => {
    const ownerFlag = process.argv.indexOf('--agent');
    const requestedOwner = ownerFlag === -1 ? undefined : process.argv[ownerFlag + 1];
    if (ownerFlag !== -1 && (!requestedOwner || requestedOwner.startsWith('--')))
      throw new Error('--agent requires an owner ID');
    const ownerRows = await db
      .select()
      .from(agents)
      .where(requestedOwner ? eq(agents.id, requestedOwner) : undefined)
      .limit(2);
    if (ownerRows.length > 1) throw new Error('Choose the demo owner explicitly with --agent <id>');
    const [agentRow] = ownerRows;
    if (!agentRow) throw new Error('No agent row — run `pnpm db:migrate && pnpm seed` first.');
    // Bound to a const so the narrowing survives into the helpers below.
    const agent = agentRow;
    // Fixture identity is separate from ordinary semantic keys and scoped to the
    // selected owner. Ambiguous rows from older, unscoped fixtures are preserved.
    const ledgerName = `fixture:demo-people:${agent.id}`;
    const SOURCE = `demo-people:${agent.id}:${randomUUID()}`;
    interface FixtureLedger {
      version: 1;
      agentId: string;
      source: string;
      contacts: string[];
      memories: string[];
      entities: string[];
      occasions: string[];
    }
    const created: FixtureLedger = {
      version: 1,
      agentId: agent.id,
      source: SOURCE,
      contacts: [],
      memories: [],
      entities: [],
      occasions: [],
    };

    const now = new Date();
    const year = now.getUTCFullYear();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

    /**
     * A deterministic unit vector. The column only has to be non-null for an edge
     * to count as live; similarity search over fixture rows is meaningless anyway,
     * so this costs no model call.
     */
    const EMBEDDING = (() => {
      const vector = new Array<number>(1536).fill(0);
      vector[0] = 1;
      return vector;
    })();

    type Kind = 'person' | 'organization' | 'project' | 'place' | 'event' | 'date' | 'topic';

    interface FactSpec {
      /** The sentence the edge is extracted from — shown as its evidence. */
      content: string;
      subject: string;
      predicate: string;
      object: string;
      objectKind: Kind;
      validFrom?: string;
      validUntil?: string;
    }

    interface EventSpec {
      content: string;
      daysAgo: number;
    }

    interface PersonSpec {
      name: string;
      relationship: string;
      /** Omitted entirely for the person who is meant to have no birthday. */
      birthday?: { month: number; day: number; year?: number };
      facts: FactSpec[];
      events: EventSpec[];
      /** Plain knowledge facts with no graph edge — the "Saved facts" list. */
      notes: string[];
    }

    /**
     * The cast is chosen to cover the states, not to be realistic: a full card, a
     * birthday within its lead window, a birthday with no year, an ended
     * relationship, someone with no graph at all, and someone with nothing but a
     * name.
     */
    const PEOPLE: PersonSpec[] = [
      {
        name: 'Élise Aubert',
        relationship: 'Sister',
        birthday: { month: 3, day: 18, year: 1987 },
        facts: [
          {
            content: 'Élise Aubert lives in Lyon, where she moved after university.',
            subject: 'Élise Aubert',
            predicate: 'lives_in',
            object: 'Lyon',
            objectKind: 'place',
          },
          {
            content: 'Élise Aubert has been Marc Vidal’s partner since March 2016.',
            subject: 'Élise Aubert',
            predicate: 'partner_of',
            object: 'Marc Vidal',
            objectKind: 'person',
            validFrom: '2016-03',
          },
          {
            content: 'Élise Aubert is Léa Aubert’s parent; Léa was born in 2019.',
            subject: 'Élise Aubert',
            predicate: 'parent_of',
            object: 'Léa Aubert',
            objectKind: 'person',
            validFrom: '2019',
          },
        ],
        events: [
          {
            content: 'Lunch with Élise at Le Petit Sud; she is thinking about moving back to Lyon.',
            daysAgo: 0,
          },
          { content: 'Called Élise about Georges for twenty-two minutes.', daysAgo: 31 },
          { content: 'Élise sent photographs from the weekend in Annecy.', daysAgo: 74 },
        ],
        notes: ['Élise Aubert is allergic to shellfish.'],
      },
      {
        name: 'Marc Vidal',
        relationship: 'Brother-in-law',
        birthday: { month: 11, day: 2, year: 1985 },
        facts: [
          {
            content: 'Marc Vidal lives in Lyon with Élise.',
            subject: 'Marc Vidal',
            predicate: 'lives_in',
            object: 'Lyon',
            objectKind: 'place',
          },
          {
            content: 'Marc Vidal works at Rhône Analytics as a data engineer.',
            subject: 'Marc Vidal',
            predicate: 'works_at',
            object: 'Rhône Analytics',
            objectKind: 'organization',
            validFrom: '2021-09',
          },
        ],
        events: [
          { content: 'Marc mentioned he is taking the autumn off to renovate.', daysAgo: 12 },
        ],
        notes: [],
      },
      {
        name: 'Priya Raman',
        relationship: 'Colleague at Northwind',
        // Inside the default seven-day lead window, so the reminder strip renders.
        birthday: { month: now.getUTCMonth() + 1, day: now.getUTCDate(), year: 1991 },
        facts: [
          {
            content: 'Priya Raman works at Northwind, where she leads the platform team.',
            subject: 'Priya Raman',
            predicate: 'works_at',
            object: 'Northwind',
            objectKind: 'organization',
            validFrom: '2019-01',
          },
          {
            content: 'Priya Raman lives in Rotterdam.',
            subject: 'Priya Raman',
            predicate: 'lives_in',
            object: 'Rotterdam',
            objectKind: 'place',
          },
        ],
        events: [
          { content: 'Priya walked through the migration plan on the Thursday call.', daysAgo: 4 },
          { content: 'Priya asked whether the interview went ahead.', daysAgo: 20 },
        ],
        notes: ['Priya Raman prefers written summaries over meetings.'],
      },
      {
        name: 'Tomás Ferreira',
        relationship: 'Friend',
        // No year: the card must show the date and no age.
        birthday: { month: 6, day: 9 },
        facts: [
          {
            content: 'Tomás Ferreira and the owner met during the 2014 Lisbon type conference.',
            subject: 'Tomás Ferreira',
            predicate: 'met_during',
            object: '2014 Lisbon type conference',
            objectKind: 'event',
          },
          {
            content: 'Tomás Ferreira worked at Praça Studio between 2015 and 2022.',
            subject: 'Tomás Ferreira',
            predicate: 'worked_at',
            object: 'Praça Studio',
            objectKind: 'organization',
            validFrom: '2015',
            validUntil: '2022',
          },
        ],
        events: [{ content: 'Tomás is in town in October and suggested dinner.', daysAgo: 45 }],
        notes: [],
      },
      {
        // No graph edges at all: relationships, location and how-we-met must all
        // fall back to their empty states while the birthday still renders.
        name: 'Greta Lindqvist',
        relationship: 'Neighbour',
        birthday: { month: 12, day: 24, year: 1970 },
        facts: [],
        events: [],
        notes: ['Greta Lindqvist waters the plants when the flat is empty.'],
      },
      {
        // Nothing but a name — every section on the card must degrade cleanly.
        name: 'Sam Okonkwo',
        relationship: '',
        facts: [],
        events: [],
        notes: [],
      },
    ];

    /** Content hashes are globally unique, so fixture rows carry their own namespace. */
    function hash(content: string): string {
      return createHash('sha256').update(`${SOURCE}:${content}`).digest('hex');
    }

    async function purge(): Promise<number> {
      const [entry] = await db
        .select()
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, ledgerName))
        .for('update');
      if (!entry) return 0;
      const prior = JSON.parse(entry.cursor ?? 'null') as FixtureLedger;
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if (
        prior?.version !== 1 ||
        prior.agentId !== agent.id ||
        typeof prior.source !== 'string' ||
        !prior.source.startsWith(`demo-people:${agent.id}:`) ||
        !uuid.test(prior.source.slice(`demo-people:${agent.id}:`.length)) ||
        ![prior.contacts, prior.memories, prior.entities, prior.occasions].every(
          (ids) =>
            Array.isArray(ids) &&
            ids.length <= 512 &&
            ids.every((id) => typeof id === 'string' && uuid.test(id)),
        )
      )
        throw new Error('Invalid demo fixture ownership ledger');
      // Only explicit committed fixture IDs are eligible. The entire cleanup and
      // replacement seed are one transaction, so an interrupted run rolls back.
      if (prior.memories.length)
        await db
          .delete(memories)
          .where(
            and(
              eq(memories.agentId, agent.id),
              eq(memories.source, prior.source),
              inArray(memories.id, prior.memories),
            ),
          );
      if (prior.occasions.length)
        await db
          .delete(occasions)
          .where(
            and(
              eq(occasions.agentId, agent.id),
              eq(occasions.source, prior.source),
              inArray(occasions.id, prior.occasions),
            ),
          );
      if (prior.entities.length)
        await db
          .delete(knowledgeGraphEntities)
          .where(
            and(
              eq(knowledgeGraphEntities.agentId, agent.id),
              inArray(knowledgeGraphEntities.id, prior.entities),
              sql`NOT EXISTS (SELECT 1 FROM knowledge_graph_relations r WHERE r.subject_entity_id = ${knowledgeGraphEntities.id} OR r.object_entity_id = ${knowledgeGraphEntities.id})`,
            ),
          );
      const removed = prior.contacts.length
        ? await db
            .delete(contacts)
            .where(
              and(
                inArray(contacts.id, prior.contacts),
                eq(contacts.notes, prior.source),
                sql`NOT EXISTS (SELECT 1 FROM knowledge_graph_entities e WHERE e.contact_id = ${contacts.id})`,
                sql`NOT EXISTS (SELECT 1 FROM memories m WHERE m.subject_contact_id = ${contacts.id})`,
                sql`NOT EXISTS (SELECT 1 FROM occasions o WHERE o.contact_id = ${contacts.id})`,
                sql`NOT EXISTS (SELECT 1 FROM knowledge_graph_sources s WHERE s.subject_contact_id = ${contacts.id})`,
              ),
            )
            .returning({ id: contacts.id })
        : [];
      await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, ledgerName));
      return removed.length;
    }

    const removed = await purge();
    if (process.argv.includes('--purge')) {
      return [`Removed ${removed} demo contacts.`];
    }

    /** Person nodes are keyed `contact:<uuid>`; everything else `<kind>:<label>`. */
    const entityIds = new Map<string, string>();

    async function entityFor(label: string, kind: Kind, contactId?: string): Promise<string> {
      const canonicalKey = contactId
        ? `contact:${contactId}`
        : `${SOURCE}:${kind}:${label.toLocaleLowerCase()}`;
      const existing = entityIds.get(canonicalKey);
      if (existing) return existing;
      const [row] = await db
        .insert(knowledgeGraphEntities)
        .values({ agentId: agent.id, canonicalKey, label, kind, contactId })
        .onConflictDoUpdate({
          target: [knowledgeGraphEntities.agentId, knowledgeGraphEntities.canonicalKey],
          set: { label, kind },
        })
        .returning({ id: knowledgeGraphEntities.id });
      const id = row?.id;
      if (!id) throw new Error(`Could not create graph entity for ${canonicalKey}`);
      created.entities.push(id);
      entityIds.set(canonicalKey, id);
      return id;
    }

    const contactIds = new Map<string, string>();

    // Pass one: contacts, so a person↔person edge can reference either end.
    for (const person of PEOPLE) {
      const [row] = await db
        .insert(contacts)
        .values({
          name: person.name,
          relationship: person.relationship,
          trust: 'known',
          // The fixture tag lives in `notes` — there is no `source` column here.
          notes: SOURCE,
        })
        .returning({ id: contacts.id });
      if (!row) throw new Error(`Could not create contact ${person.name}`);
      created.contacts.push(row.id);
      contactIds.set(person.name, row.id);
      await entityFor(person.name, 'person', row.id);
    }

    // Léa is named only as the object of an edge, so she needs her own contact row
    // for the relationship to link anywhere.
    {
      const [row] = await db
        .insert(contacts)
        .values({ name: 'Léa Aubert', relationship: 'Niece', trust: 'known', notes: SOURCE })
        .returning({ id: contacts.id });
      if (row) {
        created.contacts.push(row.id);
        contactIds.set('Léa Aubert', row.id);
        await entityFor('Léa Aubert', 'person', row.id);
      }
    }

    for (const person of PEOPLE) {
      const contactId = contactIds.get(person.name);
      if (!contactId) continue;

      if (person.birthday) {
        const [occasion] = await db
          .insert(occasions)
          .values({
            agentId: agent.id,
            contactId,
            kind: 'birthday',
            month: person.birthday.month,
            day: person.birthday.day,
            year: person.birthday.year ?? null,
            ownerConfirmed: true,
            source: SOURCE,
          })
          .onConflictDoNothing()
          .returning({ id: occasions.id });
        if (occasion) created.occasions.push(occasion.id);
      }

      // Facts that back a graph edge. Each needs the full liveness set.
      for (const [index, fact] of person.facts.entries()) {
        const contentHash = hash(fact.content);
        const [memory] = await db
          .insert(memories)
          .values({
            agentId: agent.id,
            category: 'knowledge',
            kind: 'fact',
            content: fact.content,
            contentHash,
            embedding: EMBEDDING,
            importance: 3,
            confidence: '0.90',
            originTrust: 'owner',
            ownerConfirmed: true,
            subjectContactId: contactId,
            domain: 'relationships',
            source: SOURCE,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning({ id: memories.id });
        if (!memory) continue;
        created.memories.push(memory.id);

        await db
          .insert(knowledgeGraphSources)
          .values({
            memoryId: memory.id,
            contentHash,
            subjectContactId: contactId,
            status: 'ready',
            extractionVersion: GRAPH_EXTRACTION_VERSION,
          })
          .onConflictDoNothing();

        const subjectId = await entityFor(
          fact.subject,
          'person',
          contactIds.get(fact.subject) ?? undefined,
        );
        const objectId = await entityFor(
          fact.object,
          fact.objectKind,
          fact.objectKind === 'person' ? contactIds.get(fact.object) : undefined,
        );

        await db
          .insert(knowledgeGraphRelations)
          .values({
            agentId: agent.id,
            subjectEntityId: subjectId,
            predicate: fact.predicate,
            objectEntityId: objectId,
            sourceMemoryId: memory.id,
            evidenceQuote: fact.content,
            sourceFingerprint: `${SOURCE}:${fact.predicate}:${index}`,
            ordinal: index,
            confidence: '0.90',
            validFrom: fact.validFrom ?? null,
            validUntil: fact.validUntil ?? null,
            reviewStatus: 'confirmed',
            reviewedAt: now,
          })
          .onConflictDoNothing();
      }

      // Plain facts with no edge — these fill the "Saved facts" list.
      for (const note of person.notes) {
        const [memory] = await db
          .insert(memories)
          .values({
            agentId: agent.id,
            category: 'knowledge',
            kind: 'fact',
            content: note,
            contentHash: hash(note),
            embedding: EMBEDDING,
            importance: 2,
            confidence: '0.80',
            originTrust: 'owner',
            ownerConfirmed: true,
            subjectContactId: contactId,
            domain: 'relationships',
            source: SOURCE,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning({ id: memories.id });
        if (memory) created.memories.push(memory.id);
      }

      // Experience rows: what happened, and what "last contact" is read from.
      for (const event of person.events) {
        const when = daysAgo(event.daysAgo);
        const [memory] = await db
          .insert(memories)
          .values({
            agentId: agent.id,
            category: 'experience',
            kind: 'episode',
            content: event.content,
            contentHash: hash(event.content),
            embedding: EMBEDDING,
            importance: 3,
            confidence: '0.90',
            originTrust: 'owner',
            subjectContactId: contactId,
            validFrom: when,
            createdAt: when,
            source: SOURCE,
            // Experience rows expire; keep the fixture visible for a while.
            expiresAt: new Date(now.getTime() + 90 * 86_400_000),
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning({ id: memories.id });
        if (memory) created.memories.push(memory.id);
      }
    }

    await db.insert(maintenanceCursors).values({
      name: ledgerName,
      cursor: JSON.stringify(created),
      updatedAt: now,
    });
    return [
      `Demo people ready (${PEOPLE.length + 1} contacts, agent ${agent.name}).`,
      ...[...contactIds].map(([name, id]) => `  ${id}  ${name}`),
      `\nBirthday inside its lead window: Priya Raman (${now.getUTCDate()}/${now.getUTCMonth() + 1}).`,
      `Reference year for spans: ${year}.`,
    ];
  });
  // Success is published only after the replacement/purge transaction commits.
  for (const line of output) console.log(line);
} catch (error) {
  // Database wrappers can include the entire query and fixture vector. Report
  // the underlying failure without dumping query parameters or claiming success.
  let cause = error;
  const seen = new Set<unknown>();
  while (cause instanceof Error && cause.cause && !seen.has(cause)) {
    seen.add(cause);
    cause = cause.cause;
  }
  console.error(cause instanceof Error ? cause.message : 'Demo fixture failed');
  process.exitCode = 1;
} finally {
  await connection.$client.end({ timeout: 5 });
}
