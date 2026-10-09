import { randomUUID } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileLibraryQueries } from '../packages/application/src/profile/library-queries.js';
import { GRAPH_EXTRACTION_VERSION } from '../packages/core/src/memory/knowledge-graph.js';
import {
  agents,
  contacts,
  createDb,
  createPostgresProfileLibraryRepository,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '../packages/db/src/index.js';
import { FirestoreProfileLibraryRepository } from '../packages/firestore/src/profile-library.js';
import { createInstallationStore } from '../packages/firestore/src/store.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('profile library PG/Firestore parity', () => {
  const ownerId = randomUUID();
  const foreignId = randomUUID();
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const foreignSubject = randomUUID();
  const preciseEarly = randomUUID();
  const preciseLate = randomUUID();
  const preciseSpaceKey = 'a'.repeat(64);
  const quarantineId = randomUUID();
  const expiredId = randomUUID();
  const foreignMemoryId = randomUUID();
  const graphSubjectId = randomUUID();
  const graphObjectId = randomUUID();
  const graphRelationId = randomUUID();
  const fillerIds = Array.from({ length: 405 }, () => randomUUID());
  const allMemoryIds = [
    preciseEarly,
    preciseLate,
    quarantineId,
    expiredId,
    foreignMemoryId,
    ...fillerIds,
  ];
  let db: Db;
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    databaseId: '(default)',
    installationId: `profile-library-${randomUUID()}`,
  });

  const contactRows = [
    { id: subjectA, name: 'Alice', trust: 'known' },
    { id: subjectB, name: 'Bob', trust: 'known' },
    { id: foreignSubject, name: 'Foreign', trust: 'known' },
  ];
  const baseMemory = {
    expiresAt: null,
    embedding: null,
    sourceTaskId: null,
    kind: 'fact',
    confidence: '0.90',
    goalId: null,
    originTrust: 'owner',
    category: 'knowledge',
    importance: 1,
    quarantined: false,
    domain: 'work',
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: false,
    pinned: false,
    source: 'gmail',
    lastAccessedAt: null,
    lastConsolidatedAt: null,
  } as const;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await db.insert(agents).values([
      {
        id: ownerId,
        name: 'Profile owner',
        email: `${ownerId}@example.com`,
        workspacePrefix: `workspace/${ownerId}`,
      },
      {
        id: foreignId,
        name: 'Foreign owner',
        email: `${foreignId}@example.com`,
        workspacePrefix: `workspace/${foreignId}`,
      },
    ]);
    await db.insert(contacts).values(contactRows);
    const at = new Date('2026-09-19T12:00:00.123Z');
    const rows = [
      {
        ...baseMemory,
        id: preciseEarly,
        agentId: ownerId,
        subjectContactId: subjectA,
        content: 'Precise early needle',
        contentHash: 'early',
        pinned: true,
        ownerConfirmed: true,
        importance: 5,
        createdAt: at,
      },
      {
        ...baseMemory,
        id: preciseLate,
        agentId: ownerId,
        subjectContactId: subjectB,
        content: 'Precise late',
        contentHash: 'late',
        embeddingSpaceKey: preciseSpaceKey,
        embedding: Array.from({ length: 1536 }, () => 0.25),
        pinned: true,
        ownerConfirmed: true,
        importance: 5,
        createdAt: at,
      },
      {
        ...baseMemory,
        id: quarantineId,
        agentId: ownerId,
        subjectContactId: subjectA,
        content: 'Review me',
        contentHash: 'review',
        quarantined: true,
        createdAt: new Date('2026-09-18T00:00:00Z'),
      },
      {
        ...baseMemory,
        id: expiredId,
        agentId: ownerId,
        subjectContactId: subjectA,
        content: 'Expired',
        contentHash: 'expired',
        expiresAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        ...baseMemory,
        id: foreignMemoryId,
        agentId: foreignId,
        subjectContactId: foreignSubject,
        content: 'Foreign private memory',
        contentHash: 'foreign',
        pinned: true,
        importance: 5,
        createdAt: new Date('2026-09-20T00:00:00Z'),
      },
      ...fillerIds.map((id, index) => ({
        ...baseMemory,
        id,
        agentId: ownerId,
        subjectContactId: subjectA,
        content: `Filler ${index}`,
        contentHash: `filler-${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)),
      })),
    ];
    await db.insert(memories).values(rows);
    await db.execute(
      sql`update memories set created_at = '2026-09-19T12:00:00.123456Z'::timestamptz where id = ${preciseEarly}`,
    );
    await db.execute(
      sql`update memories set created_at = '2026-09-19T12:00:00.123789Z'::timestamptz where id = ${preciseLate}`,
    );
    await db.insert(knowledgeGraphEntities).values([
      {
        id: graphSubjectId,
        agentId: ownerId,
        canonicalKey: 'topic:precise-subject',
        label: 'Precise subject',
        kind: 'topic',
      },
      {
        id: graphObjectId,
        agentId: ownerId,
        canonicalKey: 'topic:precise-object',
        label: 'Precise object',
        kind: 'topic',
      },
    ]);
    await db.insert(knowledgeGraphSources).values({
      memoryId: preciseLate,
      contentHash: 'late',
      status: 'ready',
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });
    await db.insert(knowledgeGraphRelations).values({
      id: graphRelationId,
      agentId: ownerId,
      subjectEntityId: graphSubjectId,
      objectEntityId: graphObjectId,
      sourceMemoryId: preciseLate,
      predicate: 'relates_to',
      sourceFingerprint: 'precise-relation',
      ordinal: 0,
      evidenceQuote: '',
    });

    const batch = store.db.batch();
    for (const contact of contactRows) {
      batch.set(store.doc('contacts', contact.id), {
        ...contact,
        aliases: [],
        emails: [],
        phones: [],
        relationship: '',
        notes: '',
        createdAt: at,
        updatedAt: at,
      });
    }
    for (const row of rows) {
      const precise =
        row.id === preciseEarly
          ? new Timestamp(Math.floor(at.getTime() / 1000), 123_456_000)
          : row.id === preciseLate
            ? new Timestamp(Math.floor(at.getTime() / 1000), 123_789_000)
            : row.createdAt;
      const firestoreRow =
        row.id === preciseLate
          ? { ...row, embeddingSpaceKey: null, embeddingSpace: preciseSpaceKey }
          : row;
      batch.set(store.doc('memories', row.id), { ...firestoreRow, createdAt: precise });
    }
    batch.set(store.doc('knowledgeGraphSources', preciseLate), {
      memoryId: preciseLate,
      contentHash: 'late',
      status: 'ready',
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });
    batch.set(store.doc('knowledgeGraphRelations', graphRelationId), {
      id: graphRelationId,
      agentId: ownerId,
      subjectEntityId: graphSubjectId,
      objectEntityId: graphObjectId,
      sourceMemoryId: preciseLate,
      predicate: 'relates_to',
      sourceFingerprint: 'precise-relation',
      ordinal: 0,
      evidenceQuote: '',
      reviewStatus: 'unreviewed',
    });
    await batch.commit();
  });

  afterAll(async () => {
    await db
      .delete(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.id, [graphRelationId]));
    await db
      .delete(knowledgeGraphSources)
      .where(inArray(knowledgeGraphSources.memoryId, [preciseLate]));
    await db
      .delete(knowledgeGraphEntities)
      .where(inArray(knowledgeGraphEntities.id, [graphSubjectId, graphObjectId]));
    await db.delete(memories).where(inArray(memories.id, allMemoryIds));
    await db.delete(contacts).where(inArray(contacts.id, [subjectA, subjectB, foreignSubject]));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignId]));
    await db.$client.end();
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  it('matches stable pages, counts, filters, precision order, and owner scope', async () => {
    const pg = profileLibraryQueries(createPostgresProfileLibraryRepository(db), ownerId);
    const firestore = profileLibraryQueries(new FirestoreProfileLibraryRepository(store), ownerId);
    const input = {
      state: 'in-use' as const,
      filter: 'all' as const,
      query: '',
      page: 1,
      pageSize: 200,
    };
    const [pgFirst, fsFirst, pgSecond, fsSecond] = await Promise.all([
      pg.list(input),
      firestore.list(input),
      pg.list({ ...input, page: 2 }),
      firestore.list({ ...input, page: 2 }),
    ]);
    expect(fsFirst.total).toBe(407);
    expect(fsFirst.total).toBe(pgFirst.total);
    expect(fsFirst.rows.map((row) => row.memory.id)).toEqual(
      pgFirst.rows.map((row) => row.memory.id),
    );
    expect(fsSecond.rows.map((row) => row.memory.id)).toEqual(
      pgSecond.rows.map((row) => row.memory.id),
    );
    expect(fsFirst.rows.slice(0, 2).map((row) => row.memory.id)).toEqual([
      preciseLate,
      preciseEarly,
    ]);
    expect(fsFirst.rows.some((row) => row.memory.id === foreignMemoryId)).toBe(false);
    expect(fsFirst.rows.find((row) => row.memory.id === preciseLate)?.connectionCount).toBe(1);

    await expect(firestore.listFilters()).resolves.toEqual(await pg.listFilters());
    await expect(
      firestore.list({ ...input, query: 'needle', domain: 'work', subjectId: subjectA }),
    ).resolves.toEqual(
      await pg.list({ ...input, query: 'needle', domain: 'work', subjectId: subjectA }),
    );
    await expect(firestore.list({ ...input, state: 'review', source: 'gmail' })).resolves.toEqual(
      await pg.list({ ...input, state: 'review', source: 'gmail' }),
    );
    await expect(
      firestore.list({ ...input, filter: 'verified', connectivity: 'unconnected' }),
    ).resolves.toEqual(
      await pg.list({ ...input, filter: 'verified', connectivity: 'unconnected' }),
    );
    const connected = await firestore.list({ ...input, connectivity: 'connected' });
    expect(connected.rows.map((row) => row.memory.id)).toEqual([preciseLate]);
    expect(connected).toEqual(await pg.list({ ...input, connectivity: 'connected' }));
  });
});
