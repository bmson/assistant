import { randomUUID } from 'node:crypto';
import {
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorReceipt,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnerEditorReaderFixture } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { createDb, type Db } from './client.js';
import {
  erasePostgresEditorReceiptPage,
  rotateExistingPostgresEditorForErasure,
} from './owner-editor-lifecycle.js';
import { createPostgresOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { pruneExpiredPostgresOwnerEditorReceipts } from './owner-editor-retention.js';
import { agents, maintenanceCursors, memories, ownerEditorOperations } from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const enabled = Boolean(process.env.ASSISTANT_TEST_TARGET_TOKEN);
const replayMs = 24 * 60 * 60 * 1000;
const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;
const generationName = (ownerId: string) => `privacy-erasure-generation:${ownerId}`;

describe.skipIf(!enabled)('PostgreSQL retained owner-editor reader qualification', () => {
  let db: Db;
  let ownerId: string;
  let privacyGeneration: string | null;
  let previousEpoch: { cursor: string | null; updatedAt: Date } | null;
  const testEpochs: string[] = [];

  beforeAll(async () => {
    if (process.env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS !== '1')
      throw new Error('Run this suite through the isolated test environment.');
    const databaseUrl = process.env.DATABASE_URL;
    assertAllocatedTestTarget({
      databaseUrl,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    });
    if (!databaseUrl) throw new Error('Allocated test database URL is unavailable.');
    db = createDb(databaseUrl, { max: 4 });
    const owners = await db.select({ id: agents.id }).from(agents).limit(2);
    if (owners.length !== 1 || !owners[0])
      throw new Error('Expected exactly one isolated test owner.');
    ownerId = owners[0].id;
    const existingOperations = await db
      .select({ id: ownerEditorOperations.id })
      .from(ownerEditorOperations)
      .where(eq(ownerEditorOperations.ownerId, ownerId))
      .limit(1);
    if (existingOperations.length)
      throw new Error('Allocated reader-qualification database must start without owner receipts.');
    const [generation, epoch] = await Promise.all([
      db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, generationName(ownerId)))
        .limit(1),
      db
        .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, epochName(ownerId)))
        .limit(1),
    ]);
    privacyGeneration = generation[0]?.cursor ?? null;
    previousEpoch = epoch[0] ?? null;
  });

  afterAll(async () => {
    if (!db) return;
    if (ownerId && testEpochs.length)
      await db
        .delete(ownerEditorOperations)
        .where(
          and(
            eq(ownerEditorOperations.ownerId, ownerId),
            inArray(ownerEditorOperations.epoch, testEpochs),
          ),
        );
    if (ownerId && testEpochs.length) {
      if (previousEpoch)
        await db
          .update(maintenanceCursors)
          .set(previousEpoch)
          .where(eq(maintenanceCursors.name, epochName(ownerId)));
      else
        await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, epochName(ownerId)));
    }
    await db.$client.end({ timeout: 5 });
  });

  async function context(ready = true) {
    const epoch = randomUUID();
    testEpochs.push(epoch);
    await db
      .insert(maintenanceCursors)
      .values({
        name: epochName(ownerId),
        cursor: JSON.stringify({
          ownerId,
          epoch,
          ready,
          privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration),
        }),
      })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: {
          cursor: JSON.stringify({
            ownerId,
            epoch,
            ready,
            privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration),
          }),
          updatedAt: new Date(),
        },
      });
    const now = new Date();
    return { epoch, now, fixtures: readerFixtures({ ownerId, epoch, now, privacyGeneration }) };
  }

  async function seed(fixtures: readonly OwnerEditorReaderFixture[]) {
    await db.insert(ownerEditorOperations).values(fixtures.map(({ record }) => record));
  }

  it('reads mixed old and create receipts, leaves live/stale claims unknown, and abandons only with fresh proof', async () => {
    const { now, fixtures } = await context();
    const create = fixtures.createOwnerMemory;
    const terminal = [
      ...fixtures.oldSaved,
      create.savedRefresh,
      create.savedNoRefresh,
      create.conflict,
      create.invalid,
      create.unavailable,
      ...create.notApplied,
    ];
    await seed([...terminal, create.preparing, create.expiredPreparing]);
    const repository = createPostgresOwnerEditorOperationRepository(db);
    const memoryIdsBefore = await db.select({ id: memories.id }).from(memories);

    for (const fixture of terminal) {
      const expected = ownerEditorReceipt(fixture.record);
      const lookup = await repository.lookup(fixture.scope, now);
      expect(lookup.reply).toEqual(expected);
      expect(lookup.operation).toEqual(fixture.record);
      expect(
        await repository.reconcile(
          {
            scope: fixture.scope,
            requestHash: fixture.record.requestHash,
            claimIdentityDigest: 'd'.repeat(64),
            statusVersion: fixture.record.statusVersion,
            issuedAt: now.getTime(),
            expiresAt: now.getTime() + 120_000,
          },
          now,
        ),
      ).toEqual(expected);
    }

    const liveLookup = await repository.lookup(create.preparing.scope, now);
    expect(liveLookup.reply).toMatchObject({ authority: 'unresolved', reason: 'preparing' });
    expect(await repository.reconcile(create.preparing.proof, now)).toMatchObject({
      authority: 'unresolved',
      reason: 'preparing',
    });

    const staleProof = {
      ...create.expiredPreparing.proof,
      statusVersion: create.expiredPreparing.proof.statusVersion + 1,
    };
    expect(await repository.reconcile(staleProof, now)).toMatchObject({
      authority: 'unresolved',
      reason: 'proof_changed',
    });
    expect((await repository.lookup(create.expiredPreparing.scope, now)).reply).toMatchObject({
      authority: 'unresolved',
      reason: 'preparing',
    });

    const abandoned = await repository.reconcile(create.expiredPreparing.proof, now);
    expect(abandoned).toMatchObject({
      authority: 'operation_receipt',
      command: 'create_owner_memory',
      outcome: 'not_applied',
      reason: 'claim_abandoned',
    });
    expect((await repository.lookup(create.expiredPreparing.scope, now)).reply).toEqual(abandoned);
    expect(await db.select({ id: memories.id }).from(memories)).toEqual(memoryIdsBefore);
  });

  it('prunes 65 mixed old-command and create receipts in 64-row pages', async () => {
    const { epoch, fixtures } = await context();
    const bases = [...fixtures.oldSaved, fixtures.createOwnerMemory.savedNoRefresh];
    const issuedAt = new Date(Date.now() - replayMs - 60_000);
    const aged = Array.from({ length: 65 }, (_, index) => {
      const base = bases[index % bases.length];
      if (!base) throw new Error('Missing reader receipt fixture.');
      const scope = {
        ...base.scope,
        epoch,
        operationId: randomUUID(),
        issuedAt: issuedAt.getTime(),
        expiresAt: issuedAt.getTime() + 600_000,
      };
      const record = {
        ...base.record,
        id: ownerEditorOperationId(scope),
        epoch,
        operationId: scope.operationId,
        scopeDigest: ownerEditorScopeDigest(scope),
        formIssuedAt: issuedAt,
        formExpiresAt: new Date(scope.expiresAt),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      };
      return record;
    });
    await db.insert(ownerEditorOperations).values(aged);

    expect(await pruneExpiredPostgresOwnerEditorReceipts(db, ownerId, new Date())).toBe(64);
    expect(
      await db
        .select({ id: ownerEditorOperations.id })
        .from(ownerEditorOperations)
        .where(
          and(eq(ownerEditorOperations.ownerId, ownerId), eq(ownerEditorOperations.epoch, epoch)),
        ),
    ).toHaveLength(1);
    expect(await pruneExpiredPostgresOwnerEditorReceipts(db, ownerId, new Date())).toBe(1);
    expect(
      await db
        .select({ id: ownerEditorOperations.id })
        .from(ownerEditorOperations)
        .where(
          and(eq(ownerEditorOperations.ownerId, ownerId), eq(ownerEditorOperations.epoch, epoch)),
        ),
    ).toHaveLength(0);
  });

  it.each([false, true] as const)(
    'rotates privacy-bound epoch before erasing mixed receipts while preserving ready=%s',
    async (priorReady) => {
      const { epoch, fixtures } = await context(priorReady);
      const create = fixtures.createOwnerMemory;
      const mixed = [...fixtures.oldSaved, create.savedRefresh, create.conflict, create.preparing];
      await seed(mixed);
      const repository = createPostgresOwnerEditorOperationRepository(db);
      if (!priorReady) {
        expect(await repository.lookup(create.savedRefresh.scope, new Date())).toMatchObject({
          reply: {
            authority: 'unresolved',
            outcome: 'outcome_unknown',
            reason: 'receipt_unavailable',
          },
        });
        const cursorRows = await db
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, epochName(ownerId)))
          .limit(1);
        const cursor = JSON.parse(cursorRows[0]?.cursor ?? 'null') as Record<string, unknown>;
        expect(cursor).toMatchObject({ ownerId, epoch, ready: false });
        await db
          .update(maintenanceCursors)
          .set({ cursor: JSON.stringify({ ...cursor, ready: true }), updatedAt: new Date() })
          .where(eq(maintenanceCursors.name, epochName(ownerId)));
        expect(await repository.lookup(create.savedRefresh.scope, new Date())).toMatchObject({
          reply: ownerEditorReceipt(create.savedRefresh.record),
        });
        await db
          .update(maintenanceCursors)
          .set({ cursor: JSON.stringify({ ...cursor, ready: false }), updatedAt: new Date() })
          .where(eq(maintenanceCursors.name, epochName(ownerId)));
        const disabledRows = await db
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, epochName(ownerId)))
          .limit(1);
        expect(JSON.parse(disabledRows[0]?.cursor ?? 'null')).toMatchObject({
          ownerId,
          epoch,
          ready: false,
        });
      } else {
        expect(await repository.lookup(create.savedRefresh.scope, new Date())).toMatchObject({
          reply: ownerEditorReceipt(create.savedRefresh.record),
        });
      }
      const nextPrivacyGeneration = String(Date.now() + 1);
      await db.transaction(async (tx) => {
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, ownerId)).for('update');
        await rotateExistingPostgresEditorForErasure(tx, ownerId, nextPrivacyGeneration);
      });
      const rotatedRows = await db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, epochName(ownerId)))
        .limit(1);
      const rotated = JSON.parse(rotatedRows[0]?.cursor ?? 'null') as {
        ownerId?: string;
        epoch?: string;
        ready?: boolean;
        privacyGenerationDigest?: string;
      };
      expect(rotated).toMatchObject({
        ownerId,
        ready: priorReady,
        privacyGenerationDigest: ownerEditorPrivacyDigest(nextPrivacyGeneration),
      });
      expect(rotated.epoch).not.toBe(epoch);
      expect(
        await createPostgresOwnerEditorOperationRepository(db).lookup(
          create.savedRefresh.scope,
          new Date(),
        ),
      ).toMatchObject({ reply: { authority: 'scope_retirement', outcome: 'voided' } });

      let done = false;
      let pageCount = 0;
      while (!done && pageCount < 3) {
        done = await db.transaction(async (tx) => {
          await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, ownerId))
            .for('update');
          return erasePostgresEditorReceiptPage(tx, ownerId);
        });
        pageCount += 1;
      }
      expect(done).toBe(true);
      const remaining = await db
        .select({ id: ownerEditorOperations.id })
        .from(ownerEditorOperations)
        .where(
          and(eq(ownerEditorOperations.ownerId, ownerId), eq(ownerEditorOperations.epoch, epoch)),
        );
      expect(remaining).toEqual([]);
    },
  );
});
