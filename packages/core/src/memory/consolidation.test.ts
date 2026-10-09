import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  agents,
  contacts,
  createDb,
  createPostgresOwnerCardCompilationRepository,
  type Db,
  importSources,
  memories,
  memoryImportLineage,
  memoryTombstones,
  occasions,
  ownerCard,
} from '@assistant/db';
import { allocateTestTarget, assertAllocatedTestTarget } from '@assistant/db/test-target';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { compileOwnerCard, pickWinner, runMemoryConsolidation } from './consolidation.js';
import { deleteImportSource } from './import.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const MARKER = 'xtest-consolidation';

let db: Db;
let dbUp = false;
let agentId: string;
let ownerId: string;
let personId: string | undefined;
const factIds: Record<string, string> = {};

async function insertFact(
  key: string,
  input: {
    content: string;
    confidence: string;
    createdAt?: Date;
    domain?: string;
    quarantined?: boolean;
    ownerConfirmed?: boolean;
    importance?: number;
    pinned?: boolean;
    subjectContactId?: string | null;
    validFrom?: Date;
    validUntil?: Date;
  },
) {
  const [row] = await db
    .insert(memories)
    .values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: input.content,
      contentHash: createHash('sha256').update(input.content).digest('hex'),
      confidence: input.confidence,
      importance: input.importance ?? 3,
      originTrust: 'owner',
      quarantined: input.quarantined ?? false,
      ownerConfirmed: input.ownerConfirmed ?? false,
      pinned: input.pinned ?? false,
      subjectContactId: input.subjectContactId === undefined ? ownerId : input.subjectContactId,
      domain: input.domain,
      createdAt: input.createdAt,
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
    })
    .returning({ id: memories.id });
  factIds[key] = (row as NonNullable<typeof row>).id;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

async function withIsolatedConsolidationDatabase<T>(
  run: (db: Db, isolatedAgentId: string) => Promise<T>,
): Promise<T> {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const target = allocateTestTarget(process.env.DATABASE_URL);
  const adminUrl = new URL(target.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.toString(), { max: 1 }).$client;
  let created = false;
  let isolatedDb: Db | undefined;
  let result: { value: T } | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
    created = true;
    await admin.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    isolatedDb = createDb(target.databaseUrl, { max: 1 });
    await migrate(isolatedDb, {
      migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/', import.meta.url)),
    });
    const isolatedAgentId = randomUUID();
    await isolatedDb.insert(agents).values({
      id: isolatedAgentId,
      name: 'Consolidation fence owner',
      email: `consolidation-${randomUUID()}@example.test`,
      workspacePrefix: `consolidation-${isolatedAgentId}`,
    });
    result = { value: await run(isolatedDb, isolatedAgentId) };
  } catch (error) {
    primaryError = error;
  } finally {
    const attemptCleanup = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    const database = isolatedDb;
    if (database) await attemptCleanup(() => database.$client.end({ timeout: 5 }));
    if (created)
      await attemptCleanup(async () => {
        const [owned] = await admin<{ marker: string | null }[]>`
          SELECT shobj_description(oid, 'pg_database') AS marker
          FROM pg_database WHERE datname = ${target.databaseName}
        `;
        if (owned?.marker !== `assistant-test-target:${target.token}`)
          throw new Error('Consolidation test database ownership mismatch');
        await admin.unsafe(`DROP DATABASE "${target.databaseName}" WITH (FORCE)`);
      });
    await attemptCleanup(() => admin.end({ timeout: 5 }));
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Consolidation test and cleanup failed',
    );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'Consolidation test cleanup failed');
  if (!result) throw new Error('Consolidation test produced no result');
  return result.value;
}

/**
 * Detects one duplicate pair and one contradiction pair; fixes one domain;
 * proposes one merge whose group also (incorrectly) includes a confirmed fact.
 */
