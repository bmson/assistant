import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  agents,
  contacts,
  createDb,
  createPostgresOwnerEditorOperationRepository,
  createPostgresPrivacyErasureRepository,
  type Db,
  knowledgeGraphRelations,
  maintenanceCursors,
  memories,
  ownerEditorOperations,
  postgresOwnerEditorContact,
  readPostgresOwnerEditorGraphScope,
  readPostgresOwnerEditorIssuanceContext,
  rotatePostgresOwnerEditorEpoch,
} from '@assistant/db';
import {
  type OwnerEditorApply,
  type OwnerEditorIssuanceContext,
  type OwnerEditorOperationRepository,
  type OwnerEditorReply,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it, vi } from 'vitest';
import { allocateTestTarget, assertAllocatedTestTarget } from '../../db/src/test-target.js';
import { createFirestoreOwnerEditorDomainStorage } from '../../firestore/src/owner-editor-domain.js';
import {
  readFirestoreOwnerEditorContact,
  readFirestoreOwnerEditorGraphScope,
} from '../../firestore/src/owner-editor-graph.js';
import {
  createFirestoreOwnerEditorOperationRepository,
  readFirestoreOwnerEditorIssuanceContext,
  rotateFirestoreOwnerEditorEpoch,
} from '../../firestore/src/owner-editor-repository.js';
import { FirestorePrivacyErasureRepository } from '../../firestore/src/privacy-erasure.js';
import type { InstallationStore } from '../../firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../firestore/src/test-store.js';
import type { OwnerEditorDomainPort } from './owner-editor.js';
import { applyOwnerEditorCommand } from './owner-editor.js';
import { createOwnerEditorDomain, createPostgresOwnerEditorDomain } from './owner-editor-domain.js';
import { ownerEditorRequestHash } from './owner-editor-hash.js';
import { ownerEditorPath, parseOwnerEditorRequest } from './owner-editor-wire.js';

