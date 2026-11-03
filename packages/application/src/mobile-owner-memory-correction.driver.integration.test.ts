import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  applyOwnerEditorCommand,
  type OwnerEditorDomainPort,
} from '@assistant/application/owner-editor';
import {
  createOwnerEditorDomain,
  createPostgresOwnerEditorDomain,
  type PreparedOwnerEditor,
} from '@assistant/application/owner-editor-domain';
import {
  agents,
  createDb,
  createPostgresOwnerEditorOperationRepository,
  type Db,
  memories,
  ownerEditorOperations,
  readPostgresOwnerEditorIssuanceContext,
  readPostgresOwnerMemoryEditorSnapshot,
  rotatePostgresOwnerEditorEpoch,
} from '@assistant/db';
import { allocateTestTarget, assertAllocatedTestTarget } from '@assistant/db/test-target';
import { embeddingSpaceIdentityKey, ownerEditorOperationId } from '@assistant/persistence';
import type {
  OwnerEditorOperationRepository,
  OwnerEditorReceiptProof,
  OwnerEditorScope,
} from '@assistant/persistence/owner-editor';
import { eq } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it, vi } from 'vitest';
import {
  createMobileOwnerMemoryCorrectionHandlers,
  type MobileOwnerMemoryCorrectionBackend,
  type MobileOwnerMemoryCorrectionPorts,
} from '../../../apps/web/lib/mobile-owner-memory-correction.js';
import { verifyMobileOwnerMemoryCorrectionAuthorization } from '../../../apps/web/lib/mobile-owner-memory-correction-proof.js';
import { createFirestoreOwnerEditorDomainStorage } from '../../../packages/firestore/src/owner-editor-domain.js';
import { readFirestoreOwnerMemoryEditorSnapshot } from '../../../packages/firestore/src/owner-editor-memory.js';
import {
  createFirestoreOwnerEditorOperationRepository,
  readFirestoreOwnerEditorIssuanceContext,
  rotateFirestoreOwnerEditorEpoch,
} from '../../../packages/firestore/src/owner-editor-repository.js';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const PG_ENABLED = Boolean(process.env.ASSISTANT_TEST_TARGET_TOKEN);
if (PG_ENABLED)
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
  });
