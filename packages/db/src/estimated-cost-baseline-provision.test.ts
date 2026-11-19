import { randomUUID } from 'node:crypto';
import type {
  EstimatedCostBaselineContext,
  EstimatedCostBaselineWitness,
} from '@assistant/persistence';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  applyPostgresEstimatedCostBaseline,
  inspectPostgresEstimatedCostBaseline,
  preparePostgresEstimatedCostBaseline,
  readbackPostgresEstimatedCostBaseline,
} from './estimated-cost-baseline-provision.js';
import * as schema from './schema.js';
import {
  agents,
  costReservations,
  estimatedCostBaselines,
  estimatedCostGrants,
  estimatedCostRequests,
  maintenanceCursors,
  tasks,
} from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const url = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl: url,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
});
if (!url) throw new Error('Missing isolated test database');
describe('PostgreSQL baseline provisioning', () => {
  let db: Db,
    control: Db,
    context: EstimatedCostBaselineContext,
    ownerId: string,
    reservationId: string;
  const schemaName = `baseline_test_${randomUUID().replaceAll('-', '')}`;
  const unrelatedId = randomUUID();
  beforeAll(async () => {
    control = createDb(url);
    const owners = await control.select({ id: agents.id }).from(agents);
    if (owners.length !== 1 || !owners[0]) throw new Error('Expected one owner');
    ownerId = owners[0].id;
    // Each test uses a complete independent ledger, in the already allocated
    // local disposable database. No public tables or shared rows are reset.
    await control.execute(sql`create schema ${sql.identifier(schemaName)}`);
    for (const name of [
      'agents',
      'tasks',
      'cost_reservations',
      'estimated_cost_grants',
      'estimated_cost_requests',
      'estimated_cost_baselines',
      'maintenance_cursors',
    ])
      await control.execute(
        sql`create table ${sql.identifier(schemaName)}.${sql.identifier(name)} (like public.${sql.identifier(name)} including all)`,
      );
    const client = postgres(url, { connection: { search_path: schemaName } });
    db = drizzle(client, { schema });
    const [identity] = (await db.execute(sql`select current_schema() as name`)) as unknown as {
      name: string;
    }[];
    if (identity?.name !== schemaName) throw new Error('Isolated schema binding failed');
    await db.insert(agents).values({
      id: ownerId,
      name: 'Baseline owner',
      email: `${ownerId}@baseline.invalid`,
      workspacePrefix: 'baseline-test',
    });
    // Simulate an earlier suite's unrelated active liability in the shared
    // ledger; every baseline test must succeed or fail on its own contents.
    await control.insert(costReservations).values({
      id: unrelatedId,
      source: 'model',
      estimatedUsd: '0.030000',
      status: 'held',
      description: 'baseline-isolation-control',
    });
  });
  afterAll(async () => {
    try {
      if (db) await db.$client.end();
      if (control) {
        await control.delete(costReservations).where(eq(costReservations.id, unrelatedId));
        await control.execute(sql`drop schema if exists ${sql.identifier(schemaName)} cascade`);
      }
    } finally {
      if (control) await control.$client.end();
    }
  });
  beforeEach(async () => {
    reservationId = randomUUID();
    context = {
      ownerId,
      target: {
        driver: 'postgres',
        projectId: 'synthetic',
        databaseId: new URL(url).pathname.slice(1),
        installationId: randomUUID(),
      },
      releaseSha: 'a'.repeat(40),
      now: () => new Date(),
    };
    await db.insert(costReservations).values({
      id: reservationId,
      source: 'model',
      estimatedUsd: '0.100000',
      status: 'unknown',
      createdAt: new Date(Date.now() - 86400000),
    });
  });
  afterEach(async () => {
    await db
      .delete(maintenanceCursors)
      .where(
        eq(maintenanceCursors.name, `estimated-cost-baseline:${context.target.installationId}`),
      );
    await db
      .delete(estimatedCostBaselines)
      .where(eq(estimatedCostBaselines.installationId, context.target.installationId));
    await db.delete(estimatedCostGrants);
    await db.delete(estimatedCostRequests);
    await db.delete(tasks);
    await db
      .delete(costReservations)
      .where(eq(costReservations.description, 'baseline-oversize-test'));
    await db.delete(costReservations).where(eq(costReservations.id, reservationId));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-active:${ownerId}`));
  });
  async function prepared() {
    const { censusDigest } = await inspectPostgresEstimatedCostBaseline(db, context);
    const t = Date.now(),
      witness: EstimatedCostBaselineWitness = {
        format: 1,
        operationId: randomUUID(),
        ownerId,
        target: context.target,
        releaseSha: context.releaseSha,
        cutoff: new Date(t - 1000).toISOString(),
        issuedAt: new Date(t).toISOString(),
        expiresAt: new Date(t + 300000).toISOString(),
        sourceDigest: 'b'.repeat(64),
        drainDigest: 'c'.repeat(64),
        observedCensusDigest: censusDigest,
      };
    return { witness, proposal: await preparePostgresEstimatedCostBaseline(db, context, witness) };
  }
  it('keeps unrelated active liabilities in the shared ledger untouched', async () => {
    const before = await control
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, unrelatedId));
    expect(before).toHaveLength(1);
    expect(before[0]?.status).toBe('held');
    await expect(inspectPostgresEstimatedCostBaseline(control, context)).rejects.toThrow(
      'Active reservation during baseline freeze',
    );
    const { proposal } = await prepared();
    expect(proposal.rows).toEqual([{ reservationId, estimatedMicros: 100000 }]);
    expect(
      await control.select().from(costReservations).where(eq(costReservations.id, unrelatedId)),
    ).toEqual(before);
  });
  it('creates once, reads back the same receipt, and preserves liabilities', async () => {
    const before = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reservationId));
    const { witness, proposal } = await prepared();
    expect(proposal.rows).toEqual([{ reservationId, estimatedMicros: 100000 }]);
    const receipt = await applyPostgresEstimatedCostBaseline(db, context, witness, proposal);
    expect(await applyPostgresEstimatedCostBaseline(db, context, witness, proposal)).toEqual(
      receipt,
    );
    expect(await readbackPostgresEstimatedCostBaseline(db, context, witness, proposal)).toEqual(
      receipt,
    );
    expect(
      await db.select().from(costReservations).where(eq(costReservations.id, reservationId)),
    ).toEqual(before);
  });
  it('rejects native version drift and a conflicting existing baseline', async () => {
    const { witness, proposal } = await prepared();
    await db
      .update(costReservations)
      .set({ description: 'changed' })
      .where(eq(costReservations.id, reservationId));
    await expect(
      applyPostgresEstimatedCostBaseline(db, context, witness, proposal),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(estimatedCostBaselines)
        .where(eq(estimatedCostBaselines.installationId, context.target.installationId)),
    ).toEqual([]);
    const current = await prepared();
    await db.insert(estimatedCostBaselines).values({
      installationId: context.target.installationId,
      ownerId,
      digest: 'f'.repeat(64),
      rows: [],
    });
    await expect(
      applyPostgresEstimatedCostBaseline(db, context, current.witness, current.proposal),
    ).rejects.toThrow();
  });
  it('rejects an active reservation and changed witness target', async () => {
    const { witness, proposal } = await prepared();
    await expect(
      applyPostgresEstimatedCostBaseline(
        db,
        { ...context, target: { ...context.target, databaseId: 'other' } },
        witness,
        proposal,
      ),
    ).rejects.toThrow();
    await db
      .update(costReservations)
      .set({ status: 'held' })
      .where(eq(costReservations.id, reservationId));
    await expect(
      applyPostgresEstimatedCostBaseline(db, context, witness, proposal),
    ).rejects.toThrow();
  });
  it('rejects an active privacy erasure and a changed source proof', async () => {
    const { witness, proposal } = await prepared();
    await expect(
      applyPostgresEstimatedCostBaseline(
        db,
        context,
        { ...witness, sourceDigest: 'd'.repeat(64) },
        proposal,
      ),
    ).rejects.toThrow();
    await db
      .insert(maintenanceCursors)
      .values({ name: `privacy-erasure-active:${ownerId}`, cursor: 'active' });
    await expect(
      applyPostgresEstimatedCostBaseline(db, context, witness, proposal),
    ).rejects.toThrow();
  });
  it('refuses active grant authority and keeps grant-linked liabilities protected', async () => {
    const taskId = randomUUID(),
      grantId = randomUUID(),
      operationId = randomUUID();
    await db.insert(tasks).values({ id: taskId, agentId: ownerId, type: 'adhoc' });
    await db.insert(estimatedCostRequests).values({
      operationId,
      installationId: context.target.installationId,
      ownerId,
      taskId,
      requestFingerprint: 'a',
      bindingDigest: 'b',
      sourceBinding: {},
      state: 'approved',
      quote: {},
      baseline: [],
    });
    await db.insert(estimatedCostGrants).values({
      id: grantId,
      operationId,
      quoteId: 'q',
      escrowReservationId: reservationId,
      allowanceMicros: 1,
      consumedMicros: 0,
      expiresAt: new Date(Date.now() + 60000),
    });
    await expect(inspectPostgresEstimatedCostBaseline(db, context)).rejects.toThrow('Active grant');
    await db
      .update(estimatedCostGrants)
      .set({ expiresAt: new Date(Date.now() - 60000) })
      .where(eq(estimatedCostGrants.id, grantId));
    await db
      .update(costReservations)
      .set({ costGrantId: grantId })
      .where(eq(costReservations.id, reservationId));
    const { proposal } = await prepared();
    expect(proposal.rows).toEqual([]);
    expect(proposal.heldMicros).toBe(100000);
  });
  it('rejects more than 500 eligible rows instead of truncating', async () => {
    await db.execute(sql`insert into cost_reservations (id, source, estimated_usd, status, description, created_at)
      select gen_random_uuid(), 'model', 0.000001, 'unknown', 'baseline-oversize-test', now() - interval '1 day' from generate_series(1, 500)`);
    const inspection = await inspectPostgresEstimatedCostBaseline(db, context);
    expect(inspection.census.reservations).toHaveLength(501);
    expect(inspection.census.heldMicros).toBe(100500);
    await expect(prepared()).rejects.toThrow('Invalid baseline proposal rows');
  });
  it('recovers the exact receipt after expiry and release change without authorizing another apply', async () => {
    const { witness, proposal } = await prepared();
    const receipt = await applyPostgresEstimatedCostBaseline(db, context, witness, proposal);
    await db
      .update(costReservations)
      .set({ status: 'held' })
      .where(eq(costReservations.id, reservationId));
    const later = {
      ...context,
      releaseSha: 'f'.repeat(40),
      now: () => new Date(Date.parse(witness.expiresAt) + 1000),
    };
    expect(await readbackPostgresEstimatedCostBaseline(db, later, witness, proposal)).toEqual(
      receipt,
    );
    await expect(
      applyPostgresEstimatedCostBaseline(db, later, witness, proposal),
    ).rejects.toThrow();
    await expect(preparePostgresEstimatedCostBaseline(db, later, witness)).rejects.toThrow();
    await expect(
      readbackPostgresEstimatedCostBaseline(
        db,
        later,
        { ...witness, drainDigest: 'd'.repeat(64) },
        proposal,
      ),
    ).rejects.toThrow();
    await db
      .insert(maintenanceCursors)
      .values({ name: `privacy-erasure-active:${ownerId}`, cursor: 'active' });
    await expect(
      readbackPostgresEstimatedCostBaseline(db, later, witness, proposal),
    ).rejects.toThrow();
  });
});
