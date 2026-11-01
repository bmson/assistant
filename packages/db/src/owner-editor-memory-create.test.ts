import { createHash, randomUUID } from 'node:crypto';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorScope,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  commitPostgresOwnerMemoryCreation,
  readPostgresOwnerMemoryCreationTarget,
} from './owner-editor-memory-create.js';
import { postgresOwnerEditorContact } from './owner-editor-people.js';
import { createPostgresOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { createPostgresProfileMemoryManagementRepository } from './profile-memory-management-repository.js';
import {
  agents,
  contacts,
  maintenanceCursors,
  memories,
  memoryTombstones,
  ownerCard,
  ownerEditorOperations,
} from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const enabled = Boolean(process.env.ASSISTANT_TEST_TARGET_TOKEN);
const contentHash = (content: string) => createHash('sha256').update(content).digest('hex');

describe.skipIf(!enabled)('PostgreSQL owner-editor person-note creation', () => {
  let db: Db;
  let ownerId: string;
  const contactIds: string[] = [];
  let epoch: string;
  let priorCard: { content: string; compiledAt: Date } | null;
  let priorEpochCursor: { cursor: string | null; updatedAt: Date } | null;
  let priorPrivacyGeneration: { cursor: string | null; updatedAt: Date } | null;
  const hashes: string[] = [];
  const operationIds: string[] = [];

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
    db = createDb(databaseUrl, { max: 8 });
    const owners = await db.select({ id: agents.id }).from(agents).limit(2);
    if (owners.length !== 1 || !owners[0])
      throw new Error('Expected exactly one isolated test owner.');
    ownerId = owners[0].id;
    priorEpochCursor =
      (
        await db
          .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, `owner-editor-epoch:${ownerId}`))
          .limit(1)
      )[0] ?? null;
    priorPrivacyGeneration =
      (
        await db
          .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${ownerId}`))
          .limit(1)
      )[0] ?? null;
    priorCard =
      (
        await db
          .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
          .from(ownerCard)
          .where(eq(ownerCard.id, 1))
          .limit(1)
      )[0] ?? null;
  });

  afterAll(async () => {
    if (!db) return;
    if (ownerId) {
      if (hashes.length) {
        for (const hash of hashes)
          await db.delete(memoryTombstones).where(eq(memoryTombstones.contentHash, hash));
        await db
          .delete(memories)
          .where(and(eq(memories.agentId, ownerId), inArray(memories.contentHash, hashes)));
      }
      if (operationIds.length)
        await db
          .delete(ownerEditorOperations)
          .where(
            and(
              eq(ownerEditorOperations.ownerId, ownerId),
              inArray(ownerEditorOperations.operationId, operationIds),
            ),
          );
      if (contactIds.length) await db.delete(contacts).where(inArray(contacts.id, contactIds));
      if (epoch && priorEpochCursor)
        await db
          .update(maintenanceCursors)
          .set(priorEpochCursor)
          .where(eq(maintenanceCursors.name, `owner-editor-epoch:${ownerId}`));
      else if (epoch)
        await db
          .delete(maintenanceCursors)
          .where(eq(maintenanceCursors.name, `owner-editor-epoch:${ownerId}`));
      if (epoch && priorPrivacyGeneration)
        await db
          .update(maintenanceCursors)
          .set(priorPrivacyGeneration)
          .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${ownerId}`));
      else if (epoch)
        await db
          .delete(maintenanceCursors)
          .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${ownerId}`));
      if (priorCard)
        await db
          .insert(ownerCard)
          .values({ id: 1, ...priorCard })
          .onConflictDoUpdate({ target: ownerCard.id, set: priorCard });
      else await db.delete(ownerCard).where(eq(ownerCard.id, 1));
    }
    await db.$client.end({ timeout: 5 });
  });

  async function prepareCase(
    content: string,
    reuse?: { contactId: string; epoch: string },
    options?: {
      subjectContactId?: string;
      subjectTrust?: string;
      createSubject?: boolean;
      allowNoTarget?: boolean;
    },
  ) {
    const now = new Date();
    const contactId = options?.subjectContactId ?? reuse?.contactId ?? randomUUID();
    const epochId = reuse?.epoch ?? randomUUID();
    epoch = epochId;
    const operationId = randomUUID();
    operationIds.push(operationId);
    const hash = contentHash(content);
    hashes.push(hash);
    if (options?.createSubject ?? !reuse) {
      const [existing] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (!existing) {
        contactIds.push(contactId);
        await db.insert(contacts).values({
          id: contactId,
          name: `Test ${contactId}`,
          aliases: [],
          emails: [],
          phones: [],
          relationship: '',
          trust: options?.subjectTrust ?? 'known',
          identityAuthority: 'owner',
          notes: '',
        });
      }
    }
    await db
      .insert(maintenanceCursors)
      .values({
        name: `owner-editor-epoch:${ownerId}`,
        cursor: JSON.stringify({
          ownerId,
          epoch: epochId,
          ready: true,
          privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        }),
      })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor: sqlEpochCursor(ownerId, epochId) },
      });
    const scope: OwnerEditorScope = {
      ownerId,
      epoch: epochId,
      privacyGeneration: null,
      command: 'create_owner_memory',
      operationId,
      targetId: contactId,
      sessionDigest: 'a'.repeat(64),
      nonce: randomUUID(),
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 600_000,
    };
    const operations = createPostgresOwnerEditorOperationRepository(db);
    const reservation = await operations.reserve(scope, 'b'.repeat(64), now);
    if (reservation.kind !== 'claimed') throw new Error('Could not reserve isolated operation.');
    const target = await readPostgresOwnerMemoryCreationTarget(db, ownerId, contactId, hash, scope);
    const rawSubject = target ? null : await postgresOwnerEditorContact(db, ownerId, contactId);
    if (!target && (!options?.allowNoTarget || !rawSubject))
      throw new Error('Creation target was not readable.');
    const prepared = {
      memoryId: randomUUID(),
      retrievalRevision: randomUUID(),
      subjectContactId: contactId,
      expectedSubjectRevision: target?.subjectRevision ?? rawSubject?.revision ?? '',
      content,
      contentHash: hash,
      domain: 'relationships',
      importance: 3,
      pinned: false,
      embedding: [1, ...Array(1535).fill(0)],
      embeddingSpaceKey: embeddingSpaceIdentityKey({
        provider: 'test',
        model: 'unit',
        dimensions: 1536,
        revision: '1',
      }),
    };
    return {
      scope,
      claim: reservation.claim,
      prepared,
      operations,
      now,
      contactId,
      epoch: epochId,
    };
  }

  it('commits saved manual memory and returns its same receipt to two same-operation contenders', async () => {
    const f = await prepareCase(`Atomic person note ${randomUUID()}`);
    const contenders = await Promise.allSettled([
      commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now),
      commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now),
    ]);
    expect(contenders).toHaveLength(2);
    expect(
      contenders.some(
        (result) =>
          result.status === 'fulfilled' &&
          result.value.outcome === 'saved' &&
          result.value.ids?.memoryId === f.prepared.memoryId,
      ),
    ).toBe(true);
    const [saved] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, f.prepared.memoryId))
      .limit(1);
    expect(saved).toMatchObject({
      agentId: ownerId,
      subjectContactId: f.prepared.subjectContactId,
      source: 'manual',
      originTrust: 'owner',
      ownerConfirmed: true,
      kind: 'fact',
      category: 'knowledge',
      contentHash: f.prepared.contentHash,
    });
    expect(
      (
        await db
          .select({ content: ownerCard.content })
          .from(ownerCard)
          .where(eq(ownerCard.id, 1))
          .limit(1)
      )[0]?.content,
    ).toBe('');
    const receipt = await f.operations.lookup(f.scope, f.now);
    expect(receipt.reply).toMatchObject({
      outcome: 'saved',
      ids: { memoryId: f.prepared.memoryId },
    });
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, f.prepared.contentHash)),
    ).toHaveLength(1);
  });

  it('resolves a response lost after commit from the original receipt without a second note', async () => {
    const f = await prepareCase(`Lost reply note ${randomUUID()}`);
    const clientRequest = async () => {
      await commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now);
      throw new Error('simulated response lost after committed transaction');
    };
    await expect(clientRequest()).rejects.toThrow(
      'simulated response lost after committed transaction',
    );
    const recovered = await f.operations.lookup(f.scope, f.now);
    expect(recovered.reply).toMatchObject({
      outcome: 'saved',
      ids: { memoryId: f.prepared.memoryId },
    });
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, f.prepared.contentHash)),
    ).toHaveLength(1);
  });

  it('rejects an independent same-content operation instead of adopting the matching memory', async () => {
    const content = `Shared note ${randomUUID()}`;
    const first = await prepareCase(content);
    const firstReply = await commitPostgresOwnerMemoryCreation(
      db,
      first.claim,
      first.prepared,
      first.now,
    );
    expect(firstReply).toMatchObject({ outcome: 'saved' });
    const second = await prepareCase(content);
    const target = await readPostgresOwnerMemoryCreationTarget(
      db,
      ownerId,
      second.prepared.subjectContactId,
      second.prepared.contentHash,
      second.scope,
    );
    expect(target?.status).toBe('duplicate');
    const secondReply = await commitPostgresOwnerMemoryCreation(
      db,
      second.claim,
      second.prepared,
      second.now,
    );
    expect(secondReply).toMatchObject({ outcome: 'conflict' });
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, first.prepared.contentHash)),
    ).toHaveLength(1);
  });

  it('serializes two independent same-content contenders to at most one saved note', async () => {
    const content = `Contended note ${randomUUID()}`;
    const first = await prepareCase(content);
    const second = await prepareCase(content, { contactId: first.contactId, epoch: first.epoch });
    const outcomes = await Promise.allSettled([
      commitPostgresOwnerMemoryCreation(db, first.claim, first.prepared, first.now),
      commitPostgresOwnerMemoryCreation(db, second.claim, second.prepared, second.now),
    ]);
    const replies = outcomes.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(replies.filter((reply) => reply.outcome === 'saved')).toHaveLength(1);
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, first.prepared.contentHash)),
    ).toHaveLength(1);
    // A serialization failure leaves its exact original operation unresolved; it never creates
    // a fresh operation or adopts the successful competitor's memory ID.
    expect(outcomes).toHaveLength(2);
  });

  it('does not resurrect a hash when forgetting the prior matching memory races the create', async () => {
    const content = `Forget race note ${randomUUID()}`;
    const first = await prepareCase(content);
    const prior = await createPostgresProfileMemoryManagementRepository(db, ownerId).create({
      content,
      contentHash: first.prepared.contentHash,
      embedding: first.prepared.embedding,
      embeddingSpaceKey: first.prepared.embeddingSpaceKey,
      importance: 3,
      pinned: false,
      subjectContactId: first.prepared.subjectContactId,
      domain: 'relationships',
    });
    if (prior.status !== 'updated') throw new Error('Could not create forget-race fixture.');
    const outcomes = await Promise.allSettled([
      commitPostgresOwnerMemoryCreation(db, first.claim, first.prepared, first.now),
      createPostgresProfileMemoryManagementRepository(db, ownerId).forget(
        prior.memory.id,
        'owner_forget',
      ),
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: { status: 'updated' } });
    if (outcomes[0]?.status === 'fulfilled')
      expect(outcomes[0].value).toMatchObject({ outcome: 'conflict' });
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, first.prepared.contentHash)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ hash: memoryTombstones.contentHash })
        .from(memoryTombstones)
        .where(eq(memoryTombstones.contentHash, first.prepared.contentHash)),
    ).toHaveLength(1);
  });

  it('rejects a forgotten hash and never restores a duplicate from another note', async () => {
    const f = await prepareCase(`Forgotten atomic note ${randomUUID()}`);
    await db
      .insert(memoryTombstones)
      .values({ contentHash: f.prepared.contentHash, reason: 'owner_forget' });
    const reply = await commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now);
    expect(reply).toMatchObject({ outcome: 'conflict' });
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, f.prepared.contentHash)),
    ).toHaveLength(0);
  });

  it('rejects the exact old native subject revision before inserting a note', async () => {
    const f = await prepareCase(`Stale subject note ${randomUUID()}`);
    await db
      .update(contacts)
      .set({
        name: `Changed ${f.prepared.subjectContactId}`,
        updatedAt: new Date('2099-01-01T00:00:00.000Z'),
      })
      .where(eq(contacts.id, f.prepared.subjectContactId));
    const reply = await commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now);
    expect(reply).toMatchObject({ outcome: 'conflict' });
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, f.prepared.contentHash)),
    ).toHaveLength(0);
  });

  it('refuses a claim after epoch or privacy-generation retirement', async () => {
    const f = await prepareCase(`Retired scope note ${randomUUID()}`);
    await db
      .update(maintenanceCursors)
      .set({ cursor: sqlEpochCursor(ownerId, randomUUID()) })
      .where(eq(maintenanceCursors.name, `owner-editor-epoch:${ownerId}`));
    const retiredEpoch = await commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now);
    expect(retiredEpoch).not.toMatchObject({ outcome: 'saved' });

    const g = await prepareCase(`Retired privacy note ${randomUUID()}`);
    await db
      .insert(maintenanceCursors)
      .values({
        name: `privacy-erasure-generation:${ownerId}`,
        cursor: randomUUID(),
      })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor: randomUUID() },
      });
    try {
      const retiredPrivacy = await commitPostgresOwnerMemoryCreation(
        db,
        g.claim,
        g.prepared,
        g.now,
      );
      expect(retiredPrivacy).not.toMatchObject({ outcome: 'saved' });
      expect(
        await db
          .select({ id: memories.id })
          .from(memories)
          .where(inArray(memories.contentHash, [f.prepared.contentHash, g.prepared.contentHash])),
      ).toHaveLength(0);
    } finally {
      if (priorPrivacyGeneration)
        await db
          .update(maintenanceCursors)
          .set(priorPrivacyGeneration)
          .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${ownerId}`));
      else
        await db
          .delete(maintenanceCursors)
          .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${ownerId}`));
    }
  });

  it('keeps a changed claim lease unresolved without inserting its prepared note', async () => {
    const f = await prepareCase(`Lease changed note ${randomUUID()}`);
    await db
      .update(ownerEditorOperations)
      .set({ claimToken: randomUUID() })
      .where(eq(ownerEditorOperations.operationId, f.scope.operationId));
    const reply = await commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now);
    expect(reply).toMatchObject({ outcome: 'outcome_unknown' });
    expect(
      await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.contentHash, f.prepared.contentHash)),
    ).toHaveLength(0);
  });

  it('excludes self contacts and owner-trust contacts during preflight and commit', async () => {
    const [existingSelf] = await db
      .select({ row: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
      .from(contacts)
      .where(eq(contacts.id, ownerId))
      .limit(1);
    const previousTrust = existingSelf?.row.trust;
    const previousUpdatedAt = existingSelf?.row.updated_at;
    if (existingSelf?.row.trust === 'owner')
      await db.execute(
        sql`UPDATE contacts SET trust = 'known', updated_at = now() WHERE id = ${ownerId}`,
      );

    const cardBefore =
      (
        await db
          .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
          .from(ownerCard)
          .where(eq(ownerCard.id, 1))
          .limit(1)
      )[0] ?? null;
    try {
      const self = await prepareCase(`Self note ${randomUUID()}`, undefined, {
        subjectContactId: ownerId,
        subjectTrust: 'known',
        allowNoTarget: true,
      });
      expect(
        await readPostgresOwnerMemoryCreationTarget(
          db,
          ownerId,
          ownerId,
          self.prepared.contentHash,
          self.scope,
        ),
      ).toBeNull();
      expect(
        await commitPostgresOwnerMemoryCreation(db, self.claim, self.prepared, self.now),
      ).toMatchObject({
        outcome: 'conflict',
        reason: 'person_note_requires_non_owner_subject',
      });

      const ownerFact = await prepareCase(`Owner-trust note ${randomUUID()}`, undefined, {
        subjectContactId: randomUUID(),
        subjectTrust: 'owner',
        allowNoTarget: true,
      });
      expect(
        await readPostgresOwnerMemoryCreationTarget(
          db,
          ownerId,
          ownerFact.prepared.subjectContactId,
          ownerFact.prepared.contentHash,
          ownerFact.scope,
        ),
      ).toBeNull();
      expect(
        await commitPostgresOwnerMemoryCreation(
          db,
          ownerFact.claim,
          ownerFact.prepared,
          ownerFact.now,
        ),
      ).toMatchObject({
        outcome: 'conflict',
        reason: 'person_note_requires_non_owner_subject',
      });
      expect(
        await db
          .select({ id: memories.id })
          .from(memories)
          .where(
            inArray(memories.contentHash, [
              self.prepared.contentHash,
              ownerFact.prepared.contentHash,
            ]),
          ),
      ).toHaveLength(0);
      const cardAfter =
        (
          await db
            .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
            .from(ownerCard)
            .where(eq(ownerCard.id, 1))
            .limit(1)
        )[0] ?? null;
      expect(cardAfter).toEqual(cardBefore);
    } finally {
      if (existingSelf && previousTrust !== undefined && typeof previousUpdatedAt === 'string')
        await db.execute(
          sql`UPDATE contacts SET trust = ${previousTrust}, updated_at = ${previousUpdatedAt}::timestamptz WHERE id = ${ownerId}`,
        );
    }
  });

  it('rolls back the inserted note and card invalidation when the terminal receipt update fails', async () => {
    const f = await prepareCase(`Rollback note ${randomUUID()}`);
    const beforeCard =
      (
        await db
          .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
          .from(ownerCard)
          .where(eq(ownerCard.id, 1))
          .limit(1)
      )[0] ?? null;
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION owner_editor_create_receipt_test_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.command = 'create_owner_memory' AND NEW.status = 'committed' THEN
          RAISE EXCEPTION 'injected receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(
      sql`CREATE TRIGGER owner_editor_create_receipt_test_failure BEFORE UPDATE ON owner_editor_operations FOR EACH ROW EXECUTE FUNCTION owner_editor_create_receipt_test_failure()`,
    );
    try {
      await expect(
        commitPostgresOwnerMemoryCreation(db, f.claim, f.prepared, f.now),
      ).rejects.toThrow('injected receipt failure');
      expect(
        await db
          .select({ id: memories.id })
          .from(memories)
          .where(eq(memories.id, f.prepared.memoryId)),
      ).toHaveLength(0);
      const afterCard =
        (
          await db
            .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
            .from(ownerCard)
            .where(eq(ownerCard.id, 1))
            .limit(1)
        )[0] ?? null;
      expect(afterCard).toEqual(beforeCard);
      expect(
        await db
          .select({ status: ownerEditorOperations.status })
          .from(ownerEditorOperations)
          .where(eq(ownerEditorOperations.operationId, f.scope.operationId)),
      ).toMatchObject([{ status: 'preparing' }]);
    } finally {
      await db.execute(
        sql`DROP TRIGGER IF EXISTS owner_editor_create_receipt_test_failure ON owner_editor_operations`,
      );
      await db.execute(sql`DROP FUNCTION IF EXISTS owner_editor_create_receipt_test_failure()`);
    }
  });
});

function sqlEpochCursor(ownerId: string, epoch: string) {
  return JSON.stringify({
    ownerId,
    epoch,
    ready: true,
    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
  });
}
