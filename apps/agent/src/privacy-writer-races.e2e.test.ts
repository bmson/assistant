import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureOwnerWritingSample, type ModelRouter } from '@assistant/core';
import { runMemoryExtraction } from '@assistant/core/memory/extraction';
import {
  agents,
  contacts,
  conversations,
  createDb,
  createPostgresMemoryToolRepository,
  createPostgresOwnerCardCompilationRepository,
  createPostgresPrivacyErasureRepository,
  type Db,
  maintenanceCursors,
  memories,
  messages,
  ownerCard,
  tasks,
  writingSamples,
} from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import {
  type ExecutionPersistence,
  embeddingSpaceIdentityKey,
  type MemoryToolRepository,
  type VoiceContextRepository,
} from '@assistant/persistence';
import { registerPortableMemoryTools, type ToolContext, ToolRegistry } from '@assistant/tools';
import { eq, like, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it } from 'vitest';
import {
  allocateTestTarget,
  assertAllocatedTestTarget,
} from '../../../packages/db/src/test-target.js';
import { FirestorePrivacyErasureRepository } from '../../../packages/firestore/src/privacy-erasure.js';
import { encodeRecord } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = { provider: 'synthetic', model: 'privacy-race', dimensions: 1536, revision: 'v1' };
const VECTOR = [1, ...new Array(1535).fill(0)];
const SAMPLE =
  'I prefer to plan quiet weekend walks with a notebook and a thermos of tea before meeting my friends.';

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Writer did not reach source-work barrier')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async pause() {
      entered();
      await resumed;
    },
  };
}

function routerAtEmbedding(gate: ReturnType<typeof barrier>, fact: string): ModelRouter {
  return {
    async embeddingSpace() {
      return SPACE;
    },
    async embeddingSpaceKey() {
      return embeddingSpaceIdentityKey(SPACE);
    },
    async object() {
      return {
        ok: true,
        modelId: 'synthetic',
        degraded: false,
        object: {
          facts: [
            {
              content: fact,
              kind: 'preference',
              category: 'knowledge',
              subject: { type: 'owner' },
              relationship: '',
              domain: 'preferences',
              importance: 3,
              confidence: 0.9,
              validFrom: '',
            },
          ],
          occasions: [],
        },
      };
    },
    async embed(texts: string[]) {
      await gate.pause();
      return texts.map(() => VECTOR);
    },
  } as unknown as ModelRouter;
}

async function memorySaveAtEmbedding(
  memory: MemoryToolRepository,
  router: ModelRouter,
  input: { agentId: string; taskId: string; db: Db; fact: string },
) {
  const registry = registerPortableMemoryTools(new ToolRegistry(), {
    memory,
    embed: (texts) => router.embed(texts, { expectedSpace: SPACE }),
    embedWithIdentity: async (texts) => ({
      embeddings: await router.embed(texts, { expectedSpace: SPACE }),
      embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
    }),
  });
  const tool = registry.get('memory.save')?.tool;
  if (!tool) throw new Error('Missing real memory.save tool');
  return tool.execute(
    tool.inputSchema.parse({
      content: input.fact,
      category: 'knowledge',
      kind: 'preference',
      subject: `Privacy race ${input.taskId}`,
    }),
    {
      agentId: input.agentId,
      taskId: input.taskId,
      db: input.db,
      trust: 'owner',
      tainted: false,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    } as ToolContext,
  );
}

type WriterKind = 'extraction' | 'voice' | 'memory_save';

type WriterRunInput = {
  kind: WriterKind;
  db: Db;
  agentId: string;
  taskId: string;
  fact: string;
  router: ModelRouter;
  memory: MemoryToolRepository;
  voice: Db | VoiceContextRepository;
  persistence?: ExecutionPersistence;
  lease?: () => { taskId: string; leaseToken: string };
};