const fakeRouter = {
  async embeddingSpace() {
    return { provider: 'test', model: 'consolidation', dimensions: 1536, revision: '1' };
  },
  async object() {
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        duplicateGroups: [[factIds.dupA, factIds.dupB]],
        contradictionGroups: [
          [factIds.oldJob, factIds.newJob],
          [factIds.eyeBrown, factIds.eyeBlue],
        ],
        mergeGroups: [
          {
            ids: [factIds.mergeA, factIds.mergeB, factIds.mergeConfirmed],
            unified: `${MARKER}: runs 5k on Tuesdays while training for a half marathon`,
          },
        ],
        domainFixes: [{ id: factIds.noDomain, domain: 'home' }],
        timeline: [{ id: factIds.newJob, validFrom: '2024-03-01', validUntil: '' }],
        occasions: [{ kind: 'birthday', label: '', month: 5, day: 20, year: null, notes: '' }],
      },
    };
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('consolidation.test: database unreachable — skipping');
    return;
  }
  const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
  ownerId = (owner as NonNullable<typeof owner>).id;

  await insertFact('dupA', {
    content: `${MARKER}: drinks his coffee black`,
    confidence: '0.60',
    createdAt: daysAgo(30),
    domain: 'preferences',
  });
  await insertFact('dupB', {
    content: `${MARKER}: takes coffee without milk or sugar`,
    confidence: '0.80',
    createdAt: daysAgo(2),
    domain: 'preferences',
  });
  // importance 5 keeps the survivor above the card's auto-include threshold
  // and inside the per-domain cap even when the database holds real work facts
  await insertFact('oldJob', {
    content: `${MARKER}: works at Oldcorp as an engineer`,
    validUntil: new Date('2024-02-29Z'),
    confidence: '0.90',
    createdAt: daysAgo(300),
    domain: 'work',
    importance: 5,
  });
  await insertFact('newJob', {
    content: `${MARKER}: works at Newcorp since March 2024`,
    confidence: '0.80',
    createdAt: daysAgo(3),
    domain: 'work',
    importance: 5,
  });
  await insertFact('eyeBrown', {
    content: `${MARKER}: eye colour is brown`,
    confidence: '0.60',
    createdAt: daysAgo(300),
    domain: 'other',
  });
  await insertFact('eyeBlue', {
    content: `${MARKER}: eye colour is blue`,
    confidence: '0.80',
    createdAt: daysAgo(3),
    domain: 'other',
  });
  await insertFact('noDomain', {
    content: `${MARKER}: lives in a flat in the Mission district`,
    confidence: '0.70',
    createdAt: daysAgo(10),
  });
  await insertFact('quarantinedFact', {
    content: `${MARKER}: secretly dislikes his neighbor`,
    confidence: '0.50',
    quarantined: true,
  });
  await insertFact('mergeA', {
    content: `${MARKER}: runs 5k on Tuesday mornings`,
    confidence: '0.80',
    domain: 'health',
  });
  await insertFact('mergeB', {
    content: `${MARKER}: is training for a half marathon`,
    confidence: '0.60',
    domain: 'health',
  });
  await insertFact('mergeConfirmed', {
    content: `${MARKER}: does yoga every Sunday`,
    confidence: '1.00',
    domain: 'health',
    ownerConfirmed: true,
  });
  await insertFact('standalone', {
    content: `${MARKER}: standalone note with no person attached`,
    confidence: '0.75',
    subjectContactId: null,
  });
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    await db.delete(occasions).where(eq(occasions.source, 'consolidation'));
    if (personId) await db.delete(contacts).where(eq(contacts.id, personId));
    await compileOwnerCard(db); // leave the card clean of test facts
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('pickWinner', () => {
  const base = {
    agentId: 'agent',
    content: '',
    kind: 'fact',
    importance: 3,
    domain: null,
    pinned: false,
    lastConsolidatedAt: null,
    validFrom: null,
    validUntil: null,
  };
  it('newer wins when confidence is close (confidence-weighted newer-wins)', () => {
    const older = {
      ...base,
      id: 'a',
      confidence: '0.85',
      ownerConfirmed: false,
      createdAt: daysAgo(300),
    };
    const newer = {
      ...base,
      id: 'b',
      confidence: '0.80',
      ownerConfirmed: false,
      createdAt: daysAgo(1),
    };
    expect(pickWinner([older, newer]).id).toBe('b');
  });
  it('clearly higher confidence beats recency', () => {
    const older = {
      ...base,
      id: 'a',
      confidence: '0.95',
      ownerConfirmed: false,
      createdAt: daysAgo(300),
    };
    const newer = {
      ...base,
      id: 'b',
      confidence: '0.40',
      ownerConfirmed: false,
      createdAt: daysAgo(1),
    };
    expect(pickWinner([older, newer]).id).toBe('a');
  });
  it('owner-confirmed always wins', () => {
    const confirmed = {
      ...base,
      id: 'a',
      confidence: '0.30',
      ownerConfirmed: true,
      createdAt: daysAgo(300),
    };
    const newer = {
      ...base,
      id: 'b',
      confidence: '0.99',
      ownerConfirmed: false,
      createdAt: daysAgo(1),
    };
    expect(pickWinner([confirmed, newer]).id).toBe('a');
  });
});