const FIRESTORE_ENABLED = /^(127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

const secret = 'native-owner-memory-driver-integration-test-secret';
const principal = { kind: 'configured_installation_bearer' } as const;
const space = {
  provider: 'test',
  model: 'native-correction-driver-fixture',
  dimensions: 1536,
  revision: '1',
};
const vector = [1, ...Array.from({ length: 1535 }, () => 0)];
const originalContent = 'A synthetic saved source note';
const correctedContent = 'A synthetic corrected saved note';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type Counts = {
  reserve: number;
  lookup: number;
  reconcile: number;
  prepare: number;
  commit: number;
};
type DriverFixture = {
  ownerId: string;
  memoryId: string;
  counts: Counts;
  embed: ReturnType<typeof vi.fn>;
  readAuthorizationState(
    ownerId: string,
    memoryId: string,
  ): Promise<{
    snapshot: NonNullable<Awaited<ReturnType<DriverFixture['readSnapshot']>>>;
    context: import('@assistant/persistence/owner-editor').OwnerEditorIssuanceContext | null;
  } | null>;
  readSnapshot(): Promise<
    import('@assistant/persistence/owner-memory-correction').OwnerMemoryEditorSnapshot | null
  >;
  readMemory(): Promise<Record<string, unknown>>;
  buildBackend(): Promise<MobileOwnerMemoryCorrectionBackend> | MobileOwnerMemoryCorrectionBackend;
  changeOperationHash(scope: OwnerEditorScope): Promise<void>;
  cleanup(): Promise<void>;
};

function countedOperations(
  actual: OwnerEditorOperationRepository,
  counts: Counts,
): OwnerEditorOperationRepository {
  return {
    kind: actual.kind,
    reserve: async (scope, requestHash, now) => {
      counts.reserve++;
      return actual.reserve(scope, requestHash, now);
    },
    lookup: async (scope, now) => {
      counts.lookup++;
      return actual.lookup(scope, now);
    },
    reconcile: async (proof: OwnerEditorReceiptProof, now) => {
      counts.reconcile++;
      return actual.reconcile(proof, now);
    },
    failPreparation: (claim, result, now) => actual.failPreparation(claim, result, now),
  };
}

function countedDomain(
  actual: OwnerEditorDomainPort<PreparedOwnerEditor>,
  counts: Counts,
): OwnerEditorDomainPort<PreparedOwnerEditor> {
  return {
    prepare: async (request, scope) => {
      counts.prepare++;
      return actual.prepare(request, scope);
    },
    commit: async (claim, prepared, now) => {
      counts.commit++;
      return actual.commit(claim, prepared, now);
    },
  };
}

function handlersFor(fixture: DriverFixture, clock: { now: number; loseApplyResponse: boolean }) {
  const ports: MobileOwnerMemoryCorrectionPorts = {
    authenticate: async () => principal,
    resolveOwner: async () => ({ ok: true, ownerId: fixture.ownerId }),
    readAuthorizationState: (ownerId, memoryId) =>
      fixture.readAuthorizationState(ownerId, memoryId),
    secret: () => secret,
    now: () => clock.now,
    canReconcile: () => true,
    async withBackend<T>(
      _scope: OwnerEditorScope,
      run: (backend: MobileOwnerMemoryCorrectionBackend) => Promise<T>,
    ): Promise<T> {
      const result = await run(await fixture.buildBackend());
      if (clock.loseApplyResponse) {
        clock.loseApplyResponse = false;
        throw new Error('simulated process response loss after durable operation commit');
      }
      return result;
    },
  };
  return createMobileOwnerMemoryCorrectionHandlers(ports);
}

function authorizeRequest(
  memoryId: string,
  snapshot: NonNullable<Awaited<ReturnType<DriverFixture['readSnapshot']>>>,
  content: string,
) {
  return new Request(
    `https://assistant.test/api/mobile/v1/memory/${memoryId}/correction/authorize`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        intent: 'authorize',
        expectedContentHash: snapshot.contentHash,
        expectedMemoryRevision: snapshot.revision,
        content,
      }),
    },
  );
}

function statusRequest(memoryId: string, operationId: string, authorization: string) {
  return new Request(
    `https://assistant.test/api/mobile/v1/memory/${memoryId}/correction/${operationId}/status`,
    {
      headers: { 'x-owner-memory-correction-authorization': authorization },
    },
  );
}

async function authorize(
  fixture: DriverFixture,
  handlers: ReturnType<typeof handlersFor>,
  content: string,
) {
  const snapshot = await fixture.readSnapshot();
  if (!snapshot?.eligible)
    throw new Error('Driver fixture did not produce an eligible source snapshot');
  const response = await handlers.authorize(
    authorizeRequest(fixture.memoryId, snapshot, content),
    fixture.memoryId,
  );
  return { response, body: (await response.json()) as Record<string, unknown>, snapshot };
}