async function runWriter(input: WriterRunInput) {
  if (input.kind === 'extraction') {
    return runMemoryExtraction(
      {
        db: input.db,
        router: input.router,
        ...(input.persistence ? { persistence: input.persistence } : {}),
      },
      {
        taskId: input.taskId,
        agentId: input.agentId,
        ...(input.lease ? { lease: input.lease } : {}),
      },
    );
  }
  if (input.kind === 'voice') {
    return captureOwnerWritingSample(input.voice, input.router, {
      text: `${SAMPLE} ${randomUUID()}`,
      register: 'chat',
    });
  }
  return memorySaveAtEmbedding(input.memory, input.router, {
    agentId: input.agentId,
    taskId: input.taskId,
    db: input.db,
    fact: input.fact,
  });
}

function savedCount(outcome: unknown): number {
  if (
    typeof outcome !== 'object' ||
    outcome === null ||
    !('saved' in outcome) ||
    typeof outcome.saved !== 'number'
  )
    throw new Error('Expected extraction result with a numeric saved count');
  return outcome.saved;
}

// Each PostgreSQL race owns a separate allocator database. Erasure commits on
// another client before the paused writer resumes; no outer rollback masks it.
async function postgresFixture(run: (db: Db, eraser: Db) => Promise<void>) {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const target = allocateTestTarget(process.env.DATABASE_URL);
  const adminUrl = new URL(target.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.toString());
  let created = false;
  let db: ReturnType<typeof createDb> | undefined;
  let eraser: ReturnType<typeof createDb> | undefined;
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${target.databaseName}"`);
    created = true;
    await admin.$client.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    db = createDb(target.databaseUrl);
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../../packages/db/drizzle/', import.meta.url)),
    });
    eraser = createDb(target.databaseUrl);
    await db.insert(agents).values({
      id: randomUUID(),
      name: 'Synthetic owner',
      email: `${randomUUID()}@example.test`,
      workspacePrefix: 'synthetic-privacy-race',
    });
    await run(db, eraser);
  } finally {
    await eraser?.$client.end();
    await db?.$client.end();
    if (created) {
      await dropOwnedFixture(admin, target);
    }
    await admin.$client.end();
  }
}

async function dropOwnedFixture(
  admin: ReturnType<typeof createDb>,
  target: ReturnType<typeof allocateTestTarget>,
) {
  const [owned] =
    await admin.$client`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=${target.databaseName}`;
  if (owned?.marker !== `assistant-test-target:${target.token}`)
    throw new Error('Privacy fixture cleanup ownership mismatch');
  await admin.$client.unsafe(`DROP DATABASE "${target.databaseName}"`);
}