describe('memory consolidation (integration)', () => {
  it('expires duplicates and contradiction losers with supersededById, assigns domains, compiles card', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const result = await runMemoryConsolidation({ db, router: fakeRouter });
    expect(result.entities).toBeGreaterThanOrEqual(1);
    expect(result.batches).toBeGreaterThanOrEqual(1);
    expect(result.memoriesReviewed).toBeGreaterThanOrEqual(1);
    expect(result.standaloneReviewed).toBeGreaterThanOrEqual(1);
    expect(result.duplicatesExpired).toBeGreaterThanOrEqual(1);
    expect(result.contradictionsResolved).toBeGreaterThanOrEqual(1);
    expect(result.cardCompiled).toBe(true);

    // occasions mined from facts are upserted for the processed entity
    expect(result.occasionsSaved).toBeGreaterThanOrEqual(1);
    const ownerOccasions = await db
      .select()
      .from(occasions)
      .where(and(eq(occasions.contactId, ownerId), eq(occasions.source, 'consolidation')));
    expect(ownerOccasions.some((o) => o.month === 5 && o.day === 20)).toBe(true);

    // duplicate: higher-confidence newer dupB survives; dupA expired, superseded by dupB
    const [dupA] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.dupA as string));
    const [dupB] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.dupB as string));
    expect(dupA?.expiresAt).not.toBeNull();
    expect(dupA?.supersededById).toBe(factIds.dupB);
    expect(dupB?.expiresAt).toBeNull();

    // Dated old employment is history, not a current contradiction to retire.
    const [oldJob] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.oldJob as string));
    const [newJob] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.newJob as string));
    expect(oldJob?.expiresAt).toBeNull();
    expect(oldJob?.supersededById).toBeNull();
    const [eyeBrown] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.eyeBrown as string));
    expect(eyeBrown?.supersededById).toBe(factIds.eyeBlue);
    expect(newJob?.expiresAt).toBeNull();
    expect(newJob?.validFrom?.toISOString().slice(0, 10)).toBe('2024-03-01');

    // domain assignment
    const [noDomain] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.noDomain as string));
    expect(noDomain?.domain).toBe('home');

    // merge: unified fact created, members expired with provenance,
    // owner-confirmed member left untouched
    expect(result.factsUnified).toBe(2);
    const [unified] = await db
      .select()
      .from(memories)
      .where(
        sql`${memories.content} = ${`${MARKER}: runs 5k on Tuesdays while training for a half marathon`}`,
      );
    expect(unified).toBeDefined();
    expect(unified?.originTrust).toBe('assistant');
    expect(unified?.domain).toBe('health');
    expect(unified?.confidence).toBe('0.60'); // min of members
    expect(unified?.embedding).not.toBeNull();
    expect(unified?.expiresAt).toBeNull();
    const [mergeA] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.mergeA as string));
    const [mergeB] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.mergeB as string));
    const [mergeConfirmed] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.mergeConfirmed as string));
    expect(mergeA?.expiresAt).not.toBeNull();
    expect(mergeA?.supersededById).toBe(unified?.id);
    expect(mergeB?.expiresAt).not.toBeNull();
    expect(mergeB?.supersededById).toBe(unified?.id);
    expect(mergeConfirmed?.expiresAt).toBeNull();
    expect(mergeConfirmed?.supersededById).toBeNull();

    // owner card: contains survivors, excludes expired losers and quarantined facts
    const [card] = await db.select().from(ownerCard).where(eq(ownerCard.id, 1));
    expect(card?.content).toContain('Newcorp');
    expect(card?.content).not.toContain('Oldcorp');
    expect(card?.content).not.toContain('neighbor');

    // rotation cursor: every reviewed fact is stamped so the next run's window
    // prefers facts that haven't been looked at yet (nulls first)
    expect(dupB?.lastConsolidatedAt).not.toBeNull();
    expect(mergeConfirmed?.lastConsolidatedAt).not.toBeNull();
    const [quarantinedFact] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.quarantinedFact as string));
    expect(quarantinedFact?.lastConsolidatedAt).toBeNull();
    const [standalone] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.standalone as string));
    expect(standalone?.lastConsolidatedAt).not.toBeNull();
  });
});