function familyFields(request: Extract<OwnerEditorApply, { command: 'add_family_relationship' }>) {
  const {
    version: _version,
    intent: _intent,
    command: _command,
    operationId: _operationId,
    ...fields
  } = request;
  return fields;
}
function checked(request: OwnerEditorApply) {
  const parsed = parseOwnerEditorRequest(request, ownerEditorPath(request.command));
  if (!parsed.ok || parsed.request.intent !== 'apply')
    throw new Error(`Invalid integration fixture: ${JSON.stringify(parsed)}`);
  return parsed.request;
}
const space = {
  provider: 'test',
  model: 'owner-editor-integration',
  dimensions: 1536,
  revision: '1',
};
const router = () => ({
  embeddingSpace: async () => space,
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => [1, ...Array.from({ length: 1535 }, () => 0)]),
  ),
});
function issued(ownerId: string, epoch: string, request: OwnerEditorApply): OwnerEditorScope {
  const now = Date.now();
  return {
    ownerId,
    epoch,
    privacyGeneration: null,
    command: request.command,
    operationId: request.operationId,
    targetId:
      request.command === 'create_person'
        ? null
        : request.command === 'update_person_identity'
          ? request.contactId
          : request.command === 'correct_owner_family_relationship'
            ? request.targetRelationId
            : request.subjectContactId,
    sessionDigest: 'a'.repeat(64),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 600000,
  };
}
/** Same actual prepared worker is released after maintenance/erasure; no raw rollback detection is claimed. */
async function verifyRetiredWorkers<Prepared>(input: {
  ownerId: string;
  epoch: string;
  operations: OwnerEditorOperationRepository;
  domain: OwnerEditorDomainPort<Prepared>;
  rotate(): Promise<unknown>;
  erase(): Promise<void>;
  context(): Promise<OwnerEditorIssuanceContext | null>;
  count(): Promise<number>;
  receiptCount(): Promise<number>;
  hasReceipt(scope: OwnerEditorScope): Promise<boolean>;
}) {
  let epoch = input.epoch;
  for (const [index, retire] of [input.rotate, input.erase].entries()) {
    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'create_person',
      operationId: randomUUID(),
      name: 'Held retired worker',
      aliases: [],
    };
    const scope = issued(input.ownerId, epoch, request),
      context = await input.context();
    if (!context) throw new Error('Missing current editor context');
    scope.privacyGeneration = context.privacyGeneration;
    const reserved = await input.operations.reserve(
      scope,
      ownerEditorRequestHash(request),
      new Date(),
    );
    if (reserved.kind !== 'claimed') throw new Error(JSON.stringify(reserved));
    const prepared = await input.domain.prepare(request, scope);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    // The previous durable metadata + preparing row represent a restored old installation snapshot.
    // Explicit maintenance rotation is required before accepting writes; no automatic rollback detector.
    expect(await input.hasReceipt(scope)).toBe(true);
    await retire();
    expect(await input.hasReceipt(scope)).toBe(index === 0);
    const count = await input.count(),
      receiptCount = await input.receiptCount();
    expect(await input.domain.commit(reserved.claim, prepared.prepared, new Date())).toMatchObject({
      authority: 'scope_retirement',
      outcome: 'voided',
    });
    expect(await input.count()).toBe(count);
    expect(await input.receiptCount()).toBe(receiptCount);
    expect(await input.hasReceipt(scope)).toBe(index === 0);
    expect((await input.operations.lookup(scope, new Date())).reply).toMatchObject({
      authority: 'scope_retirement',
      outcome: 'voided',
    });
    const fresh = await input.context();
    if (!fresh) throw new Error('Fresh editor context unavailable');
    expect(fresh.epoch).not.toBe(epoch);
    epoch = fresh.epoch;
    const next: OwnerEditorApply = {
      ...request,
      operationId: randomUUID(),
      name: `Fresh scoped contact ${index}`,
    };
    const nextScope = {
      ...issued(input.ownerId, epoch, next),
      privacyGeneration: fresh.privacyGeneration,
    };
    expect(
      await applyOwnerEditorCommand({
        request: checked(next),
        scope: nextScope,
        domain: input.domain,
        operations: input.operations,
      }),
    ).toMatchObject({ outcome: 'saved' });
    expect(await input.count()).toBe(count + 1);
  }
}
async function verifyIdentityRace<Prepared>(input: {
  ownerId: string;
  epoch: string;
  domain: OwnerEditorDomainPort<Prepared>;
  operations: OwnerEditorOperationRepository;
  contact(id: string): Promise<{ revision: string; name: string; aliases: string[] } | null>;
}) {
  const request: OwnerEditorApply = {
    version: 1,
    intent: 'apply',
    command: 'create_person',
    operationId: randomUUID(),
    name: 'Race original',
    aliases: [],
  };
  const created = await applyOwnerEditorCommand({
    request: checked(request),
    scope: issued(input.ownerId, input.epoch, request),
    domain: input.domain,
    operations: input.operations,
  });
  if (created.outcome !== 'saved' || !created.ids.contactId)
    throw new Error(JSON.stringify(created));
  const id = created.ids.contactId,
    before = await input.contact(id);
  if (!before) throw new Error('Missing race contact');
  const attempts = await Promise.all(
    ['Race left', 'Race right'].map(async (name) => {
      const update: OwnerEditorApply = {
        version: 1,
        intent: 'apply',
        command: 'update_person_identity',
        operationId: randomUUID(),
        contactId: id,
        expectedContactRevision: before.revision,
        name,
        aliases: [],
      };
      const scope = issued(input.ownerId, input.epoch, update);
      const reservation = await input.operations.reserve(
        scope,
        ownerEditorRequestHash(checked(update)),
        new Date(),
      );
      if (reservation.kind !== 'claimed') throw new Error(JSON.stringify(reservation));
      const prepared = await input.domain.prepare(checked(update), scope);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared));
      return { request: update, scope, claim: reservation.claim, prepared: prepared.prepared };
    }),
  );
  // Both actual preparations observed exactly the same native snapshot before either commit.
  const results = await Promise.all(
    attempts.map((attempt) => input.domain.commit(attempt.claim, attempt.prepared, new Date())),
  );
  expect(results.map((result) => result.outcome).sort()).toEqual(['conflict', 'saved']);
  const winner = results.findIndex((result) => result.outcome === 'saved');
  const winningRequest = attempts[winner]?.request;
  if (!winningRequest || winningRequest.command !== 'update_person_identity')
    throw new Error('Missing winning identity');
  expect((await input.contact(id))?.name).toBe(winningRequest.name);
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (!attempt) throw new Error('Missing attempt');
    const lookup = await input.operations.lookup(attempt.scope, new Date());
    expect(lookup.reply).toEqual(results[i]);
    expect(lookup.operation?.status).toBe(
      results[i]?.outcome === 'saved' ? 'committed' : 'terminal_rejected',
    );
  }
  return id;
}

