import { randomUUID } from 'node:crypto';
import {
  agents,
  commitments,
  conversations,
  createDb,
  createPostgresMemoryToolRepository,
  maintenanceCursors,
  memories,
  messages,
} from '@assistant/db';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { extractCommitments } from './commitments.js';
import { runMemoryExtraction } from './extraction.js';
import { recallKnowledgeGraph } from './graph-recall.js';
import { syncKnowledgeGraph } from './knowledge-graph.js';

const databaseUrl = process.env.DATABASE_URL;
const safeTestDatabase = (() => {
  if (!databaseUrl) return false;
  try {
    const parsed = new URL(databaseUrl);
    return (
      ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
      parsed.pathname.endsWith('_test')
    );
  } catch {
    return false;
  }
})();
const SPACE = {
  provider: 'synthetic',
  model: 'ops16-fixture-test',
  dimensions: 1536,
  revision: '1',
} as const;
const VECTOR = Array.from({ length: SPACE.dimensions }, (_, index) => (index === 0 ? 1 : 0));
const ORDINARY_TEXT =
  'ORDINARY_SOURCE: OPS16 Owner works at OPS16 Northwind and will read before breakfast.';
const FIXTURE_TEXT = 'VISUAL_QA_SOURCE: The owner works at Fixture Lab.';
const READABILITY_TEXT = 'READABILITY_SOURCE: The owner works at Readability Studio.';
const ORDINARY_FACT = 'OPS16 Owner works at OPS16 Northwind and will read before breakfast.';
const FIXTURE_FACT = 'The owner works at Fixture Lab.';
const READABILITY_FACT = 'The owner works at Readability Studio.';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function pauseWorkerForCleanup<T>(
  started: Promise<T>,
  worker: Promise<unknown>,
  release: () => void,
  cleanup: () => Promise<unknown>,
  label: string,
): Promise<T> {
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let value: T | undefined;
  let primaryError: unknown;
  try {
    value = await Promise.race([
      started,
      worker.then(() => {
        throw new Error(`${label} completed without reaching the fake model`);
      }),
      new Promise<T>((_, reject) => {
        startTimer = setTimeout(
          () =>
            reject(new Error(`${label} did not reach the fake model before the barrier deadline`)),
          10_000,
        );
      }),
    ]);
    await cleanup();
  } catch (error) {
    primaryError = error;
  } finally {
    if (startTimer) clearTimeout(startTimer);
    release();
  }

  let workerError: unknown;
  try {
    await Promise.race([
      worker,
      new Promise<never>((_, reject) => {
        waitTimer = setTimeout(
          () => reject(new Error(`${label} did not settle after its barrier was released`)),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    workerError = error;
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
  }

  if (primaryError !== undefined && workerError !== undefined)
    throw new AggregateError(
      [primaryError, workerError],
      `${label} cleanup and worker both failed`,
    );
  if (primaryError !== undefined) throw primaryError;
  if (workerError !== undefined) throw workerError;
  if (value === undefined) throw new Error(`${label} barrier returned no prompt`);
  return value;
}

type Fixture = { agentId: string; conversationId: string; messageIds: string[]; nextAt: number };

/**
 * These are real integration tests against the allocated local PostgreSQL test
 * database. Never fall back to a developer or remote database.
 */
describe.skipIf(!safeTestDatabase)('visual QA extraction exclusion (PostgreSQL)', () => {
  let db: ReturnType<typeof createDb>;
  let fixture: Fixture | undefined;

  beforeAll(() => {
    db = createDb(databaseUrl as string);
  });

  afterAll(async () => {
    if (db) await db.$client.end({ timeout: 5 });
  });

  afterEach(async () => {
    if (fixture) {
      await db.delete(memories).where(eq(memories.agentId, fixture.agentId));
      await db.delete(commitments).where(eq(commitments.agentId, fixture.agentId));
      await db
        .delete(maintenanceCursors)
        .where(
          eq(
            maintenanceCursors.name,
            `prepared-memory-extraction:${fixture.agentId}:${fixture.conversationId}`,
          ),
        );
      await db.delete(messages).where(eq(messages.conversationId, fixture.conversationId));
      await db.delete(conversations).where(eq(conversations.id, fixture.conversationId));
      await db.delete(agents).where(eq(agents.id, fixture.agentId));
      fixture = undefined;
    }
  });

  async function ownerFixture(): Promise<Fixture> {
    const suffix = randomUUID();
    const [agent] = await db
      .insert(agents)
      .values({
        name: `OPS16 ${suffix}`,
        email: `${suffix}@example.invalid`,
        workspacePrefix: `ops16-${suffix}`,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('Could not create isolated owner fixture');
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId: agent.id, channel: 'chat', trust: 'owner', title: `OPS16 ${suffix}` })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('Could not create isolated conversation');
    fixture = {
      agentId: agent.id,
      conversationId: conversation.id,
      messageIds: [],
      nextAt: Date.now(),
    };
    return fixture;
  }

  async function addOwnerMessage(
    target: Fixture,
    text: string,
    channelMessageId: string | null,
  ): Promise<string> {
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: target.conversationId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text,
        channelMessageId,
        createdAt: new Date(target.nextAt),
      })
      .returning({ id: messages.id });
    target.nextAt += 1_000;
    if (!message) throw new Error('Could not seed owner source message');
    target.messageIds.push(message.id);
    return message.id;
  }

  function routerFor(onPrompt?: (prompt: string) => Promise<void>): {
    router: ModelRouter;
    prompts: string[];
  } {
    const prompts: string[] = [];
    const router = {
      async embeddingSpace() {
        return SPACE;
      },
      async embeddingSpaceKey() {
        return embeddingSpaceIdentityKey(SPACE);
      },
      async embed(texts: string[]) {
        return texts.map(() => VECTOR);
      },
      async object(_role: string, input: { prompt?: string }) {
        const prompt = input.prompt ?? '';
        prompts.push(prompt);
        await onPrompt?.(prompt);
        if (prompt.startsWith('Conversation (source trust:')) {
          const facts = [];
          if (prompt.includes(ORDINARY_TEXT))
            facts.push({
              content: ORDINARY_FACT,
              kind: 'preference',
              category: 'knowledge',
              subject: { type: 'owner' },
              relationship: '',
              domain: 'preferences',
              importance: 3,
              confidence: 0.95,
              validFrom: '',
            });
          if (prompt.includes(FIXTURE_TEXT))
            facts.push({
              content: FIXTURE_FACT,
              kind: 'fact',
              category: 'knowledge',
              subject: { type: 'owner' },
              relationship: '',
              domain: 'personal',
              importance: 3,
              confidence: 0.95,
              validFrom: '',
            });
          if (prompt.includes(READABILITY_TEXT))
            facts.push({
              content: READABILITY_FACT,
              kind: 'fact',
              category: 'knowledge',
              subject: { type: 'owner' },
              relationship: '',
              domain: 'personal',
              importance: 3,
              confidence: 0.95,
              validFrom: '',
            });
          return { ok: true, modelId: 'fake', degraded: false, object: { facts, occasions: [] } };
        }
        const hasFixture = prompt.includes(FIXTURE_TEXT) || prompt.includes(READABILITY_TEXT);
        const hasOrdinary = prompt.includes(ORDINARY_TEXT);
        const sourceMessageIds = [...prompt.matchAll(/\[message_id=([0-9a-f-]{36})\] owner:/g)]
          .map((match) => match[1])
          .filter((id): id is string => Boolean(id));
        return {
          ok: true,
          modelId: 'fake',
          degraded: false,
          object: {
            commitments:
              hasFixture || hasOrdinary
                ? [
                    {
                      kind: 'promise',
                      title: hasFixture ? 'Move to Iceland next week' : 'Read before breakfast',
                      details: '',
                      nextAction: '',
                      dueAt: '',
                      confidence: 0.95,
                      sourceMessageIds: hasFixture
                        ? [sourceMessageIds.at(-1)]
                        : [sourceMessageIds[0]],
                    },
                  ]
                : [],
            resolvedTitles: [],
          },
        };
      },
    };
    return { router: router as unknown as ModelRouter, prompts };
  }

  it('skips fixture-only conversations before either worker calls the model or stores owner data', async () => {
    const target = await ownerFixture();
    const tag = `visual-qa:${randomUUID()}`;
    await addOwnerMessage(target, FIXTURE_TEXT, `${tag}:one`);
    await addOwnerMessage(target, READABILITY_TEXT, `readability-${randomUUID()}-user`);
    const { router, prompts } = routerFor();
    const since = new Date(Date.now() - 60 * 60 * 1000);

    const memory = await runMemoryExtraction({ db, router }, { agentId: target.agentId, since });
    const commitmentsRun = await extractCommitments(
      { db, router },
      { agentId: target.agentId, since },
    );

    expect(prompts).toEqual([]);
    expect(memory).toMatchObject({ conversationsScanned: 0, saved: 0 });
    expect(commitmentsRun).toMatchObject({ conversationsScanned: 0, saved: 0 });
    expect(await db.select().from(memories).where(eq(memories.agentId, target.agentId))).toEqual(
      [],
    );
    expect(
      await db.select().from(commitments).where(eq(commitments.agentId, target.agentId)),
    ).toEqual([]);
  });

  it('skips readability-only owner transcripts before extraction or commitment storage', async () => {
    const target = await ownerFixture();
    const since = new Date(Date.now() - 60 * 60 * 1000);
    await addOwnerMessage(target, READABILITY_TEXT, `readability-run-${randomUUID()}-01-user`);
    const { router, prompts } = routerFor();

    const memory = await runMemoryExtraction({ db, router }, { agentId: target.agentId, since });
    const commitmentsRun = await extractCommitments(
      { db, router },
      { agentId: target.agentId, since },
    );

    expect(prompts).toEqual([]);
    expect(memory).toMatchObject({ conversationsScanned: 0, saved: 0 });
    expect(commitmentsRun).toMatchObject({ conversationsScanned: 0, saved: 0 });
    expect(await db.select().from(memories).where(eq(memories.agentId, target.agentId))).toEqual(
      [],
    );
    expect(
      await db.select().from(commitments).where(eq(commitments.agentId, target.agentId)),
    ).toEqual([]);
  });

  it('keeps ordinary extraction and recall while cleanup races both transcript snapshots', async () => {
    const target = await ownerFixture();
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const tag = `visual-qa:${randomUUID()}`;
    const ordinaryId = await addOwnerMessage(target, ORDINARY_TEXT, null);
    const memoryFixtureId = await addOwnerMessage(target, FIXTURE_TEXT, `${tag}:memory`);
    await addOwnerMessage(target, READABILITY_TEXT, `readability-${randomUUID()}-user`);
    const memoryStarted = deferred<string>();
    const releaseMemory = deferred();
    let memoryGateUsed = false;
    const memoryRouter = routerFor(async (prompt) => {
      if (!memoryGateUsed) {
        memoryGateUsed = true;
        memoryStarted.resolve(prompt);
        await releaseMemory.promise;
      }
    });
    const memoryRun = runMemoryExtraction(
      { db, router: memoryRouter.router },
      { agentId: target.agentId, since },
    );
    const memoryPrompt = await pauseWorkerForCleanup(
      memoryStarted.promise,
      memoryRun,
      () => releaseMemory.resolve(),
      () => db.delete(messages).where(eq(messages.id, memoryFixtureId)),
      'Memory extraction',
    );

    const extraction = await memoryRun;

    expect(memoryRouter.prompts).toHaveLength(1);
    expect(memoryPrompt).toContain(ORDINARY_TEXT);
    expect(memoryPrompt).not.toContain(FIXTURE_TEXT);
    expect(memoryPrompt).not.toContain(READABILITY_TEXT);
    expect(extraction.saved).toBe(1);
    const saved = await db.select().from(memories).where(eq(memories.agentId, target.agentId));
    expect(saved.map((row) => row.content)).toEqual([ORDINARY_FACT]);
    expect(saved[0]).toMatchObject({
      source: 'extraction',
      originTrust: 'owner',
      quarantined: false,
    });
    const recalled = await createPostgresMemoryToolRepository(db, SPACE).recall({
      agentId: target.agentId,
      embedding: VECTOR,
      embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
      query: 'OPS16 Northwind',
      limit: 5,
    });
    expect(recalled.memories.map((row) => row.content)).toContain(ORDINARY_FACT);
    expect(
      recalled.memories.some((row) => [FIXTURE_FACT, READABILITY_FACT].includes(row.content)),
    ).toBe(false);

    const graphPrompts: string[] = [];
    const graphRouter = {
      async object(_role: string, input: { prompt?: string }) {
        const prompt = input.prompt ?? '';
        graphPrompts.push(prompt);
        return {
          ok: true,
          modelId: 'fake-graph',
          degraded: false,
          object: {
            relationships: prompt.includes(ORDINARY_FACT)
              ? [
                  {
                    subject: { label: 'OPS16 Owner', kind: 'person' },
                    subjectSpan: 'OPS16 Owner',
                    predicate: 'works_at',
                    predicateSpan: 'works at',
                    object: { label: 'OPS16 Northwind', kind: 'organization' },
                    objectSpan: 'OPS16 Northwind',
                    evidenceQuote: ORDINARY_FACT,
                    assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
                    confidence: 0.95,
                  },
                ]
              : [],
          },
        };
      },
    } as unknown as ModelRouter;
    const graphSync = await syncKnowledgeGraph(
      { db, router: graphRouter },
      { agentId: target.agentId },
    );
    expect(graphSync).toMatchObject({ candidates: 1, processed: 1, relationships: 1 });
    expect(graphPrompts.some((prompt) => prompt.includes(ORDINARY_FACT))).toBe(true);
    expect(
      graphPrompts.some(
        (prompt) => prompt.includes(FIXTURE_FACT) || prompt.includes(READABILITY_FACT),
      ),
    ).toBe(false);
    const graphRecall = await recallKnowledgeGraph(db, {
      agentId: target.agentId,
      queryText: 'Where does OPS16 Owner work?',
      queryEmbedding: VECTOR,
    });
    expect(graphRecall.block).toContain('OPS16 Northwind');
    expect(graphRecall.sources.some((source) => source.kind === 'knowledge_graph')).toBe(true);
    expect(graphRecall.block).not.toContain('Fixture Lab');
    expect(graphRecall.block).not.toContain('Readability Studio');

    const commitmentFixtureId = await addOwnerMessage(target, FIXTURE_TEXT, `${tag}:commitment`);
    const readabilityCommitmentFixtureId = await addOwnerMessage(
      target,
      READABILITY_TEXT,
      `readability-${randomUUID()}-user`,
    );
    const commitmentStarted = deferred<string>();
    const releaseCommitment = deferred();
    let commitmentGateUsed = false;
    const commitmentRouter = routerFor(async (prompt) => {
      if (!commitmentGateUsed) {
        commitmentGateUsed = true;
        commitmentStarted.resolve(prompt);
        await releaseCommitment.promise;
      }
    });
    const commitmentRun = extractCommitments(
      { db, router: commitmentRouter.router },
      { agentId: target.agentId, since },
    );
    const commitmentPrompt = await pauseWorkerForCleanup(
      commitmentStarted.promise,
      commitmentRun,
      () => releaseCommitment.resolve(),
      () => db.delete(messages).where(eq(messages.id, commitmentFixtureId)),
      'Commitment extraction',
    );

    const commitmentsResult = await commitmentRun;

    expect(commitmentRouter.prompts).toHaveLength(1);
    expect(commitmentPrompt).toContain(ORDINARY_TEXT);
    expect(commitmentPrompt).not.toContain(FIXTURE_TEXT);
    expect(commitmentPrompt).not.toContain(READABILITY_TEXT);
    expect(commitmentsResult.saved).toBe(1);
    const stored = await db
      .select()
      .from(commitments)
      .where(eq(commitments.agentId, target.agentId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      title: 'Read before breakfast',
      sourceMessageId: ordinaryId,
      status: 'open',
    });
    expect(stored.some((row) => row.title === 'Move to Iceland next week')).toBe(false);
    expect(stored[0]?.sourceOccurrenceKey).toContain(ordinaryId);
    expect(stored[0]?.sourceOccurrenceKey).not.toContain(commitmentFixtureId);
    expect(stored[0]?.sourceOccurrenceKey).not.toContain(readabilityCommitmentFixtureId);
  });
});