async function runDurableProtocol(fixture: DriverFixture) {
  const initialNow = Date.now();
  const clock = { now: initialNow, loseApplyResponse: false };
  const handlers = handlersFor(fixture, clock);
  const issued = await authorize(fixture, handlers, correctedContent);
  expect(issued.response.status).toBe(200);
  const authorization = String(issued.body.authorization);
  const operationId = String(issued.body.operationId);
  expect(fixture.counts.reserve).toBe(0);

  const proofCheck = verifyMobileOwnerMemoryCorrectionAuthorization({
    authorization,
    secret,
    now: clock.now,
    principal,
    ownerId: fixture.ownerId,
    memoryId: fixture.memoryId,
    operationId,
  });
  if (proofCheck.kind !== 'verified') throw new Error('Driver authorization did not verify');
  const claims = proofCheck.claims;
  const exactApply = () =>
    new Request(
      `https://assistant.test/api/mobile/v1/memory/${fixture.memoryId}/correction/${operationId}/apply`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-owner-memory-correction-authorization': authorization,
        },
        body: JSON.stringify({
          version: 1,
          intent: 'apply',
          operationId,
          command: 'correct_owner_memory',
          memoryId: fixture.memoryId,
          expectedContentHash: claims.expectedContentHash,
          expectedMemoryRevision: claims.expectedMemoryRevision,
          content: correctedContent,
        }),
      },
    );

  clock.loseApplyResponse = true;
  const lost = await handlers.apply(exactApply(), fixture.memoryId, operationId);
  expect(lost.status).toBe(202);
  expect(await lost.json()).toMatchObject({ authority: 'unresolved', outcome: 'outcome_unknown' });
  expect(fixture.counts).toMatchObject({ reserve: 1, prepare: 1, commit: 1, reconcile: 0 });
  expect(fixture.embed).toHaveBeenCalledTimes(1);

  const durable = await fixture.readMemory();
  expect(durable).toMatchObject({
    id: fixture.memoryId,
    content: correctedContent,
    contentHash: hash(correctedContent),
    ownerConfirmed: true,
    ownerCorrection: {
      version: 1,
      correctedByOwner: true,
      priorContentHash: issued.snapshot.contentHash,
      currentContentHash: hash(correctedContent),
    },
  });

  // A newly created handler reads the original operation receipt from the driver.
  const restarted = handlersFor(fixture, clock);
  const status = await restarted.status(
    statusRequest(fixture.memoryId, operationId, authorization),
    fixture.memoryId,
    operationId,
  );
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({
    authority: 'operation_receipt',
    outcome: 'saved',
    ids: { memoryId: fixture.memoryId },
  });
  expect(fixture.counts).toMatchObject({ reserve: 1, prepare: 1, commit: 1 });
  expect(fixture.embed).toHaveBeenCalledTimes(1);

  // Expired apply may read the already-saved exact operation, but cannot reserve or write again.
  clock.now = initialNow + 600_001;
  const expiredReplay = await restarted.apply(exactApply(), fixture.memoryId, operationId);
  expect(expiredReplay.status).toBe(200);
  expect(await expiredReplay.json()).toMatchObject({
    authority: 'operation_receipt',
    outcome: 'saved',
    ids: { memoryId: fixture.memoryId },
  });
  expect(fixture.counts).toMatchObject({ reserve: 1, prepare: 1, commit: 1 });
  expect(fixture.embed).toHaveBeenCalledTimes(1);

  // A second authorization that expires before apply has no operation row and cannot create one.
  const absent = await authorize(fixture, restarted, 'A second synthetic draft');
  const absentAuthorization = String(absent.body.authorization);
  const absentOperationId = String(absent.body.operationId);
  const absentProof = verifyMobileOwnerMemoryCorrectionAuthorization({
    authorization: absentAuthorization,
    secret,
    now: clock.now,
    principal,
    ownerId: fixture.ownerId,
    memoryId: fixture.memoryId,
    operationId: absentOperationId,
  });
  if (absentProof.kind !== 'verified')
    throw new Error('Second driver authorization did not verify');
  const absentApply = new Request(
    `https://assistant.test/api/mobile/v1/memory/${fixture.memoryId}/correction/${absentOperationId}/apply`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-owner-memory-correction-authorization': absentAuthorization,
      },
      body: JSON.stringify({
        version: 1,
        intent: 'apply',
        operationId: absentOperationId,
        command: 'correct_owner_memory',
        memoryId: fixture.memoryId,
        expectedContentHash: absentProof.claims.expectedContentHash,
        expectedMemoryRevision: absentProof.claims.expectedMemoryRevision,
        content: 'A second synthetic draft',
      }),
    },
  );
  const reserveBeforeAbsent = fixture.counts.reserve;
  clock.now += 600_001;
  const absentResult = await handlersFor(fixture, clock).apply(
    absentApply,
    fixture.memoryId,
    absentOperationId,
  );
  expect(absentResult.status).toBe(409);
  expect(await absentResult.json()).toMatchObject({
    authority: 'request_rejection',
    reason: 'authorization_expired',
  });
  expect(fixture.counts.reserve).toBe(reserveBeforeAbsent);
  expect(fixture.counts).toMatchObject({ prepare: 1, commit: 1 });
  expect(fixture.embed).toHaveBeenCalledTimes(1);

  // A fetched record with a different stored request hash cannot disclose its saved receipt.
  await fixture.changeOperationHash(claims.scope);
  const mismatched = await handlersFor(fixture, clock).status(
    statusRequest(fixture.memoryId, operationId, authorization),
    fixture.memoryId,
    operationId,
  );
  const mismatchBody = (await mismatched.json()) as Record<string, unknown>;
  expect(mismatched.status).toBe(409);
  expect(mismatchBody).toMatchObject({
    authority: 'request_rejection',
    reason: 'request_binding_mismatch',
  });
  expect(mismatchBody).not.toHaveProperty('ids');
  expect(mismatchBody).not.toHaveProperty('requestHash');
  expect(fixture.counts.reconcile).toBe(0);
}