describe('compileOwnerCard pinning (integration)', () => {
  it('the PostgreSQL compilation port preserves the compatibility wrapper output', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const legacy = await compileOwnerCard(db, now);
    const ported = await compileOwnerCard(
      createPostgresOwnerCardCompilationRepository(db),
      agentId,
      now,
    );
    expect(ported).toBe(legacy);
  });

  it('does not publish an owner-erased tombstoned fact', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `${MARKER}: erased private card fact`;
    await insertFact('cardTombstoned', {
      content,
      confidence: '0.99',
      domain: 'identity',
      importance: 5,
    });
    const contentHash = createHash('sha256').update(content).digest('hex');
    await db.insert(memoryTombstones).values({ contentHash, reason: 'owner_forget' });
    try {
      expect(await compileOwnerCard(db)).not.toContain('erased private card fact');
    } finally {
      await db.delete(memoryTombstones).where(eq(memoryTombstones.contentHash, contentHash));
    }
  });

  it('pinned facts always make the card; unpinned facts beyond the per-domain cap do not', async (ctx) => {
    if (!dbUp) return ctx.skip();

    // Auto-inclusion needs importance >= 4 and caps at 2 per domain; pinned
    // facts make the card no matter how unimportant or shaky they look.
    const health = [
      ['cardHigh1', 5, '0.90'], // in: high importance, top ranked
      ['cardHigh2', 4, '0.85'], // in: high importance, second
      ['cardHigh3', 4, '0.80'], // out: third high-importance fact, over the cap
      ['cardMid', 3, '0.99'], // out: ordinary importance never auto-surfaces
    ] as const;
    for (const [key, importance, confidence] of health) {
      await insertFact(key, {
        content: `${MARKER}: ${key} sleeps with the window open`,
        confidence,
        domain: 'health',
        importance,
      });
    }
    await insertFact('healthPinned', {
      content: `${MARKER}: healthPinned is allergic to penicillin`,
      confidence: '0.10',
      domain: 'health',
      importance: 1,
      pinned: true,
    });

    const content = await compileOwnerCard(db);
    expect(content).toContain('healthPinned is allergic to penicillin');
    expect(content).toContain('cardHigh1 sleeps with the window open');
    expect(content).toContain('cardHigh2 sleeps with the window open');
    expect(content).not.toContain('cardHigh3 sleeps with the window open');
    expect(content).not.toContain('cardMid sleeps with the window open');
    // overflow is surfaced to the model so it knows recall has more
    expect(content).toContain('memory.recall');
  });

  it('a fact that has stopped being true does not take an auto slot from a current one', async (ctx) => {
    if (!dbUp) return ctx.skip();

    // The defect this guards: auto-selection fills two slots per domain by
    // importance, so the most important fact won even when its own stated
    // validity said it had ended. A former address took the slot and then
    // answered "where do I live".
    await insertFact('cardEnded', {
      content: `${MARKER}: cardEnded lived on Elm Street`,
      confidence: '0.95',
      domain: 'home',
      importance: 5,
      validFrom: new Date('2019-01-01T00:00:00Z'),
      validUntil: new Date('2023-06-01T00:00:00Z'),
    });
    await insertFact('cardNow1', {
      content: `${MARKER}: cardNow1 lives on Oak Avenue`,
      confidence: '0.80',
      domain: 'home',
      importance: 4,
      validFrom: new Date('2023-07-01T00:00:00Z'),
    });
    await insertFact('cardNow2', {
      content: `${MARKER}: cardNow2 rents rather than owns`,
      confidence: '0.75',
      domain: 'home',
      importance: 4,
    });

    const content = await compileOwnerCard(db);

    expect(content).not.toContain('cardEnded lived on Elm Street');
    expect(content).toContain('cardNow1 lives on Oak Avenue');
    expect(content).toContain('cardNow2 rents rather than owns');
    // An ongoing fact reads as ongoing rather than as a bare date range.
    expect(content).toContain('cardNow1 lives on Oak Avenue (since 2023-07-01)');
  });

  it('a pinned fact that has lapsed still makes the card, labelled as past', async (ctx) => {
    if (!dbUp) return ctx.skip();

    // Pinning is the owner saying "always tell it this", so it is not for
    // auto-selection to overrule — but it must not read as current either.
    await insertFact('cardPinnedPast', {
      content: `${MARKER}: cardPinnedPast chaired the standards board`,
      confidence: '0.90',
      domain: 'home',
      importance: 1,
      pinned: true,
      validUntil: new Date('2022-01-01T00:00:00Z'),
    });

    const content = await compileOwnerCard(db);

    expect(content).toContain(
      'cardPinnedPast chaired the standards board (past: until 2022-01-01)',
    );
  });

  it('a pinned fact about a person is carried into the card under People', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const [person] = await db
      .insert(contacts)
      .values({ name: `${MARKER} Person`, relationship: 'sister', trust: 'known' })
      .returning({ id: contacts.id });
    personId = (person as NonNullable<typeof person>).id;

    // A pinned person fact must reach the card even though it is low importance
    // and person facts never auto-surface; an ordinary one must not.
    await insertFact('personPinned', {
      content: `${MARKER}: personPinned plays the cello`,
      confidence: '0.20',
      importance: 1,
      pinned: true,
      subjectContactId: personId,
    });
    await insertFact('personPlain', {
      content: `${MARKER}: personPlain once visited Japan`,
      confidence: '0.90',
      importance: 3,
      subjectContactId: personId,
    });

    const content = await compileOwnerCard(db);
    expect(content).toContain(`${MARKER} Person`);
    expect(content).toContain('personPinned plays the cello');
    expect(content).not.toContain('personPlain once visited Japan');
  });
  it.each([
    ['past', new Date('2019-01-01Z'), new Date('2023-01-01Z'), 'works at Acme'],
    ['future', new Date('2099-01-01Z'), null, 'works at Acme'],
    ['partially overlapping', new Date('2020-01-01Z'), new Date('2030-01-01Z'), 'works at Acme'],
    ['unknown uncertain', null, null, 'might work at Acme'],
  ])(
    'retains %s source facts and their graph re-extraction inputs',
    async (label, from, until, wording) => {
      if (!dbUp) throw new Error('Local PostgreSQL qualification database is required');
      const keys = [`scope-${label}-a`, `scope-${label}-b`];
      for (const key of keys)
        await insertFact(key, {
          content: `${MARKER}: ${key} ${wording}`,
          confidence: '0.70',
          importance: 5,
          domain: 'work',
          createdAt: new Date('2020-01-01Z'),
          ...(from ? { validFrom: from } : {}),
          ...(until ? { validUntil: until } : {}),
        });
      const unified = `${MARKER}: invented current employment ${label}`;
      const inputs: string[] = [];
      const router = {
        async embeddingSpace() {
          return { provider: 'test', model: 'consolidation', dimensions: 1536, revision: '1' };
        },
        async object(_role: string, input: { prompt: string }) {
          inputs.push(input.prompt);
          return {
            ok: true,
            object: {
              duplicateGroups: [],
              contradictionGroups: [],
              mergeGroups: [{ ids: keys.map((key) => factIds[key]), unified }],
              domainFixes: [],
              timeline: [],
              occasions: [],
            },
          };
        },
        async embed(texts: string[]) {
          return texts.map(() => new Array(1536).fill(0.01));
        },
      } as unknown as ModelRouter;
      await runMemoryConsolidation({ db, router }, { agentId });
      const rows = await db
        .select()
        .from(memories)
        .where(
          inArray(
            memories.id,
            keys.map((key) => factIds[key] as string),
          ),
        );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.expiresAt).toBeNull();
        expect(row.supersededById).toBeNull();
        expect(row.validFrom).toEqual(from);
        expect(row.validUntil).toEqual(until);
        expect(row.createdAt).toEqual(new Date('2020-01-01Z'));
      }
      expect(await db.select().from(memories).where(eq(memories.content, unified))).toHaveLength(0);
      expect(inputs.some((prompt) => prompt.includes('validFrom='))).toBe(true);
    },
  );

  it('does not publish a paused consolidation after its contributing import is deleted', async () => {
    if (!dbUp) throw new Error('Local PostgreSQL qualification database is required');
    await withIsolatedConsolidationDatabase(async (db, isolatedAgentId) => {
      const subject = `source-fence-${randomUUID()}`;
      const source = `source-fence-${randomUUID()}`;
      const sourceFactContent = `${MARKER}: ${subject} imported detail`;
      const ownerFactContent = `${MARKER}: ${subject} owner detail`;
      const unified = `${MARKER}: ${subject} combined detail`;
      const [contact] = await db
        .insert(contacts)
        .values({ name: subject })
        .returning({ id: contacts.id });
      if (!contact) throw new Error('Expected source-fence contact');
      const [sourceRow] = await db
        .insert(importSources)
        .values({
          agentId: isolatedAgentId,
          source,
          workspacePath: `import/${source}.txt`,
          kind: 'text',
          status: 'done',
        })
        .returning({ id: importSources.id });
      if (!sourceRow) throw new Error('Expected source-fence import source');
      const inserted = await db
        .insert(memories)
        .values([
          {
            agentId: isolatedAgentId,
            category: 'knowledge',
            kind: 'fact',
            content: sourceFactContent,
            contentHash: createHash('sha256').update(sourceFactContent).digest('hex'),
            confidence: '0.75',
            importance: 5,
            originTrust: 'owner',
            subjectContactId: contact.id,
            source,
          },
          {
            agentId: isolatedAgentId,
            category: 'knowledge',
            kind: 'fact',
            content: ownerFactContent,
            contentHash: createHash('sha256').update(ownerFactContent).digest('hex'),
            confidence: '0.75',
            importance: 5,
            originTrust: 'owner',
            subjectContactId: contact.id,
          },
        ])
        .returning({ id: memories.id });
      const [importedFact, ownerFact] = inserted;
      if (!importedFact || !ownerFact) throw new Error('Expected consolidation facts');
      await db.insert(memoryImportLineage).values({ source, memoryId: importedFact.id });

      let notifyModelStarted!: () => void;
      let resumeModel!: () => void;
      const modelStarted = new Promise<void>((resolve) => {
        notifyModelStarted = resolve;
      });
      const modelGate = new Promise<void>((resolve) => {
        resumeModel = resolve;
      });
      const router = {
        async embeddingSpace() {
          return { provider: 'test', model: 'consolidation', dimensions: 1536, revision: '1' };
        },
        async object(_role: string, input: { prompt: string }) {
          if (input.prompt.includes(sourceFactContent) && input.prompt.includes(ownerFactContent)) {
            notifyModelStarted();
            await modelGate;
            return {
              ok: true,
              object: {
                duplicateGroups: [],
                contradictionGroups: [],
                mergeGroups: [{ ids: [importedFact.id, ownerFact.id], unified }],
                domainFixes: [],
                timeline: [],
                occasions: [],
              },
            };
          }
          return {
            ok: true,
            object: {
              duplicateGroups: [],
              contradictionGroups: [],
              mergeGroups: [],
              domainFixes: [],
              timeline: [],
              occasions: [],
            },
          };
        },
        async embed(texts: string[]) {
          return texts.map(() => new Array(1536).fill(0.01));
        },
      } as unknown as ModelRouter;

      const consolidation = runMemoryConsolidation({ db, router }, { agentId: isolatedAgentId });
      await modelStarted;
      await deleteImportSource(db, source, { delete: async () => {} });
      resumeModel();
      await expect(consolidation).rejects.toThrow(
        'An imported source changed while consolidation was in flight',
      );
      expect(
        await db.select().from(memories).where(eq(memories.content, sourceFactContent)),
      ).toHaveLength(0);
      expect(
        await db.select().from(memories).where(eq(memories.content, ownerFactContent)),
      ).toHaveLength(1);
      expect(await db.select().from(memories).where(eq(memories.content, unified))).toHaveLength(0);
    });
  }, 30_000);
});
