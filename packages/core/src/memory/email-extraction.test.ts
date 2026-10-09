import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  agents,
  conversations,
  createDb,
  type Db,
  emailIngest,
  memories,
  memoryTombstones,
  messages,
} from '@assistant/db';
import { allocateTestTarget, assertAllocatedTestTarget } from '@assistant/db/test-target';
import type { EmailExtractionRepository } from '@assistant/persistence';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { ingestFactQuarantined, runEmailIngestExtraction } from './email-extraction.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-email-extract-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const ingestIds: string[] = [];
const tombstoneHashes: string[] = [];
async function withIsolatedEmailDatabase<T>(
  run: (input: { db: Db; agentId: string; conversationId: string }) => Promise<T>,
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
  let db: Db | undefined;
  let result: { value: T } | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
    created = true;
    await admin.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    db = createDb(target.databaseUrl, { max: 1 });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/', import.meta.url)),
    });
    const ownerId = randomUUID();
    const [owner] = await db
      .insert(agents)
      .values({
        id: ownerId,
        name: 'Synthetic email extraction owner',
        email: `${ownerId}@example.test`,
        workspacePrefix: `workspace/${ownerId}`,
      })
      .returning({ id: agents.id });
    if (!owner) throw new Error('Failed to create isolated email extraction owner');
    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId: owner.id,
        channel: 'email',
        trust: 'unknown',
        title: 'Isolated email test',
      })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('Failed to create isolated email test conversation');
    result = { value: await run({ db, agentId: owner.id, conversationId: conversation.id }) };
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
    if (db) await attemptCleanup(() => db!.$client.end({ timeout: 5 }));
    if (created)
      await attemptCleanup(async () => {
        const [owned] = await admin<{ marker: string | null }[]>`
          SELECT shobj_description(oid, 'pg_database') AS marker
          FROM pg_database WHERE datname = ${target.databaseName}
        `;
        if (owned?.marker !== `assistant-test-target:${target.token}`)
          throw new Error('Email extraction test database ownership mismatch');
        await admin.unsafe(`DROP DATABASE "${target.databaseName}" WITH (FORCE)`);
      });
    await attemptCleanup(() => admin.end({ timeout: 5 }));
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Email extraction test and cleanup failed',
    );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'Email extraction test cleanup failed');
  if (!result) throw new Error('Email extraction test produced no result');
  return result.value;
}

const EMAIL_SPACE = {
  provider: 'test',
  model: 'email-extraction',
  dimensions: 1536,
  revision: '1',
} as const;

/** Scripted router: one owner-logistics fact per email, constant embeddings. */
function scriptedRouter(fact: Record<string, unknown>, space = EMAIL_SPACE): ModelRouter {
  return {
    async embeddingSpace() {
      return space;
    },
    async object() {
      return {
        ok: true,
        modelId: 'fake',
        degraded: false,
        object: { facts: [fact], occasions: [] },
      };
    },
    async embed(values: string[]) {
      return values.map(() => Array.from({ length: 1536 }, () => 0.01));
    },
  } as unknown as ModelRouter;
}