async function withIsolatedPostgres(
  run: (db: Db, ownerId: string, memoryId: string) => Promise<void>,
) {
  if (!process.env.DATABASE_URL) throw new Error('Allocated PostgreSQL test URL is required');
  const target = allocateTestTarget(process.env.DATABASE_URL);
  const adminUrl = new URL(target.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.toString());
  let db: Db | undefined;
  let created = false;
  let cleanupError: Error | undefined;
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${target.databaseName}"`);
    created = true;
    await admin.$client.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    db = createDb(target.databaseUrl, { max: 1 });
    await migratePostgres(db, {
      migrationsFolder: fileURLToPath(new URL('../../../packages/db/drizzle/', import.meta.url)),
    });
    const ownerId = randomUUID();
    const memoryId = randomUUID();
    await db.insert(agents).values({
      id: ownerId,
      name: 'Synthetic native correction owner',
      email: `${ownerId}@example.test`,
      workspacePrefix: `native-correction/${ownerId}`,
    });
    await rotatePostgresOwnerEditorEpoch(db, ownerId, true);
    await db.insert(memories).values({
      id: memoryId,
      agentId: ownerId,
      category: 'knowledge',
      kind: 'fact',
      content: originalContent,
      contentHash: hash(originalContent),
      source: 'manual',
      domain: 'home',
      ownerCorrection: null,
      embedding: vector,
      embeddingSpaceKey: embeddingSpaceIdentityKey(space),
    });
    await run(db, ownerId, memoryId);
  } finally {
    await db?.$client.end();
    try {
      if (created) {
        const [owned] = await admin.$client<{ marker: string | null }[]>`
          SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${target.databaseName}
        `;
        if (owned?.marker !== `assistant-test-target:${target.token}`)
          cleanupError = new Error(
            'Native correction PostgreSQL fixture cleanup ownership mismatch',
          );
        else await admin.$client.unsafe(`DROP DATABASE "${target.databaseName}"`);
      }
    } finally {
      await admin.$client.end();
    }
  }
  if (cleanupError) throw cleanupError;
}

function postgresFixture(db: Db, ownerId: string, memoryId: string): DriverFixture {
  const counts: Counts = { reserve: 0, lookup: 0, reconcile: 0, prepare: 0, commit: 0 };
  const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
  const router = { embeddingSpace: async () => space, embed };
  const buildBackend = async (): Promise<MobileOwnerMemoryCorrectionBackend> => {
    const operations = countedOperations(createPostgresOwnerEditorOperationRepository(db), counts);
    const actualDomain = await createPostgresOwnerEditorDomain({ db, router });
    const domain = countedDomain(actualDomain, counts);
    return {
      operations,
      apply: (request, scope) => applyOwnerEditorCommand({ request, scope, operations, domain }),
    };
  };
  const readSnapshot = () =>
    db.transaction((tx) => readPostgresOwnerMemoryEditorSnapshot(tx, ownerId, memoryId));
  return {
    ownerId,
    memoryId,
    counts,
    embed,
    readSnapshot,
    async readAuthorizationState(requestOwnerId, requestMemoryId) {
      if (requestOwnerId !== ownerId || requestMemoryId !== memoryId) return null;
      return db.transaction(async (tx) => {
        const snapshot = await readPostgresOwnerMemoryEditorSnapshot(tx, ownerId, memoryId);
        if (!snapshot) return null;
        const context = await readPostgresOwnerEditorIssuanceContext(tx, ownerId);
        return { snapshot, context };
      });
    },
    async readMemory() {
      const [row] = await db.select().from(memories).where(eq(memories.id, memoryId));
      if (!row) throw new Error('PostgreSQL correction source disappeared');
      return row as unknown as Record<string, unknown>;
    },
    buildBackend,
    async changeOperationHash(scope) {
      await db
        .update(ownerEditorOperations)
        .set({ requestHash: 'e'.repeat(64) })
        .where(eq(ownerEditorOperations.id, ownerEditorOperationId(scope)));
    },
    async cleanup() {},
  };
}