describe('PostgreSQL asynchronous writers versus committed owner erasure', () => {
  it.each(['extraction', 'voice', 'memory_save'] as const)(
    'rejects stale %s output after erasure commits',
    async (kind) => {
      await postgresFixture(async (db, eraser) => {
        const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
        if (!owner) throw new Error('Missing owner');
        const conversationId = randomUUID();
        const fact = `The owner prefers quiet walks (${randomUUID()}).`;
        await db
          .insert(conversations)
          .values({ id: conversationId, agentId: owner.id, trust: 'owner', channel: 'chat' });
        await db
          .insert(messages)
          .values({ conversationId, role: 'user', origin: 'owner', text: fact });
        await db
          .insert(writingSamples)
          .values({ text: SAMPLE, register: 'email_casual', context: 'fixture' });
        const taskId = randomUUID();
        await db.insert(tasks).values({
          id: taskId,
          agentId: owner.id,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
        });
        const gate = barrier();
        const router = routerAtEmbedding(gate, fact);
        const pending =
          kind === 'extraction'
            ? runMemoryExtraction({ db, router }, { agentId: owner.id }).then(
                (value) => ({ value, error: null }),
                (error: unknown) => ({ value: null, error }),
              )
            : kind === 'memory_save'
              ? memorySaveAtEmbedding(createPostgresMemoryToolRepository(db, SPACE), router, {
                  agentId: owner.id,
                  taskId,
                  db,
                  fact,
                }).then(
                  (value) => ({ value, error: null }),
                  (error: unknown) => ({ value: null, error }),
                )
              : captureOwnerWritingSample(db, router, {
                  text: `${SAMPLE} ${randomUUID()}`,
                  register: 'chat',
                }).then(
                  (value) => ({ value, error: null }),
                  (error: unknown) => ({ value: null, error }),
                );
        try {
          await Promise.race([
            gate.wait(),
            pending.then((outcome) => {
              throw outcome.error ?? new Error('Writer completed before embedding');
            }),
          ]);
          const erasure = createPostgresPrivacyErasureRepository(eraser);
          await erasure.erase();
          expect(await erasure.pendingAssets()).toEqual([]);
          await erasure.complete();
          // These reads use the writer's independent connection and see the
          // completed erasure before provider work is allowed to return.
          expect(await db.select().from(writingSamples)).toEqual([]);
          expect(
            await db
              .select()
              .from(maintenanceCursors)
              .where(eq(maintenanceCursors.name, `privacy-erasure-result:${owner.id}`)),
          ).toEqual([]);
          expect(
            await db
              .select()
              .from(maintenanceCursors)
              .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${owner.id}`)),
          ).toHaveLength(1);
        } finally {
          gate.release();
        }
        const outcome = await pending;
        if (kind !== 'voice') expect(String(outcome.error)).toMatch(/privacy erasure/i);
        else expect(outcome.value).toBe(false);
        expect(await db.select().from(memories).where(eq(memories.agentId, owner.id))).toEqual([]);
        expect(
          await db
            .select({ name: contacts.name })
            .from(contacts)
            .where(eq(contacts.name, `Privacy race ${taskId}`)),
        ).toEqual([]);
        expect(await db.select().from(writingSamples)).toEqual([]);
        expect(
          await db
            .select()
            .from(maintenanceCursors)
            .where(like(maintenanceCursors.name, `prepared-memory-extraction:${owner.id}:%`)),
        ).toEqual([]);
      });
    },
    30_000,
  );
});

describe('PostgreSQL writer success controls before erasure', () => {
  it.each(['extraction', 'voice', 'memory_save'] as const)(
    'persists %s output with the same configured embedding identity',
    async (kind) => {
      await postgresFixture(async (db) => {
        const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
        if (!owner) throw new Error('Missing owner');
        const conversationId = randomUUID();
        const fact = `The owner prefers quiet walks (${randomUUID()}).`;
        await db
          .insert(conversations)
          .values({ id: conversationId, agentId: owner.id, trust: 'owner', channel: 'chat' });
        await db
          .insert(messages)
          .values({ conversationId, role: 'user', origin: 'owner', text: fact });
        const taskId = randomUUID();
        await db.insert(tasks).values({
          id: taskId,
          agentId: owner.id,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
        });
        const gate = barrier();
        const router = routerAtEmbedding(gate, fact);
        const memory = createPostgresMemoryToolRepository(db, SPACE);
        const pending = runWriter({
          kind,
          db,
          agentId: owner.id,
          taskId,
          fact,
          router,
          memory,
          voice: db,
        });
        let outcome: Awaited<typeof pending>;
        try {
          await gate.wait();
          gate.release();
          outcome = await pending;
        } finally {
          gate.release();
          await pending.catch(() => undefined);
        }
        if (kind === 'extraction') expect(savedCount(outcome)).toBeGreaterThan(0);
        if (kind === 'voice') expect(outcome).toBe(true);
        if (kind === 'memory_save') expect(outcome).toMatchObject({ saved: true });
        if (kind !== 'voice')
          expect(
            await db.select().from(memories).where(eq(memories.agentId, owner.id)),
          ).not.toEqual([]);
        if (kind === 'voice') expect(await db.select().from(writingSamples)).not.toEqual([]);
      });
    },
    30_000,
  );
});

it('orders actual card publication before a waiting erasure and clears the published source', async () => {
  await postgresFixture(async (db, eraser) => {
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Missing owner');
    const contactId = randomUUID();
    const secret = `Private source fact ${randomUUID()}`;
    await db.insert(contacts).values({ id: contactId, name: 'Owner', trust: 'owner' });
    await db.insert(memories).values({
      agentId: owner.id,
      subjectContactId: contactId,
      kind: 'fact',
      category: 'knowledge',
      content: secret,
      contentHash: randomUUID(),
    });
    await db.insert(ownerCard).values({ id: 1, content: 'previous card', compiledAt: new Date() });
    const publicationGate = barrier();
    const sourceRead = barrier();
    const blocker = eraser.transaction(async (tx) => {
      await tx.select().from(ownerCard).where(eq(ownerCard.id, 1)).for('update');
      await publicationGate.pause();
    });
    await publicationGate.wait();
    const compiling = createPostgresOwnerCardCompilationRepository(db).compile({
      agentId: owner.id,
      now: new Date(),
      render: ({ ownerFacts }) => {
        void sourceRead.pause();
        return ownerFacts.map((fact) => fact.content).join('\n');
      },
    });
    let erasing: Promise<void> | undefined;
    const marker = `pg05-card-erasure-${randomUUID()}`;
    try {
      await sourceRead.wait();
      erasing = eraser.transaction(async (tx) => {
        await tx.execute(sql`select set_config('application_name', ${marker}, true)`);
        const repository = createPostgresPrivacyErasureRepository(tx as unknown as Db);
        await repository.erase();
        await repository.complete();
      });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute(
          sql`select 1 from pg_stat_activity where application_name = ${marker} and wait_event_type = 'Lock'`,
        );
        if (rows.length > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      publicationGate.release();
      sourceRead.release();
    }
    await blocker;
    expect(await compiling).toContain(secret);
    await erasing;
    const [card] = await db.select().from(ownerCard).where(eq(ownerCard.id, 1));
    expect(card?.content).toBe('');
    expect(await db.select().from(memories)).toEqual([]);
  });
}, 30_000);

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore asynchronous writers versus completed owner erasure',
  () => {
    it.each(['extraction', 'voice', 'memory_save'] as const)(
      'rejects stale %s output after erasure completes',
      async (kind) => {
        const store = emulatorStore();
        const gate = barrier();
        try {
          const agentId = randomUUID();
          const conversationId = randomUUID();
          const fact = `The owner prefers quiet walks (${randomUUID()}).`;
          const now = new Date();
          await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
          await store.doc('conversations', conversationId).set(
            encodeRecord({
              id: conversationId,
              agentId,
              trust: 'owner',
              channel: 'chat',
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
          const messageId = randomUUID();
          await store.doc('messages', messageId).set(
            encodeRecord({
              id: messageId,
              conversationId,
              role: 'user',
              origin: 'owner',
              text: fact,
              hiddenAt: null,
              createdAt: now,
            }),
          );
          const sampleId = randomUUID();
          await store
            .doc('writingSamples', sampleId)
            .set({ id: sampleId, agentId, text: SAMPLE, register: 'email_casual' });
          const persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
          const { task } = await persistence.tasks.createTask({
            agentId,
            type: 'scheduled',
            trust: 'assistant',
            trigger: { source: 'schedule', payload: { job: 'memory.extract' } },
          });
          const claimed = await persistence.tasks.claim(task.id);
          if (!claimed?.leaseToken) throw new Error('Could not claim extraction task');
          const router = routerAtEmbedding(gate, fact);
          const noSql = new Proxy({} as Db, {
            get() {
              throw new Error('Unexpected SQL access');
            },
          });
          const voice = persistence.voiceContext;
          if (!voice) throw new Error('Missing voice repository');
          const pending =
            kind === 'extraction'
              ? runMemoryExtraction(
                  { db: noSql, router, persistence },
                  {
                    taskId: task.id,
                    agentId,
                    lease: () => ({ taskId: task.id, leaseToken: claimed.leaseToken as string }),
                  },
                ).then(
                  (value) => ({ value, error: null }),
                  (error: unknown) => ({ value: null, error }),
                )
              : kind === 'memory_save'
                ? memorySaveAtEmbedding(persistence.memory, router, {
                    agentId,
                    taskId: task.id,
                    db: noSql,
                    fact,
                  }).then(
                    (value) => ({ value, error: null }),
                    (error: unknown) => ({ value: null, error }),
                  )
                : captureOwnerWritingSample(voice, router, {
                    text: `${SAMPLE} ${randomUUID()}`,
                    register: 'chat',
                  }).then(
                    (value) => ({ value, error: null }),
                    (error: unknown) => ({ value: null, error }),
                  );
          try {
            await Promise.race([
              gate.wait(),
              pending.then((outcome) => {
                throw outcome.error ?? new Error('Writer completed before embedding');
              }),
            ]);
            const erasure = new FirestorePrivacyErasureRepository(store, agentId);
            await erasure.erase();
            expect(await erasure.pendingAssets()).toEqual([]);
            await erasure.complete();
            expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe(
              'complete',
            );
            expect((await store.collection('writingSamples').get()).empty).toBe(true);
          } finally {
            gate.release();
          }
          const outcome = await pending;
          if (kind !== 'voice')
            expect(String(outcome.error)).toMatch(/privacy erasure|lease lost/i);
          else expect(outcome.value).toBe(false);
          expect((await store.collection('memories').get()).empty).toBe(true);
          expect(
            (
              await store
                .collection('contacts')
                .where('name', '==', `Privacy race ${task.id}`)
                .get()
            ).empty,
          ).toBe(true);
          expect((await store.collection('writingSamples').get()).empty).toBe(true);
          expect((await store.collection('preparedMemoryExtractions').get()).empty).toBe(true);
        } finally {
          gate.release();
          await disposeStore(store);
        }
      },
      30_000,
    );

    it.each(['extraction', 'voice', 'memory_save'] as const)(
      'persists %s output with the same configured embedding identity before erasure',
      async (kind) => {
        const store = emulatorStore();
        const gate = barrier();
        try {
          const agentId = randomUUID();
          const conversationId = randomUUID();
          const fact = `The owner prefers quiet walks (${randomUUID()}).`;
          const now = new Date();
          await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
          await store.doc('conversations', conversationId).set(
            encodeRecord({
              id: conversationId,
              agentId,
              trust: 'owner',
              channel: 'chat',
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
          const messageId = randomUUID();
          await store.doc('messages', messageId).set(
            encodeRecord({
              id: messageId,
              conversationId,
              role: 'user',
              origin: 'owner',
              text: fact,
              hiddenAt: null,
              createdAt: now,
            }),
          );
          const persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
          const { task } = await persistence.tasks.createTask({
            agentId,
            type: 'scheduled',
            trust: 'assistant',
            trigger: { source: 'schedule', payload: { job: 'memory.extract' } },
          });
          const claimed = await persistence.tasks.claim(task.id);
          if (!claimed?.leaseToken) throw new Error('Could not claim writer control task');
          const router = routerAtEmbedding(gate, fact);
          const noSql = new Proxy({} as Db, {
            get() {
              throw new Error('Unexpected SQL access');
            },
          });
          const voice = persistence.voiceContext;
          const memory = persistence.memory;
          if (!voice || !memory) throw new Error('Missing Firestore writer repositories');
          const pending = runWriter({
            kind,
            db: noSql,
            agentId,
            taskId: task.id,
            fact,
            router,
            memory,
            voice,
            persistence,
            lease: () => ({ taskId: task.id, leaseToken: claimed.leaseToken as string }),
          });
          await gate.wait();
          gate.release();
          const outcome = await pending;
          if (kind === 'extraction') expect(savedCount(outcome)).toBeGreaterThan(0);
          if (kind === 'voice') expect(outcome).toBe(true);
          if (kind === 'memory_save') expect(outcome).toMatchObject({ saved: true });
          if (kind !== 'voice')
            expect(
              (await store.collection('memories').where('agentId', '==', agentId).get()).empty,
            ).toBe(false);
          if (kind === 'voice')
            expect(
              (await store.collection('writingSamples').where('agentId', '==', agentId).get())
                .empty,
            ).toBe(false);
        } finally {
          gate.release();
          await disposeStore(store);
        }
      },
      30_000,
    );
  },
);
