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
import { type DocumentSnapshot, Timestamp, type Transaction } from '@google-cloud/firestore';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { documentKey, type InstallationStore } from './store.js';

const limit = 10000;
function version(doc: DocumentSnapshot): string {
  if (!doc.updateTime) throw new Error('Missing native version');
  return `${doc.updateTime.seconds}:${doc.updateTime.nanoseconds}`;
}
function micros(value: Timestamp): string {
  return (
    BigInt(value.seconds) * 1000000n +
    BigInt(Math.ceil(value.nanoseconds / 1000))
  ).toString();
}
function scope(
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
  witness?: EstimatedCostBaselineWitness,
) {
  if (
    context.target.driver !== 'firestore' ||
    context.target.projectId !== store.projectId ||
    context.target.databaseId !== store.databaseId ||
    context.target.installationId !== store.installationId ||
    !context.ownerId
  )
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
async function observeOwner(
  tx: Transaction,
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
) {
  const owners = await tx.get(store.collection('agents').select('id').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.id !== documentKey(context.ownerId) ||
    owner.get('id') !== context.ownerId
  )
    throw new Error('Baseline owner unavailable');
  const job = await tx.get(store.doc('privacyErasureJobs', context.ownerId));
  return {
    ownerVersion: version(owner),
    privacyGeneration: ownerEditorFirestorePrivacyToken(job, context.ownerId),
  };
}
async function observe(
  tx: Transaction,
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
): Promise<EstimatedCostBaselineCensus> {
  const { ownerVersion, privacyGeneration } = await observeOwner(tx, store, context);
  const holds = await tx.get(store.doc('coordination', 'budget-holds'));
  if (
    !holds.exists ||
    !Number.isSafeInteger(holds.get('heldMicros')) ||
    holds.get('heldMicros') < 0
  )
    throw new Error('Baseline ledger unavailable');
  const [reservations, grants] = await Promise.all([
    tx.get(store.collection('costReservations').limit(limit + 1)),
    tx.get(store.collection('estimatedCostGrants').limit(limit + 1)),
  ]);
  if (reservations.size > limit || grants.size > limit)
    throw new Error('Baseline census exceeds limit');
  const rows = reservations.docs
    .map((doc) => {
      const id = doc.get('id'),
        status = doc.get('status'),
        kind = doc.get('reservationKind') ?? 'attempt',
        grantId = doc.get('costGrantId') ?? null;
      if (
        typeof id !== 'string' ||
        !id ||
        doc.id !== documentKey(id) ||
        !['held', 'dispatching', 'unknown', 'reconciled', 'released'].includes(status) ||
        typeof kind !== 'string' ||
        !kind ||
        !(grantId === null || (typeof grantId === 'string' && grantId.length > 0)) ||
        !(doc.createTime instanceof Timestamp)
      )
        throw new Error('Malformed reservation census');
      const estimatedMicros = storedLedgerUsdToMicros(doc.get('estimatedUsd'));
      if (status === 'held' || status === 'dispatching')
        throw new Error('Active reservation during baseline freeze');
      return {
        reservationId: id,
        status,
        estimatedMicros,
        reservationKind: kind,
        grantId,
        createdMicros: micros(doc.createTime),
        version: version(doc),
      };
    })
    .sort((a, b) =>
      a.reservationId < b.reservationId ? -1 : a.reservationId > b.reservationId ? 1 : 0,
    );
  const grantRows = grants.docs
    .map((doc) => {
      const id = doc.get('id'),
        expires = doc.get('expiresAt');
      if (
        typeof id !== 'string' ||
        !id ||
        doc.id !== documentKey(id) ||
        !(expires instanceof Timestamp)
      )
        throw new Error('Malformed grant census');
      if (expires.toMillis() > context.now().getTime())
        throw new Error('Active grant during baseline freeze');
      return { id, expiresMicros: micros(expires), version: version(doc) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const heldMicros = rows
    .filter((r) => r.status === 'unknown')
    .reduce((sum, row) => sum + row.estimatedMicros, 0);
  if (!Number.isSafeInteger(heldMicros) || heldMicros !== holds.get('heldMicros'))
    throw new Error('Incomplete liability census');
  return {
    ownerVersion,
    privacyGeneration,
    heldMicros,
    reservations: rows,
    grants: grantRows,
    ledgerVersion: version(holds),
  };
}
function receiptName(installationId: string) {
  return `estimated-cost-baseline:${installationId}`;
}
function refs(store: InstallationStore) {
  return [
    store.doc('estimatedCostBaselines', store.installationId),
    store.doc('maintenanceCursors', receiptName(store.installationId)),
  ] as const;
}
function readReceipt(
  baseline: DocumentSnapshot,
  marker: DocumentSnapshot,
  context: EstimatedCostBaselineContext,
  proposal: EstimatedCostBaselineProposal,
  witness: EstimatedCostBaselineWitness,
): EstimatedCostBaselineReceipt {
  const proposalDigest = estimatedCostProvisionDigest(proposal);
  if (
    !baseline.exists ||
    !marker.exists ||
    marker.get('name') !== receiptName(context.target.installationId) ||
    marker.get('cursor') !== proposalDigest ||
    baseline.get('installationId') !== context.target.installationId ||
    baseline.get('ownerId') !== context.ownerId ||
    baseline.get('digest') !== proposal.digest ||
    estimatedCostProvisionDigest(baseline.get('rows')) !==
      estimatedCostProvisionDigest(proposal.rows) ||
    !(baseline.createTime instanceof Timestamp) ||
    !marker.createTime ||
    !baseline.createTime.isEqual(marker.createTime) ||
    !baseline.updateTime?.isEqual(baseline.createTime) ||
    !marker.updateTime?.isEqual(marker.createTime) ||
    baseline.createTime.toMillis() < Date.parse(witness.cutoff) ||
    baseline.createTime.toMillis() >= Date.parse(witness.expiresAt)
  )
    throw new Error('Baseline receipt conflict');
  return {
    proposalDigest,
    installationId: context.target.installationId,
    ownerId: context.ownerId,
    digest: proposal.digest,
    rows: proposal.rows,
    createdVersion: version(baseline),
    createdAt: baseline.createTime.toDate().toISOString(),
  };
}
export async function inspectFirestoreEstimatedCostBaseline(
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
) {
  scope(store, context);
  const census = await store.db.runTransaction((tx) => observe(tx, store, context), {
    readOnly: true,
  });
  return { censusDigest: estimatedCostBaselineCensusDigest(census), census };
}
export async function prepareFirestoreEstimatedCostBaseline(
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
  witness: EstimatedCostBaselineWitness,
) {
  scope(store, context, witness);
  const census = await store.db.runTransaction(
    async (tx) => {
      const census = await observe(tx, store, context);
      const [baseline, marker] = await tx.getAll(...refs(store));
      if (!baseline || !marker || baseline.exists || marker.exists)
        throw new Error('Baseline already exists');
      return census;
    },
    { readOnly: true },
  );
  scope(store, context, witness);
  return makeEstimatedCostBaselineProposal(census, witness);
}
export async function applyFirestoreEstimatedCostBaseline(
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
  witness: EstimatedCostBaselineWitness,
  proposal: EstimatedCostBaselineProposal,
): Promise<EstimatedCostBaselineReceipt> {
  scope(store, context, witness);
  validateEstimatedCostBaselineProposal(proposal, witness);
  await store.db.runTransaction(async (tx) => {
    const census = await observe(tx, store, context);
    const [baseline, marker] = await tx.getAll(...refs(store));
    if (!baseline || !marker) throw new Error('Baseline state unavailable');
    scope(store, context, witness);
    if (
      estimatedCostProvisionDigest(makeEstimatedCostBaselineProposal(census, witness)) !==
      estimatedCostProvisionDigest(proposal)
    )
      throw new Error('Baseline proposal changed');
    if (baseline.exists || marker.exists) {
      readReceipt(baseline, marker, context, proposal, witness);
      return;
    }
    tx.create(refs(store)[0], {
      installationId: store.installationId,
      ownerId: context.ownerId,
      digest: proposal.digest,
      rows: proposal.rows,
      createdAt: context.now(),
    });
    tx.create(refs(store)[1], {
      name: receiptName(store.installationId),
      cursor: estimatedCostProvisionDigest(proposal),
      updatedAt: context.now(),
    });
  });
  return readbackFirestoreEstimatedCostBaseline(store, context, witness, proposal);
}
export async function readbackFirestoreEstimatedCostBaseline(
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
  witness: EstimatedCostBaselineWitness,
  proposal: EstimatedCostBaselineProposal,
): Promise<EstimatedCostBaselineReceipt> {
  scope(store, context);
  validateEstimatedCostBaselineHistoricalWitness(witness, context.target);
  if (witness.ownerId !== context.ownerId) throw new Error('Baseline owner mismatch');
  validateEstimatedCostBaselineProposal(proposal, witness);
  return store.db.runTransaction(
    async (tx) => {
      const owner = await observeOwner(tx, store, context);
      const [baseline, marker] = await tx.getAll(...refs(store));
      if (!baseline || !marker || owner.privacyGeneration !== proposal.privacyGeneration)
        throw new Error('Baseline readback privacy changed');
      return readReceipt(baseline, marker, context, proposal, witness);
    },
    { readOnly: true },
  );
}
