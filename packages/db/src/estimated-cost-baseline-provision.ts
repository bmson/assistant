/** Operator-only frozen baseline provisioning. Proof authenticity is verified by the caller. */
import {
  type EstimatedCostBaselineCensus,
  type EstimatedCostBaselineContext,
  type EstimatedCostBaselineProposal,
  type EstimatedCostBaselineReceipt,
  type EstimatedCostBaselineWitness,
  estimatedCostBaselineCensusDigest,
  estimatedCostProvisionDigest,
  makeEstimatedCostBaselineProposal,
  storedLedgerUsdToMicros,
  validateEstimatedCostBaselineHistoricalWitness,
  validateEstimatedCostBaselineProposal,
  validateEstimatedCostBaselineWitness,
} from '@assistant/persistence';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockCostLedger } from './cost-repository.js';
import {
  lockPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { estimatedCostBaselines, maintenanceCursors } from './schema.js';

const limit = 10000;
const markerName = (installationId: string) => `estimated-cost-baseline:${installationId}`;
function scope(context: EstimatedCostBaselineContext, witness?: EstimatedCostBaselineWitness) {
  if (context.target.driver !== 'postgres' || !context.ownerId)
    throw new Error('Baseline target mismatch');
  if (witness) {
    validateEstimatedCostBaselineWitness(
      witness,
      context.target,
      context.releaseSha,
      context.now(),
    );
    if (witness.ownerId !== context.ownerId) throw new Error('Baseline owner mismatch');
  }
}
type NativeReservation = {
  id: string;
  status: string;
  estimated_usd: string;
  reservation_kind: string;
  cost_grant_id: string | null;
  created_micros: string;
  version: string;
};
type NativeGrant = { id: string; expires_micros: string; version: string };
async function observe(
  tx: Db,
  context: EstimatedCostBaselineContext,
  write: boolean,
): Promise<EstimatedCostBaselineCensus> {
  const privacyGeneration = write
    ? await lockPostgresPrivacyObservationFence(tx, context.ownerId)
    : await postgresPrivacyObservationFence(tx, context.ownerId);
  if (write) await lockCostLedger(tx);
  const owners = (await tx.execute(
    sql`select id::text as id, xmin::text as version from agents limit 2`,
  )) as unknown as { id: string; version: string }[];
  if (owners.length !== 1 || owners[0]?.id !== context.ownerId)
    throw new Error('Baseline owner unavailable');
  const database = (await tx.execute(sql`select current_database() as name`)) as unknown as {
    name: string;
  }[];
  if (database[0]?.name !== context.target.databaseId)
    throw new Error('Baseline database mismatch');
  const rows = (await tx.execute(
    sql`select id::text as id, status, estimated_usd::text, reservation_kind, cost_grant_id::text, (extract(epoch from created_at)*1000000)::numeric(30,0)::text as created_micros, xmin::text as version from cost_reservations order by id limit ${limit + 1}`,
  )) as unknown as NativeReservation[];
  const grants = (await tx.execute(
    sql`select id::text as id, (extract(epoch from expires_at)*1000000)::numeric(30,0)::text as expires_micros, xmin::text as version from estimated_cost_grants order by id limit ${limit + 1}`,
  )) as unknown as NativeGrant[];
  if (rows.length > limit || grants.length > limit)
    throw new Error('Baseline census exceeds limit');
  const reservations = rows.map((r) => {
    if (
      !r.id ||
      !['held', 'dispatching', 'unknown', 'reconciled', 'released'].includes(r.status) ||
      !r.reservation_kind ||
      !/^-?\d+$/.test(r.created_micros) ||
      !r.version
    )
      throw new Error('Malformed reservation census');
    if (r.status === 'held' || r.status === 'dispatching')
      throw new Error('Active reservation during baseline freeze');
    return {
      reservationId: r.id,
      status: r.status,
      estimatedMicros: storedLedgerUsdToMicros(r.estimated_usd),
      reservationKind: r.reservation_kind,
      grantId: r.cost_grant_id,
      createdMicros: r.created_micros,
      version: r.version,
    };
  });
  const grantRows = grants.map((r) => {
    if (!r.id || !/^-?\d+$/.test(r.expires_micros) || !r.version)
      throw new Error('Malformed grant census');
    if (BigInt(r.expires_micros) > BigInt(context.now().getTime()) * 1000n)
      throw new Error('Active grant during baseline freeze');
    return { id: r.id, expiresMicros: r.expires_micros, version: r.version };
  });
  const heldMicros = reservations
    .filter((r) => r.status === 'unknown')
    .reduce((n, r) => n + r.estimatedMicros, 0);
  if (!Number.isSafeInteger(heldMicros)) throw new Error('Invalid liability total');
  return {
    ownerVersion: owners[0]!.version,
    privacyGeneration,
    heldMicros,
    reservations,
    grants: grantRows,
    ledgerVersion: 'postgres-advisory-ledger-v1',
  };
}
async function readReceipt(
  tx: Db,
  context: EstimatedCostBaselineContext,
  proposal: EstimatedCostBaselineProposal,
  witness: EstimatedCostBaselineWitness,
): Promise<EstimatedCostBaselineReceipt> {
  const [baseline] = await tx
    .select()
    .from(estimatedCostBaselines)
    .where(eq(estimatedCostBaselines.installationId, context.target.installationId));
  const [marker] = await tx
    .select()
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, markerName(context.target.installationId)));
  const native = (await tx.execute(
    sql`select xmin::text as version, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at from estimated_cost_baselines where installation_id = ${context.target.installationId}`,
  )) as unknown as { version: string; created_at: string }[];
  const proposalDigest = estimatedCostProvisionDigest(proposal);
  if (
    !baseline ||
    !marker ||
    !native[0] ||
    marker.cursor !==
      JSON.stringify({
        proposalDigest,
        version: native[0].version,
        createdAt: native[0].created_at,
      }) ||
    baseline.ownerId !== context.ownerId ||
    baseline.digest !== proposal.digest ||
    estimatedCostProvisionDigest(baseline.rows) !== estimatedCostProvisionDigest(proposal.rows) ||
    Date.parse(native[0].created_at) < Date.parse(witness.cutoff) ||
    Date.parse(native[0].created_at) >= Date.parse(witness.expiresAt)
  )
    throw new Error('Baseline receipt conflict');
  return {
    proposalDigest,
    installationId: context.target.installationId,
    ownerId: context.ownerId,
    digest: proposal.digest,
    rows: proposal.rows,
    createdVersion: native[0].version,
    createdAt: native[0].created_at,
  };
}
export async function inspectPostgresEstimatedCostBaseline(
  db: Db,
  context: EstimatedCostBaselineContext,
) {
  scope(context);
  const census = await db.transaction((tx) => observe(tx as unknown as Db, context, false), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
  return { censusDigest: estimatedCostBaselineCensusDigest(census), census };
}
export async function preparePostgresEstimatedCostBaseline(
  db: Db,
  context: EstimatedCostBaselineContext,
  witness: EstimatedCostBaselineWitness,
) {
  scope(context, witness);
  const census = await db.transaction(
    async (transaction) => {
      const tx = transaction as unknown as Db;
      const census = await observe(tx, context, false);
      const [baseline] = await tx
        .select()
        .from(estimatedCostBaselines)
        .where(eq(estimatedCostBaselines.installationId, context.target.installationId));
      const [marker] = await tx
        .select()
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, markerName(context.target.installationId)));
      if (baseline || marker) throw new Error('Baseline already exists');
      return census;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  scope(context, witness);
  return makeEstimatedCostBaselineProposal(census, witness);
}
export async function applyPostgresEstimatedCostBaseline(
  db: Db,
  context: EstimatedCostBaselineContext,
  witness: EstimatedCostBaselineWitness,
  proposal: EstimatedCostBaselineProposal,
): Promise<EstimatedCostBaselineReceipt> {
  scope(context, witness);
  validateEstimatedCostBaselineProposal(proposal, witness);
  await db.transaction(
    async (transaction) => {
      const tx = transaction as unknown as Db;
      const census = await observe(tx, context, true);
      const [baseline] = await tx
        .select()
        .from(estimatedCostBaselines)
        .where(eq(estimatedCostBaselines.installationId, context.target.installationId));
      const [marker] = await tx
        .select()
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, markerName(context.target.installationId)));
      scope(context, witness);
      if (
        estimatedCostProvisionDigest(makeEstimatedCostBaselineProposal(census, witness)) !==
        estimatedCostProvisionDigest(proposal)
      )
        throw new Error('Baseline proposal changed');
      if (baseline || marker) {
        await readReceipt(tx, context, proposal, witness);
        return;
      }
      const [clock] = (await tx.execute(
        sql`select clock_timestamp() >= ${witness.cutoff}::timestamptz and clock_timestamp() < ${witness.expiresAt}::timestamptz as valid`,
      )) as unknown as { valid: boolean }[];
      if (!clock?.valid) throw new Error('Database clock outside witness window');
      await tx.insert(estimatedCostBaselines).values({
        installationId: context.target.installationId,
        ownerId: context.ownerId,
        digest: proposal.digest,
        rows: proposal.rows,
        createdAt: sql`clock_timestamp()`,
      });
      const [native] = (await tx.execute(
        sql`select xmin::text as version, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at from estimated_cost_baselines where installation_id = ${context.target.installationId}`,
      )) as unknown as { version: string; created_at: string }[];
      if (!native) throw new Error('Baseline native version unavailable');
      await tx.insert(maintenanceCursors).values({
        name: markerName(context.target.installationId),
        cursor: JSON.stringify({
          proposalDigest: estimatedCostProvisionDigest(proposal),
          version: native.version,
          createdAt: native.created_at,
        }),
      });
    },
    { isolationLevel: 'read committed' },
  );
  return readbackPostgresEstimatedCostBaseline(db, context, witness, proposal);
}
export async function readbackPostgresEstimatedCostBaseline(
  db: Db,
  context: EstimatedCostBaselineContext,
  witness: EstimatedCostBaselineWitness,
  proposal: EstimatedCostBaselineProposal,
): Promise<EstimatedCostBaselineReceipt> {
  scope(context);
  validateEstimatedCostBaselineHistoricalWitness(witness, context.target);
  if (witness.ownerId !== context.ownerId) throw new Error('Baseline owner mismatch');
  validateEstimatedCostBaselineProposal(proposal, witness);
  return db.transaction(
    async (transaction) => {
      const tx = transaction as unknown as Db;
      const privacyGeneration = await postgresPrivacyObservationFence(tx, context.ownerId);
      const owners = (await tx.execute(
        sql`select id::text as id from agents limit 2`,
      )) as unknown as { id: string }[];
      const database = (await tx.execute(sql`select current_database() as name`)) as unknown as {
        name: string;
      }[];
      if (
        owners.length !== 1 ||
        owners[0]?.id !== context.ownerId ||
        database[0]?.name !== context.target.databaseId ||
        privacyGeneration !== proposal.privacyGeneration
      )
        throw new Error('Baseline readback owner or privacy changed');
      return readReceipt(tx, context, proposal, witness);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