/** Distinct operations and contact IDs must still serialize the normalized-name decision. */
async function verifyNameRaces<Prepared>(input: {
  ownerId: string;
  epoch: string;
  domain: OwnerEditorDomainPort<Prepared>;
  operations: OwnerEditorOperationRepository;
  contact(id: string): Promise<{ revision: string } | null>;
  names(): Promise<string[]>;
  commitTogether?(
    commits: readonly (() => Promise<OwnerEditorReply>)[],
  ): Promise<OwnerEditorReply[]>;
}) {
  const prepare = async (request: OwnerEditorApply) => {
    const parsed = checked(request),
      scope = issued(input.ownerId, input.epoch, parsed);
    const reserved = await input.operations.reserve(
      scope,
      ownerEditorRequestHash(parsed),
      new Date(),
    );
    if (reserved.kind !== 'claimed') throw new Error(JSON.stringify(reserved));
    const prepared = await input.domain.prepare(parsed, scope);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    return { scope, claim: reserved.claim, prepared: prepared.prepared };
  };
  for (const mode of ['create', 'rename'] as const) {
    const shared = `Shared ${mode} race`,
      requests: OwnerEditorApply[] = [];
    for (let index = 0; index < 2; index++) {
      const name = index === 0 ? `  ${shared}  ` : shared.toLocaleLowerCase();
      if (mode === 'create')
        requests.push({
          version: 1,
          intent: 'apply',
          command: 'create_person',
          operationId: randomUUID(),
          name,
          aliases: [],
        });
      else {
        const seed: OwnerEditorApply = {
          version: 1,
          intent: 'apply',
          command: 'create_person',
          operationId: randomUUID(),
          name: `Rename racer ${index}`,
          aliases: [],
        };
        const created = await applyOwnerEditorCommand({
          request: checked(seed),
          scope: issued(input.ownerId, input.epoch, seed),
          domain: input.domain,
          operations: input.operations,
        });
        if (created.outcome !== 'saved' || !created.ids.contactId)
          throw new Error(JSON.stringify(created));
        const before = await input.contact(created.ids.contactId);
        if (!before) throw new Error('Missing rename racer');
        requests.push({
          version: 1,
          intent: 'apply',
          command: 'update_person_identity',
          operationId: randomUUID(),
          contactId: created.ids.contactId,
          expectedContactRevision: before.revision,
          name,
          aliases: [],
        });
      }
    }
    const attempts = await Promise.all(requests.map(prepare));
    expect(new Set(attempts.map((attempt) => attempt.scope.operationId)).size).toBe(2);
    const commits = attempts.map(
      (attempt) => () => input.domain.commit(attempt.claim, attempt.prepared, new Date()),
    );
    const results = input.commitTogether
      ? await input.commitTogether(commits)
      : await Promise.all(commits.map((commit) => commit()));
    expect(results.map((result) => result.outcome).sort()).toEqual(['conflict', 'saved']);
    expect(
      (await input.names()).filter(
        (name) => name.trim().toLocaleLowerCase() === shared.toLocaleLowerCase(),
      ),
    ).toHaveLength(1);
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index];
      if (!attempt) throw new Error('Missing name race');
      const lookup = await input.operations.lookup(attempt.scope, new Date());
      expect(lookup.reply).toEqual(results[index]);
      expect(lookup.operation?.status).toBe(
        results[index]?.outcome === 'saved' ? 'committed' : 'terminal_rejected',
      );
    }
  }
}