async function ingestRow(
  input: { category: string; importance: number; body: string; id: string },
  scope: { db: Db; agentId: string; conversationId: string } = { db, agentId, conversationId },
) {
  const channelMessageId = `gmail:${MARKER}-${input.id}`;
  await scope.db.insert(messages).values({
    conversationId: scope.conversationId,
    role: 'user',
    origin: 'unknown',
    parts: [{ type: 'text', text: input.body }],
    text: input.body,
    channelMessageId,
  });
  const [row] = await scope.db
    .insert(emailIngest)
    .values({
      agentId: scope.agentId,
      conversationId: scope.conversationId,
      channelMessageId,
      fromEmail: 'bookings@airline.example',
      subject: `${MARKER} itinerary`,
      contentTrust: 'unknown',
      authenticated: true,
      category: input.category,
      importance: input.importance,
      actionable: true,
      reason: 'test',
    })
    .returning({ id: emailIngest.id });
  if (row && scope.db === db) ingestIds.push(row.id);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-extraction.test: database unreachable — skipping');
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust: 'unknown', title: `${MARKER} thread` })
    .returning();
  conversationId = (conv as NonNullable<typeof conv>).id;
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(like(memories.content, `%${MARKER}%`));
    if (ingestIds.length) await db.delete(emailIngest).where(inArray(emailIngest.id, ingestIds));
    if (tombstoneHashes.length)
      await db
        .delete(memoryTombstones)
        .where(inArray(memoryTombstones.contentHash, tombstoneHashes));
    if (conversationId) {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('ingestFactQuarantined', () => {
  // The split is about what a false entry costs. A wrong flight time is
  // self-correcting; a wrong claim about a person is unfalsifiable and lingers.
  it('lets owner logistics through', () => {
    for (const category of ['travel', 'appointment', 'financial', 'commitment', 'security']) {
      expect(ingestFactQuarantined({ category, subject: 'owner', kind: 'fact' })).toBe(false);
    }
  });

  it('holds anything about another person', () => {
    expect(ingestFactQuarantined({ category: 'travel', subject: 'Anna', kind: 'fact' })).toBe(true);
    expect(ingestFactQuarantined({ category: 'travel', subject: 'owner', kind: 'person' })).toBe(
      true,
    );
  });

  it('holds asserted preferences — a marketer would love to write those', () => {
    expect(
      ingestFactQuarantined({ category: 'travel', subject: 'owner', kind: 'preference' }),
    ).toBe(true);
  });

  it('holds non-logistics categories', () => {
    for (const category of ['personal', 'bulk', 'other']) {
      expect(ingestFactQuarantined({ category, subject: 'owner', kind: 'fact' })).toBe(true);
    }
  });
});

describe('runEmailIngestExtraction', () => {
  it('refuses to write vectors under a storage identity different from the active router space', async () => {
    const embed = vi.fn(async () => [new Array(1536).fill(0.01)]);
    const row = {
      id: 'email-storage-space-mismatch',
      agentId: 'owner',
      channelMessageId: 'gmail:space-mismatch',
      fromEmail: 'sender@example.test',
      subject: 'itinerary',
      category: 'travel',
      importance: 4,
      preparedExtraction: null,
    };
    const store = {
      kind: 'email-extraction-repository' as const,
      storageEmbeddingSpaceKey: 'b'.repeat(64),
      async pending() {
        return [row];
      },
      async messageText() {
        return 'A sufficiently long confirmed travel detail for the identity guard test.';
      },
      async savePrepared() {},
      async screenFactHashes() {
        return {};
      },
      async refreshFactEmbedding() {
        return false;
      },
      async stamp() {},
      async saveFact() {
        return 'saved' as const;
      },
      async saveOccasion() {
        return null;
      },
      async pendingCount() {
        return 0;
      },
    } satisfies EmailExtractionRepository;
    const router = {
      async embeddingSpace() {
        return EMAIL_SPACE;
      },
      async object() {
        return {
          ok: true as const,
          modelId: 'fake',
          degraded: false,
          object: {
            facts: [
              {
                content: 'The owner has a confirmed itinerary to Oslo.',
                kind: 'fact',
                category: 'knowledge',
                subject: 'owner',
                relationship: '',
                domain: 'other',
                importance: 4,
                confidence: 0.9,
                validFrom: '',
              },
            ],
            occasions: [],
          },
        };
      },
      embed,
    } as unknown as ModelRouter;

    await expect(runEmailIngestExtraction({ db: {} as Db, router, store })).rejects.toThrow(
      'Email memory storage space differs from the active router space',
    );
    expect(embed).not.toHaveBeenCalled();
  });

  it('makes owner logistics recallable and stamps the row', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await withIsolatedEmailDatabase(async (scope) => {
      const content = `The owner flies to Oslo on 1 September 2026 at 08:00 (${MARKER})`;
      const row = await ingestRow(
        {
          category: 'travel',
          importance: 4,
          body: 'You depart 1 September at 08:00 from gate B12.',
          id: 'flight',
        },
        scope,
      );

      const result = await runEmailIngestExtraction({
        db: scope.db,
        router: scriptedRouter({
          content,
          kind: 'fact',
          category: 'knowledge',
          subject: 'owner',
          relationship: '',
          domain: 'other',
          importance: 4,
          confidence: 0.9,
          validFrom: '',
        }),
      });
      expect(result.usable).toBeGreaterThanOrEqual(1);

      const [saved] = await scope.db.select().from(memories).where(eq(memories.content, content));
      expect(saved).toBeDefined();
      // The whole point: visible to memory.recall, which filters quarantined.
      expect(saved?.quarantined).toBe(false);
      expect(saved?.source).toBe('email-ingest');
      expect(saved?.embeddingSpaceKey).toBe(embeddingSpaceIdentityKey(EMAIL_SPACE));
      // Third-party mail is never a first-hand source, so confidence is capped.
      expect(Number(saved?.confidence)).toBeLessThanOrEqual(0.8);

      const [stamped] = await scope.db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, row?.id ?? ''));
      expect(stamped?.extractedAt).not.toBeNull();
    });
  });

  it('quarantines a claim about a third party from the same mailbox', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await withIsolatedEmailDatabase(async (scope) => {
      const content = `Anna Testsdottir is moving to Bergen in September (${MARKER})`;
      await ingestRow(
        {
          category: 'personal',
          importance: 4,
          body: 'Just so you know, Anna is moving to Bergen in September.',
          id: 'gossip',
        },
        scope,
      );

      await runEmailIngestExtraction({
        db: scope.db,
        router: scriptedRouter({
          content,
          kind: 'fact',
          category: 'knowledge',
          subject: 'Anna Testsdottir',
          relationship: 'friend',
          domain: 'relationships',
          importance: 3,
          confidence: 0.9,
          validFrom: '',
        }),
      });

      const [saved] = await scope.db.select().from(memories).where(eq(memories.content, content));
      expect(saved?.quarantined).toBe(true);
    });
  });

  it('screens exact duplicates before paying for embeddings', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await withIsolatedEmailDatabase(async (scope) => {
      const content = `The owner flies to Oslo on 1 September 2026 at 08:00 (${MARKER})`;
      const contentHash = (await import('node:crypto'))
        .createHash('sha256')
        .update(content)
        .digest('hex');
      // Seed the exact already-known owner fact in this fixture's database. The
      // integration assertion should not depend on an earlier test's rows.
      await scope.db.insert(memories).values({
        agentId: scope.agentId,
        category: 'knowledge',
        kind: 'fact',
        content,
        contentHash,
        embeddingSpaceKey: embeddingSpaceIdentityKey(EMAIL_SPACE),
      });
      await ingestRow(
        {
          category: 'travel',
          importance: 4,
          body: 'Another copy of the itinerary states the departure date and flight time.',
          id: 'duplicate-itinerary',
        },
        scope,
      );
      const embed = vi.fn(async (values: string[]) =>
        values.map(() => Array.from({ length: 1536 }, () => 0.01)),
      );
      const router = {
        async embeddingSpace() {
          return EMAIL_SPACE;
        },
        async object() {
          return {
            ok: true,
            modelId: 'fake',
            degraded: false,
            object: {
              facts: [
                {
                  content,
                  kind: 'fact',
                  category: 'knowledge',
                  subject: 'owner',
                  relationship: '',
                  domain: 'other',
                  importance: 4,
                  confidence: 0.9,
                  validFrom: '',
                },
              ],
              occasions: [],
            },
          };
        },
        embed,
      } as unknown as ModelRouter;
      const result = await runEmailIngestExtraction({ db: scope.db, router });
      expect(result.duplicates).toBeGreaterThanOrEqual(1);
      expect(embed).not.toHaveBeenCalled();
    });
  });

  it('screens owner-forgotten hashes before paying for embeddings', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await withIsolatedEmailDatabase(async (scope) => {
      const content = `Forgotten travel detail (${MARKER})`;
      const contentHash = (await import('node:crypto'))
        .createHash('sha256')
        .update(content)
        .digest('hex');
      await scope.db.insert(memoryTombstones).values({ contentHash, reason: 'owner_forget' });
      await ingestRow(
        {
          category: 'travel',
          importance: 4,
          body: 'The travel detail is an important record that could be remembered later.',
          id: 'forgotten-travel-detail',
        },
        scope,
      );
      const embed = vi.fn(async (values: string[]) =>
        values.map(() => Array.from({ length: 1536 }, () => 0.01)),
      );
      const router = {
        async embeddingSpace() {
          return EMAIL_SPACE;
        },
        async object() {
          return {
            ok: true,
            modelId: 'fake',
            degraded: false,
            object: {
              facts: [
                {
                  content,
                  kind: 'fact',
                  category: 'knowledge',
                  subject: 'owner',
                  relationship: '',
                  domain: 'other',
                  importance: 4,
                  confidence: 0.9,
                  validFrom: '',
                },
              ],
              occasions: [],
            },
          };
        },
        embed,
      } as unknown as ModelRouter;
      const result = await runEmailIngestExtraction({ db: scope.db, router });
      expect(result.tombstoned).toBeGreaterThanOrEqual(1);
      expect(embed).not.toHaveBeenCalled();
    });
  });

  it('reuses prepared email output after a failed memory write without repeating provider calls', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await withIsolatedEmailDatabase(async (scope) => {
      const content = `Prepared email first fact survives interruption (${MARKER})`;
      const secondContent = `Prepared email second fact survives interruption (${MARKER})`;
      const row = await ingestRow(
        {
          category: 'travel',
          importance: 4,
          body: 'The itinerary includes a confirmed departure date and a named flight time.',
          id: 'prepared-retry',
        },
        scope,
      );
      const sequence = `email_prepared_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
      const functionName = `${sequence}_fn`;
      const trigger = `${sequence}_trigger`;
      await scope.db.execute(sql.raw(`CREATE SEQUENCE "${sequence}" START 1`));
      await scope.db.execute(
        sql.raw(
          `CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content LIKE '%second fact%' AND nextval('"${sequence}"') <= 2 THEN RAISE EXCEPTION 'simulated email extraction write interruption'; END IF; RETURN NEW; END $$`,
        ),
      );
      await scope.db.execute(
        sql.raw(
          `CREATE TRIGGER "${trigger}" BEFORE INSERT ON memories FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
        ),
      );
      let modelCalls = 0;
      let embeddingCalls = 0;
      let activeEmbeddingModel = 'email-prepared-c';
      const router = {
        async embeddingSpace() {
          return {
            provider: 'test',
            model: activeEmbeddingModel,
            dimensions: 1536,
            revision: '1',
          };
        },
        async object() {
          modelCalls += 1;
          return {
            ok: true,
            modelId: 'fixture',
            degraded: false,
            object: {
              facts: [content, secondContent].map((factContent) => ({
                content: factContent,
                kind: 'fact' as const,
                category: 'knowledge' as const,
                subject: 'owner',
                relationship: '',
                domain: 'other' as const,
                importance: 4,
                confidence: 0.9,
                validFrom: '',
              })),
              occasions: [],
            },
          };
        },
        async embed(values: string[]) {
          embeddingCalls += 1;
          return values.map(() => Array.from({ length: 1536 }, () => embeddingCalls * 0.03));
        },
      } as unknown as ModelRouter;

      try {
        await expect(runEmailIngestExtraction({ db: scope.db, router })).rejects.toThrow();
        const [afterFailure] = await scope.db
          .select()
          .from(emailIngest)
          .where(eq(emailIngest.id, row?.id ?? ''));
        expect(afterFailure?.extractedAt).toBeNull();
        expect(afterFailure?.preparedExtraction).toMatchObject({
          extractionVersion: 'email-extraction-v2',
          embeddingSpaceKey: embeddingSpaceIdentityKey({
            provider: 'test',
            model: 'email-prepared-c',
            dimensions: 1536,
            revision: '1',
          }),
        });
        expect(modelCalls).toBe(1);
        expect(embeddingCalls).toBe(1);

        await expect(runEmailIngestExtraction({ db: scope.db, router })).rejects.toThrow();
        expect(modelCalls).toBe(1);
        expect(embeddingCalls).toBe(1);

        await scope.db.execute(sql.raw(`DROP TRIGGER "${trigger}" ON memories`));
        activeEmbeddingModel = 'email-prepared-d';
        await expect(runEmailIngestExtraction({ db: scope.db, router })).rejects.toThrow(
          'Prepared email embeddings belong to a different space; review before retry',
        );
        expect(modelCalls).toBe(1);
        expect(embeddingCalls).toBe(1);
        const [firstPersisted] = await scope.db
          .select()
          .from(memories)
          .where(eq(memories.content, content));
        const [secondPersisted] = await scope.db
          .select()
          .from(memories)
          .where(eq(memories.content, secondContent));
        expect(firstPersisted?.embeddingSpaceKey).toBe(
          embeddingSpaceIdentityKey({
            provider: 'test',
            model: 'email-prepared-c',
            dimensions: 1536,
            revision: '1',
          }),
        );
        expect(secondPersisted).toBeUndefined();
        const [afterRetry] = await scope.db
          .select()
          .from(emailIngest)
          .where(eq(emailIngest.id, row?.id ?? ''));
        expect(afterRetry?.extractedAt).toBeNull();
        expect(afterRetry?.preparedExtraction).toMatchObject({
          embeddingSpaceKey: embeddingSpaceIdentityKey({
            provider: 'test',
            model: 'email-prepared-c',
            dimensions: 1536,
            revision: '1',
          }),
        });
      } finally {
        if (row?.id) await scope.db.delete(emailIngest).where(eq(emailIngest.id, row.id));
        await scope.db.execute(sql.raw(`DROP TRIGGER IF EXISTS "${trigger}" ON memories`));
        await scope.db.execute(sql.raw(`DROP FUNCTION IF EXISTS "${functionName}"()`));
        await scope.db.execute(sql.raw(`DROP SEQUENCE IF EXISTS "${sequence}"`));
      }
    });
  });

  it('spends no extraction call on routine mail but still drains the ledger', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await withIsolatedEmailDatabase(async (scope) => {
      const row = await ingestRow(
        {
          category: 'bulk',
          importance: 1,
          body: 'Our summer sale is here, with lots of things in it for you to buy today.',
          id: 'newsletter',
        },
        scope,
      );
      let called = false;
      const router = {
        async embeddingSpace() {
          return EMAIL_SPACE;
        },
        async object() {
          called = true;
          return {
            ok: true,
            modelId: 'fake',
            degraded: false,
            object: { facts: [], occasions: [] },
          };
        },
        async embed(values: string[]) {
          return values.map(() => Array.from({ length: 1536 }, () => 0.01));
        },
      } as unknown as ModelRouter;

      const result = await runEmailIngestExtraction({ db: scope.db, router });
      expect(called).toBe(false);
      expect(result.skippedLowImportance).toBeGreaterThanOrEqual(1);
      // Stamped anyway, so the backlog drains instead of being re-read nightly.
      const [stamped] = await scope.db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, row?.id ?? ''));
      expect(stamped?.extractedAt).not.toBeNull();
    });
  });

  it('visits each queued message once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await withIsolatedEmailDatabase(async (scope) => {
      const row = await ingestRow(
        {
          category: 'travel',
          importance: 4,
          body: 'The owner has a confirmed departure date and flight time.',
          id: 'single-visit',
        },
        scope,
      );
      const router = scriptedRouter({
        content: `The owner has a confirmed departure date and flight time (${MARKER})`,
        kind: 'fact',
        category: 'knowledge',
        subject: 'owner',
        relationship: '',
        domain: 'other',
        importance: 4,
        confidence: 0.8,
        validFrom: '',
      });
      const first = await runEmailIngestExtraction({ db: scope.db, router });
      const second = await runEmailIngestExtraction({ db: scope.db, router });
      expect(first.rowsVisited).toBe(1);
      expect(first.extracted).toBe(1);
      expect(second.rowsVisited).toBe(0);
      expect(second.extracted).toBe(0);
      const [stamped] = await scope.db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, row?.id ?? ''));
      expect(stamped?.extractedAt).not.toBeNull();
    });
  });
});