function firestoreFixture(
  store: InstallationStore,
  ownerId: string,
  memoryId: string,
): DriverFixture {
  const counts: Counts = { reserve: 0, lookup: 0, reconcile: 0, prepare: 0, commit: 0 };
  const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
  const router = { embeddingSpace: async () => space, embed };
  const buildBackend = (): MobileOwnerMemoryCorrectionBackend => {
    const operations = countedOperations(
      createFirestoreOwnerEditorOperationRepository(store, ownerId),
      counts,
    );
    const actualDomain = createOwnerEditorDomain({
      storage: createFirestoreOwnerEditorDomainStorage(store, ownerId, space),
      router,
    });
    const domain = countedDomain(actualDomain, counts);
    return {
      operations,
      apply: (request, scope) => applyOwnerEditorCommand({ request, scope, operations, domain }),
    };
  };
  const readSnapshot = () => readFirestoreOwnerMemoryEditorSnapshot(store, ownerId, memoryId);
  return {
    ownerId,
    memoryId,
    counts,
    embed,
    readSnapshot,
    async readAuthorizationState(requestOwnerId, requestMemoryId) {
      if (requestOwnerId !== ownerId || requestMemoryId !== memoryId) return null;
      return store.db.runTransaction(async (tx) => {
        const snapshot = await readFirestoreOwnerMemoryEditorSnapshot(store, ownerId, memoryId, tx);
        if (!snapshot) return null;
        const context = await readFirestoreOwnerEditorIssuanceContext(store, ownerId, tx);
        return { snapshot, context };
      });
    },
    async readMemory() {
      const record = (await store.doc('memories', memoryId).get()).data();
      if (!record) throw new Error('Firestore correction source disappeared');
      return record;
    },
    buildBackend,
    async changeOperationHash(scope) {
      await store
        .doc('ownerEditorOperations', ownerEditorOperationId(scope))
        .update({ requestHash: 'e'.repeat(64) });
    },
    cleanup: () => disposeStore(store),
  };
}

describe.skipIf(!PG_ENABLED)(
  'native owner-memory correction on the allocated PostgreSQL harness',
  () => {
    it('survives handler recreation, lost response, expired apply replay, absent-operation expiry, and receipt hash mismatch', async () => {
      await withIsolatedPostgres(async (db, ownerId, memoryId) => {
        const fixture = postgresFixture(db, ownerId, memoryId);
        await runDurableProtocol(fixture);
      });
    }, 90_000);
  },
);

describe.skipIf(!FIRESTORE_ENABLED)(
  'native owner-memory correction on the Firestore emulator harness',
  () => {
    it('survives handler recreation, lost response, expired apply replay, absent-operation expiry, and receipt hash mismatch', async () => {
      const store = emulatorStore();
      const ownerId = randomUUID();
      const memoryId = randomUUID();
      try {
        await store.doc('agents', ownerId).set({ id: ownerId, timezone: 'UTC', locale: 'en' });
        await rotateFirestoreOwnerEditorEpoch(store, ownerId, true);
        await store.doc('memories', memoryId).set({
          id: memoryId,
          agentId: ownerId,
          category: 'knowledge',
          kind: 'fact',
          content: originalContent,
          contentHash: hash(originalContent),
          source: 'manual',
          sourceTaskId: null,
          subjectContactId: null,
          domain: 'home',
          ownerConfirmed: false,
          originTrust: 'known',
          quarantined: false,
          ownerCorrection: null,
          expiresAt: null,
          supersededById: null,
          validFrom: null,
          validUntil: null,
          createdAt: new Date(),
          importance: 3,
          pinned: false,
          confidence: '0.70',
          embedding: vector,
          embeddingSpaceKey: embeddingSpaceIdentityKey(space),
          lastAccessedAt: null,
          lastConsolidatedAt: null,
        });
        const fixture = firestoreFixture(store, ownerId, memoryId);
        await runDurableProtocol(fixture);
      } finally {
        await disposeStore(store);
      }
    }, 90_000);
  },
);