/** Inject a callback throw after real SDK primary writes are queued, before the atomic receipt write. */
function failFirestoreTerminalReceipt(store: InstallationStore): InstallationStore {
  const db = new Proxy(store.db, {
    get(target, key) {
      if (key === 'runTransaction')
        return <T>(run: (tx: Transaction) => Promise<T>) =>
          target.runTransaction((tx) =>
            run(
              new Proxy(tx, {
                get(transaction, method) {
                  if (method === 'set')
                    return (
                      ref: import('@google-cloud/firestore').DocumentReference,
                      data: Record<string, unknown>,
                    ) => {
                      if (ref.parent.id === 'ownerEditorOperations' && data.status === 'committed')
                        throw new Error('Injected terminal receipt callback failure');
                      return transaction.set(ref, data);
                    };
                  const value = Reflect.get(transaction, method);
                  return typeof value === 'function' ? value.bind(transaction) : value;
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(store, {
    get(target, key) {
      if (key === 'db') return db;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function dropOwnedEditorFixture(
  admin: ReturnType<typeof createDb>,
  target: ReturnType<typeof allocateTestTarget>,
) {
  const [owned] =
    await admin.$client`SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${target.databaseName}`;
  if (owned?.marker !== `assistant-test-target:${target.token}`)
    throw new Error('Editor integration cleanup ownership mismatch');
  await admin.$client.unsafe(`DROP DATABASE "${target.databaseName}"`);
}
interface PostgresFixtureControl {
  databaseUrl: string;
  blockedWriters(holderPid: number): Promise<Array<{ pid: number; blocking: number[] }>>;
}
async function withIsolatedPostgres(
  run: (db: Db, ownerId: string, control: PostgresFixtureControl) => Promise<void>,
  max: 1 | 2 = 1,
) {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  if (!process.env.DATABASE_URL) throw new Error('Explicit allocated PostgreSQL test URL required');
  const target = allocateTestTarget(process.env.DATABASE_URL);
  const adminUrl = new URL(target.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.toString());
  let db: Db | undefined,
    created = false;
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${target.databaseName}"`);
    created = true;
    await admin.$client.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    db = createDb(target.databaseUrl, { max });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../db/drizzle/', import.meta.url)),
    });
    const ownerId = randomUUID();
    await db.insert(agents).values({
      id: ownerId,
      name: 'Synthetic editor owner',
      email: `${ownerId}@example.test`,
      workspacePrefix: `editor-test/${ownerId}`,
    });
    await run(db, ownerId, {
      databaseUrl: target.databaseUrl,
      blockedWriters: async (holderPid) =>
        admin.$client.begin(async (observation) => {
          // Observation only: database CREATE/DROP remain outside transactions.
          // A stalled sample must release the holder via the caller's finally path.
          await observation`SET LOCAL statement_timeout = '250ms'`;
          const rows = await observation<
            { pid: number; blocking: number[] }[]
          >`SELECT pid, pg_blocking_pids(pid) AS blocking FROM pg_stat_activity WHERE datname = ${target.databaseName} AND pid <> ${holderPid} AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;
          return [...rows];
        }),
    });
  } finally {
    await db?.$client.end();
    try {
      if (created) await dropOwnedEditorFixture(admin, target);
    } finally {
      await admin.$client.end();
    }
  }
}

describe.skipIf(!process.env.ASSISTANT_TEST_TARGET_TOKEN)(
  'owner editor real isolated PostgreSQL writers (CI only)',
  () => {
    it('persists named create/identity/family/correction and exact receipt replay through the existing atomic pipeline', async () => {
      await withIsolatedPostgres(async (db, ownerId) => {
        const epoch = randomUUID();
        await db.insert(maintenanceCursors).values({
          name: `owner-editor-epoch:${ownerId}`,
          cursor: JSON.stringify({
            ownerId,
            epoch,
            privacyGenerationDigest: ownerEditorPrivacyDigest(null),
            ready: true,
          }),
        });
        const embedding = router(),
          domain = await createPostgresOwnerEditorDomain({ db, router: embedding }),
          operations = createPostgresOwnerEditorOperationRepository(db);
        const run = (request: OwnerEditorApply, scope = issued(ownerId, epoch, request)) =>
          applyOwnerEditorCommand({ request: checked(request), scope, domain, operations });
        const add = async (name: string) => {
          const saved = await run({
            version: 1,
            intent: 'apply',
            command: 'create_person',
            operationId: randomUUID(),
            name,
            aliases: [],
          });
          if (saved.outcome !== 'saved' || !saved.ids.contactId)
            throw new Error(JSON.stringify(saved));
          return saved.ids.contactId;
        };
        const alex = await add('Alex'),
          sam = await add('Sam');
        const before = await postgresOwnerEditorContact(db, ownerId, alex);
        expect(
          await run({
            version: 1,
            intent: 'apply',
            command: 'update_person_identity',
            operationId: randomUUID(),
            contactId: alex,
            expectedContactRevision: before!.revision,
            name: 'Alex New',
            aliases: ['Al'],
          }),
        ).toMatchObject({ outcome: 'saved' });
        const a = await postgresOwnerEditorContact(db, ownerId, alex),
          b = await postgresOwnerEditorContact(db, ownerId, sam);
        const request: Extract<OwnerEditorApply, { command: 'add_family_relationship' }> = {
          version: 1,
          intent: 'apply',
          command: 'add_family_relationship',
          operationId: randomUUID(),
          subjectContactId: alex,
          objectContactId: sam,
          expectedSubjectRevision: a!.revision,
          expectedObjectRevision: b!.revision,
          predicate: 'parent_of',
          timing: 'unspecified',
          validity: { validFrom: null, validUntil: '2024-02-29' },
          note: '',
          expectedCanonicalState: { kind: 'absent' },
        };
        const scope = issued(ownerId, epoch, request),
          saved = await run(request, scope);
        expect(saved).toMatchObject({ outcome: 'saved', authority: 'operation_receipt' });
        if (saved.outcome !== 'saved') throw new Error(JSON.stringify(saved));
        expect(await run(request, scope)).toEqual(saved);
        expect(embedding.embed).toHaveBeenCalledTimes(1);
        const target = await readPostgresOwnerEditorGraphScope(db, ownerId, saved.ids.relationId!);
        const corrected = await run({
          version: 1,
          intent: 'apply',
          command: 'correct_owner_family_relationship',
          operationId: randomUUID(),
          targetRelationId: saved.ids.relationId!,
          expectedTargetRevision: target!.revision,
          replacement: {
            ...familyFields(request),
            predicate: 'partner_of',
            timing: 'past',
            validity: { validFrom: null, validUntil: null },
          },
        });
        expect(corrected).toMatchObject({
          outcome: 'saved',
          ids: { previousRelationId: saved.ids.relationId },
        });
        const [oldSource] = await db
          .select()
          .from(memories)
          .where(eq(memories.id, saved.ids.memoryId!));
        expect(oldSource?.validUntil?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
        if (corrected.outcome !== 'saved') throw new Error(JSON.stringify(corrected));
        expect(oldSource?.supersededById).toBe(corrected.ids.memoryId);
        const [oldRelation] = await db
          .select()
          .from(knowledgeGraphRelations)
          .where(eq(knowledgeGraphRelations.id, saved.ids.relationId!));
        expect(oldRelation?.reviewStatus).toBe('rejected');
        const [person] = await db.select().from(contacts).where(eq(contacts.id, alex));
        expect(person).toMatchObject({ trust: 'known', aliases: ['Al', 'Alex'] });
        const racer = await verifyIdentityRace({
          ownerId,
          epoch,
          domain,
          operations,
          contact: (id) => postgresOwnerEditorContact(db, ownerId, id),
        });
        const rollbackBefore = await postgresOwnerEditorContact(db, ownerId, racer);
        if (!rollbackBefore) throw new Error('Missing rollback contact');
        const rollbackRequest: OwnerEditorApply = {
          version: 1,
          intent: 'apply',
          command: 'update_person_identity',
          operationId: randomUUID(),
          contactId: racer,
          expectedContactRevision: rollbackBefore.revision,
          name: 'Must rollback PG',
          aliases: [],
        };
        const rollbackScope = issued(ownerId, epoch, rollbackRequest),
          faultName = `editor_receipt_fault_${randomUUID().replaceAll('-', '')}`;
        await db.$client.unsafe(
          `CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'committed' THEN RAISE EXCEPTION 'Injected terminal receipt failure'; END IF; RETURN NEW; END; $$`,
        );
        try {
          await db.$client.unsafe(
            `CREATE TRIGGER ${faultName} BEFORE UPDATE ON owner_editor_operations FOR EACH ROW EXECUTE FUNCTION ${faultName}()`,
          );
          try {
            expect(await run(rollbackRequest, rollbackScope)).toMatchObject({
              outcome: 'outcome_unknown',
              authority: 'unresolved',
            });
          } finally {
            await db.$client.unsafe(
              `DROP TRIGGER IF EXISTS ${faultName} ON owner_editor_operations`,
            );
          }
        } finally {
          await db.$client.unsafe(`DROP FUNCTION IF EXISTS ${faultName}()`);
        }
        expect(await postgresOwnerEditorContact(db, ownerId, racer)).toEqual(rollbackBefore);
        expect((await operations.lookup(rollbackScope, new Date())).operation?.status).toBe(
          'preparing',
        );
        await verifyNameRaces({
          ownerId,
          epoch,
          domain,
          operations,
          contact: (id) => postgresOwnerEditorContact(db, ownerId, id),
          names: async () =>
            (await db.select({ name: contacts.name }).from(contacts)).map((row) => row.name),
        });

        await verifyRetiredWorkers({
          ownerId,
          epoch,
          domain,
          operations,
          rotate: () => rotatePostgresOwnerEditorEpoch(db, ownerId, true),
          erase: async () => {
            const erasure = createPostgresPrivacyErasureRepository(db);
            await erasure.erase();
            await erasure.complete();
          },
          context: () =>
            db.transaction((tx) => readPostgresOwnerEditorIssuanceContext(tx, ownerId)),
          count: async () => (await db.select().from(contacts)).length,
          receiptCount: async () => (await db.select().from(ownerEditorOperations)).length,
          hasReceipt: async (scope) =>
            (
              await db
                .select({ id: ownerEditorOperations.id })
                .from(ownerEditorOperations)
                .where(eq(ownerEditorOperations.id, ownerEditorOperationId(scope)))
            ).length === 1,
        });
      });
    }, 60000);
    it('proves overlapping distinct PostgreSQL writer connections contend on owner serialization for normalized-name races', async () => {
      await withIsolatedPostgres(async (db, ownerId, control) => {
        const epoch = randomUUID();
        await db.insert(maintenanceCursors).values({
          name: `owner-editor-epoch:${ownerId}`,
          cursor: JSON.stringify({
            ownerId,
            epoch,
            privacyGenerationDigest: ownerEditorPrivacyDigest(null),
            ready: true,
          }),
        });
        const domain = await createPostgresOwnerEditorDomain({ db, router: router() }),
          operations = createPostgresOwnerEditorOperationRepository(db);
        const holder = createDb(control.databaseUrl, { max: 1 });
        const observations: Array<{
          holderPid: number;
          writers: Array<{ pid: number; blocking: number[] }>;
        }> = [];
        try {
          await verifyNameRaces({
            ownerId,
            epoch,
            domain,
            operations,
            contact: (id) => postgresOwnerEditorContact(db, ownerId, id),
            names: async () =>
              (await db.select({ name: contacts.name }).from(contacts)).map((row) => row.name),
            commitTogether: async (commits) => {
              let unlock = () => {},
                readyResolve = (_pid: number) => {},
                readyReject = (_error: unknown) => {};
              const release = new Promise<void>((resolve) => {
                unlock = resolve;
              });
              const acquired = new Promise<number>((resolve, reject) => {
                readyResolve = resolve;
                readyReject = reject;
              });
              const held = holder.transaction(async (tx) => {
                const [owner] = await tx
                  .select({ pid: sql<number>`pg_backend_pid()` })
                  .from(agents)
                  .where(eq(agents.id, ownerId))
                  .for('update');
                if (!owner) throw new Error('Missing owner lock barrier');
                readyResolve(owner.pid);
                await release;
              });
              // Attach immediately so an acquisition failure cannot leave an unhandled rejection.
              void held.catch(readyReject);
              let pending: Promise<OwnerEditorReply[]> | undefined, observationError: unknown;
              let workers: Promise<OwnerEditorReply>[] = [];
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const holderPid = await Promise.race([
                  acquired,
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () => reject(new Error('Owner barrier acquisition exceeded 2500ms')),
                      2500,
                    );
                  }),
                ]);
                clearTimeout(timer);
                // No writer has acquired its owner lock yet. Start both real transactions now.
                workers = commits.map((commit) => commit());
                pending = Promise.all(workers);
                void pending.catch(() => {});
                let writers: Array<{ pid: number; blocking: number[] }> = [];
                for (let sample = 0; sample < 100; sample++) {
                  writers = await control.blockedWriters(holderPid);
                  if (new Set(writers.map((writer) => writer.pid)).size === 2) break;
                  await new Promise((resolve) => setTimeout(resolve, 25));
                }
                expect(new Set(writers.map((writer) => writer.pid)).size).toBe(2);
                expect(
                  writers.every((writer) => writer.pid !== holderPid && writer.blocking.length > 0),
                ).toBe(true);
                expect(
                  writers.every((writer) =>
                    writer.blocking.some(
                      (pid) => pid === holderPid || writers.some((other) => other.pid === pid),
                    ),
                  ),
                ).toBe(true);
                observations.push({ holderPid, writers });
              } catch (error) {
                observationError = error;
              } finally {
                clearTimeout(timer);
                unlock();
                // Await every actual writer even if one rejected early, before closing owned handles.
                const settled = await Promise.allSettled([held, ...workers]);
                const holderResult = settled[0];
                if (holderResult?.status === 'rejected' && observationError === undefined)
                  observationError = holderResult.reason;
              }
              const results = pending ? await pending : [];
              if (observationError) throw observationError;
              return results;
            },
          });
          expect(observations).toHaveLength(2);
          console.info('Synthetic editor PG contention evidence', JSON.stringify(observations));
        } finally {
          await holder.$client.end();
        }
      }, 2);
    }, 60000);
  },
);

const loopbackEmulator = /^(127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);
describe.skipIf(!loopbackEmulator)(
  'owner editor real isolated Firestore writer (CI emulator only)',
  () => {
    it('roundtrips inclusive days and source-backed correction through actual Firestore transactions', async () => {
      const store = emulatorStore(),
        ownerId = randomUUID(),
        epoch = randomUUID(),
        alex = randomUUID(),
        sam = randomUUID();
      try {
        await store.doc('agents', ownerId).set({ id: ownerId, timezone: 'UTC', locale: 'en' });
        await store.doc('maintenanceCursors', `owner-editor-epoch:${ownerId}`).set({
          name: `owner-editor-epoch:${ownerId}`,
          cursor: JSON.stringify({
            ownerId,
            epoch,
            privacyGenerationDigest: ownerEditorPrivacyDigest(null),
            ready: true,
          }),
        });
        for (const [id, name] of [
          [alex, 'Alex'],
          [sam, 'Sam'],
        ])
          await store.doc('contacts', id!).set({
            id,
            agentId: ownerId,
            name,
            aliases: [],
            trust: 'unknown',
            relationship: '',
            emails: [],
            phones: [],
            notes: '',
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        const embedding = router(),
          domain = createOwnerEditorDomain({
            storage: createFirestoreOwnerEditorDomainStorage(store, ownerId, space),
            router: embedding,
          }),
          operations = createFirestoreOwnerEditorOperationRepository(store, ownerId);
        const run = (request: OwnerEditorApply, scope = issued(ownerId, epoch, request)) =>
          applyOwnerEditorCommand({ request: checked(request), scope, domain, operations });
        const a = await readFirestoreOwnerEditorContact(store, ownerId, alex),
          b = await readFirestoreOwnerEditorContact(store, ownerId, sam);
        const request: Extract<OwnerEditorApply, { command: 'add_family_relationship' }> = {
          version: 1,
          intent: 'apply',
          command: 'add_family_relationship',
          operationId: randomUUID(),
          subjectContactId: alex,
          objectContactId: sam,
          expectedSubjectRevision: a!.revision,
          expectedObjectRevision: b!.revision,
          predicate: 'parent_of',
          timing: 'unspecified',
          validity: { validFrom: '2024-02-29', validUntil: '2024-02-29' },
          note: '',
          expectedCanonicalState: { kind: 'absent' },
        };
        const scope = issued(ownerId, epoch, request),
          saved = await run(request, scope);
        expect(saved).toMatchObject({ outcome: 'saved' });
        if (saved.outcome !== 'saved') throw new Error(JSON.stringify(saved));
        expect(await run(request, scope)).toEqual(saved);
        expect(embedding.embed).toHaveBeenCalledTimes(1);
        const target = await readFirestoreOwnerEditorGraphScope(
          store,
          ownerId,
          saved.ids.relationId!,
        );
        expect(
          await run({
            version: 1,
            intent: 'apply',
            command: 'correct_owner_family_relationship',
            operationId: randomUUID(),
            targetRelationId: saved.ids.relationId!,
            expectedTargetRevision: target!.revision,
            replacement: {
              ...familyFields(request),
              predicate: 'partner_of',
              timing: 'past',
              validity: { validFrom: null, validUntil: null },
            },
          }),
        ).toMatchObject({ outcome: 'saved' });
        const source = await store.doc('memories', saved.ids.memoryId!).get();
        expect(source.get('validUntil').toDate().toISOString()).toBe('2024-03-01T00:00:00.000Z');
        expect(source.get('supersededById')).toEqual(expect.any(String));
        expect((await store.doc('contacts', alex).get()).get('trust')).toBe('unknown');
        const racer = await verifyIdentityRace({
          ownerId,
          epoch,
          domain,
          operations,
          contact: (id) => readFirestoreOwnerEditorContact(store, ownerId, id),
        });
        const rollbackBefore = await readFirestoreOwnerEditorContact(store, ownerId, racer);
        if (!rollbackBefore) throw new Error('Missing rollback contact');
        const rollbackRequest: OwnerEditorApply = {
          version: 1,
          intent: 'apply',
          command: 'update_person_identity',
          operationId: randomUUID(),
          contactId: racer,
          expectedContactRevision: rollbackBefore.revision,
          name: 'Must rollback FS',
          aliases: [],
        };
        const rollbackScope = issued(ownerId, epoch, rollbackRequest);
        const faultDomain = createOwnerEditorDomain({
          storage: createFirestoreOwnerEditorDomainStorage(
            failFirestoreTerminalReceipt(store),
            ownerId,
            space,
          ),
          router: embedding,
        });
        expect(
          await applyOwnerEditorCommand({
            request: checked(rollbackRequest),
            scope: rollbackScope,
            operations,
            domain: faultDomain,
          }),
        ).toMatchObject({ outcome: 'outcome_unknown', authority: 'unresolved' });
        expect(await readFirestoreOwnerEditorContact(store, ownerId, racer)).toEqual(
          rollbackBefore,
        );
        expect((await operations.lookup(rollbackScope, new Date())).operation?.status).toBe(
          'preparing',
        );
        await verifyNameRaces({
          ownerId,
          epoch,
          domain,
          operations,
          contact: (id) => readFirestoreOwnerEditorContact(store, ownerId, id),
          names: async () =>
            (await store.collection('contacts').get()).docs.map((doc) => String(doc.get('name'))),
        });

        await verifyRetiredWorkers({
          ownerId,
          epoch,
          domain,
          operations,
          rotate: () => rotateFirestoreOwnerEditorEpoch(store, ownerId, true),
          erase: async () => {
            const erasure = new FirestorePrivacyErasureRepository(store, ownerId);
            await erasure.erase();
            await erasure.complete();
          },
          context: () => readFirestoreOwnerEditorIssuanceContext(store, ownerId),
          count: async () => (await store.collection('contacts').get()).size,
          receiptCount: async () => (await store.collection('ownerEditorOperations').get()).size,
          hasReceipt: async (scope) =>
            (await store.doc('ownerEditorOperations', ownerEditorOperationId(scope)).get()).exists,
        });
      } finally {
        await disposeStore(store);
      }
    }, 60000);
  },
);
