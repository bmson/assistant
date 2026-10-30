import { randomUUID } from 'node:crypto';
import {
  type OwnerEditorAtomicAdmission,
  type OwnerEditorClaim,
  type OwnerEditorLookup,
  type OwnerEditorOperationRecord,
  type OwnerEditorOperationRepository,
  type OwnerEditorReceiptProof,
  type OwnerEditorReceiptReply,
  type OwnerEditorReply,
  type OwnerEditorReservation,
  type OwnerEditorScope,
  type OwnerEditorTerminalResult,
  ownerEditorAdmitClaim,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorReceipt,
  ownerEditorRecordMatches,
  ownerEditorRejected,
  ownerEditorRetired,
  ownerEditorScopeDigest,
  ownerEditorSnapshotRevision,
  ownerEditorUnknown,
  parseOwnerEditorEpochCursor,
  parseOwnerEditorOperationRecord,
  parseOwnerEditorTerminalResult,
} from '@assistant/persistence';
import { type DocumentSnapshot, FieldValue, type Transaction } from '@google-cloud/firestore';
import { buildFirestoreOwnerEditorEpochRecord } from './owner-editor-epoch-record.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const epochName = (owner: string) => `owner-editor-epoch:${owner}`;
const replayMs = 24 * 60 * 60 * 1000;
const fresh = (store: InstallationStore, now: Date) =>
  new Date(Math.max(store.now().getTime(), now.getTime()));

export function ownerEditorFirestorePrivacyToken(
  job: DocumentSnapshot,
  ownerId: string,
): string | null {
  if (!job.exists) return null;
  if (
    job.get('agentId') !== ownerId ||
    job.get('status') !== 'complete' ||
    typeof job.get('generation') !== 'string' ||
    !job.updateTime
  )
    throw new Error('Editor privacy state is unavailable');
  return JSON.stringify({
    generation: job.get('generation'),
    seconds: job.updateTime.seconds,
    nanoseconds: job.updateTime.nanoseconds,
  });
}
async function metadata(tx: Transaction, store: InstallationStore, ownerId: string) {
  const owners = await tx.get(store.collection('agents').limit(2));
  if (
    owners.size !== 1 ||
    owners.docs[0]?.get('id') !== ownerId ||
    owners.docs[0]?.id !== documentKey(ownerId)
  )
    throw new Error('Editor owner is unavailable');
  const [job, epoch] = await tx.getAll(
    store.doc('privacyErasureJobs', ownerId),
    store.doc('maintenanceCursors', epochName(ownerId)),
  );
  if (!job || !epoch) throw new Error('Editor metadata is unavailable');
  const generation = ownerEditorFirestorePrivacyToken(job, ownerId);
  if (!epoch.exists) return null;
  if (epoch.get('name') !== epochName(ownerId) || typeof epoch.get('cursor') !== 'string')
    throw new Error('Editor epoch identity is malformed');
  const value = parseOwnerEditorEpochCursor(JSON.parse(epoch.get('cursor')));
  if (value.ownerId !== ownerId) throw new Error('Editor epoch owner is unavailable');
  return { ...value, privacyGeneration: generation };
}
async function current(
  tx: Transaction,
  store: InstallationStore,
  scope: OwnerEditorScope,
): Promise<'ready' | 'retired' | 'unavailable'> {
  const value = await metadata(tx, store, scope.ownerId);
  if (!value) return 'unavailable';
  return value.epoch !== scope.epoch ||
    value.privacyGeneration !== scope.privacyGeneration ||
    value.privacyGenerationDigest !== ownerEditorPrivacyDigest(value.privacyGeneration)
    ? 'retired'
    : value.ready
      ? 'ready'
      : 'unavailable';
}
function scopeReply(
  scope: OwnerEditorScope,
  state: 'ready' | 'retired' | 'unavailable',
  now: Date,
): OwnerEditorReply | null {
  if (state === 'retired' || now.getTime() >= scope.issuedAt + replayMs)
    return ownerEditorRetired(scope);
  return state === 'unavailable' ? ownerEditorUnknown(scope) : null;
}
async function rowFor(
  tx: Transaction,
  store: InstallationStore,
  scope: OwnerEditorScope,
): Promise<OwnerEditorOperationRecord | null> {
  const id = ownerEditorOperationId(scope);
  const snapshot = await tx.get(store.doc('ownerEditorOperations', id));
  if (!snapshot.exists) return null;
  const row = parseOwnerEditorOperationRecord(decodeRecord(snapshot.data()));
  if (snapshot.id !== documentKey(id) || row.id !== id)
    throw new Error('Editor operation identity is malformed');
  return row;
}
function terminal(
  tx: Transaction,
  store: InstallationStore,
  row: OwnerEditorOperationRecord,
  input: OwnerEditorTerminalResult,
  now: Date,
): OwnerEditorReceiptReply {
  const result = parseOwnerEditorTerminalResult(input);
  const status =
    result.outcome === 'saved' || result.outcome === 'unchanged'
      ? 'committed'
      : result.outcome === 'not_applied'
        ? 'abandoned'
        : 'terminal_rejected';
  const written = parseOwnerEditorOperationRecord({
    ...row,
    status,
    result,
    claimToken: null,
    claimExpiresAt: null,
    statusVersion: row.statusVersion + 1,
    updatedAt: now,
  });
  // ALL reads, including the claim, occurred before domain writes. Firestore's
  // read-set conflict check keeps this terminal receipt atomic with those writes.
  tx.set(store.doc('ownerEditorOperations', row.id), encodeRecord(written));
  return ownerEditorReceipt(written);
}

export async function beginFirestoreOwnerEditorWrite(
  store: InstallationStore,
  tx: Transaction,
  claim: OwnerEditorClaim,
  now: Date,
): Promise<OwnerEditorAtomicAdmission> {
  const state = await current(tx, store, claim.scope);
  const at = fresh(store, now);
  const blocked = scopeReply(claim.scope, state, at);
  if (blocked) return { kind: 'reply', reply: blocked };
  return ownerEditorAdmitClaim(claim, await rowFor(tx, store, claim.scope), at);
}
export function completeFirestoreOwnerEditorWrite(
  store: InstallationStore,
  tx: Transaction,
  admitted: Extract<OwnerEditorAtomicAdmission, { kind: 'admitted' }>,
  result: OwnerEditorTerminalResult,
  now: Date,
): OwnerEditorReceiptReply {
  // begin read this existing epoch. A shared write serializes final editor commits,
  // including distinct contact IDs, so SDK retries recheck duplicate-name queries.
  // serverTimestamp changes the native document version even when caller clocks match.
  // No cursor/UUID is changed: previously issued scopes keep their authority.
  tx.update(store.doc('maintenanceCursors', epochName(admitted.claim.scope.ownerId)), {
    updatedAt: FieldValue.serverTimestamp(),
  });
  return terminal(tx, store, admitted.operation, result, now);
}

export function createFirestoreOwnerEditorOperationRepository(
  store: InstallationStore,
  configuredOwnerId: string,
): OwnerEditorOperationRepository {
  const assertOwner = (scope: OwnerEditorScope) => {
    if (scope.ownerId !== configuredOwnerId) throw new Error('Editor owner is unavailable');
  };
  return {
    kind: 'owner-editor-operation-repository',
    async reserve(scope, requestHash, now): Promise<OwnerEditorReservation> {
      assertOwner(scope);
      return store.db.runTransaction(async (tx) => {
        const state = await current(tx, store, scope);
        const at = fresh(store, now);
        const blocked = scopeReply(scope, state, at);
        if (blocked) return { kind: 'reply', reply: blocked };
        const existing = await rowFor(tx, store, scope);
        if (existing) {
          if (!ownerEditorRecordMatches(scope, existing) || existing.requestHash !== requestHash)
            return { kind: 'reply', reply: ownerEditorRejected(scope, 'request_binding_mismatch') };
          return {
            kind: 'reply',
            reply:
              existing.status === 'preparing'
                ? ownerEditorUnknown(scope, 'preparing')
                : ownerEditorReceipt(existing),
          };
        }
        if (at.getTime() >= scope.expiresAt)
          return { kind: 'reply', reply: ownerEditorRetired(scope) };
        const claim: OwnerEditorClaim = {
          scope,
          requestHash,
          claimToken: randomUUID(),
          claimExpiresAt: new Date(at.getTime() + 60_000),
          statusVersion: 1,
        };
        const row = parseOwnerEditorOperationRecord({
          id: ownerEditorOperationId(scope),
          ownerId: scope.ownerId,
          epoch: scope.epoch,
          privacyGenerationDigest: ownerEditorPrivacyDigest(scope.privacyGeneration),
          operationId: scope.operationId,
          requestHash,
          scopeDigest: ownerEditorScopeDigest(scope),
          command: scope.command,
          protocolVersion: 1,
          formIssuedAt: new Date(scope.issuedAt),
          formExpiresAt: new Date(scope.expiresAt),
          claimToken: claim.claimToken,
          claimExpiresAt: claim.claimExpiresAt,
          status: 'preparing',
          statusVersion: 1,
          result: null,
          createdAt: at,
          updatedAt: at,
        });
        tx.create(store.doc('ownerEditorOperations', row.id), encodeRecord(row));
        return { kind: 'claimed', claim };
      });
    },
    async lookup(scope, now): Promise<OwnerEditorLookup> {
      assertOwner(scope);
      return store.db.runTransaction(async (tx) => {
        const state = await current(tx, store, scope);
        const blocked = scopeReply(scope, state, fresh(store, now));
        if (blocked) return { reply: blocked, operation: null };
        const operation = await rowFor(tx, store, scope);
        if (!operation)
          return { reply: ownerEditorUnknown(scope, 'receipt_missing'), operation: null };
        if (!ownerEditorRecordMatches(scope, operation))
          return { reply: ownerEditorRejected(scope, 'request_binding_mismatch'), operation: null };
        return {
          operation,
          reply:
            operation.status === 'preparing'
              ? ownerEditorUnknown(scope, 'preparing')
              : ownerEditorReceipt(operation),
        };
      });
    },
    async reconcile(proof: OwnerEditorReceiptProof, now): Promise<OwnerEditorReply> {
      const scope = proof.scope;
      assertOwner(scope);
      return store.db.runTransaction(async (tx) => {
        const state = await current(tx, store, scope);
        const at = fresh(store, now);
        const blocked = scopeReply(scope, state, at);
        if (blocked) return blocked;
        const row = await rowFor(tx, store, scope);
        if (!row) return ownerEditorUnknown(scope, 'receipt_missing');
        if (!ownerEditorRecordMatches(scope, row) || row.requestHash !== proof.requestHash)
          return ownerEditorRejected(scope, 'request_binding_mismatch');
        if (row.status !== 'preparing') return ownerEditorReceipt(row);
        if (
          proof.expiresAt <= at.getTime() ||
          row.statusVersion !== proof.statusVersion ||
          ownerEditorSnapshotRevision({
            token: row.claimToken,
            expiresAt: row.claimExpiresAt?.toISOString() ?? null,
          }) !== proof.claimIdentityDigest
        )
          return ownerEditorUnknown(scope, 'proof_changed');
        if (!row.claimExpiresAt || row.claimExpiresAt.getTime() > at.getTime())
          return ownerEditorUnknown(scope, 'preparing');
        return terminal(tx, store, row, { outcome: 'not_applied', reason: 'claim_abandoned' }, at);
      });
    },
    async failPreparation(claim, result, now) {
      assertOwner(claim.scope);
      return store.db.runTransaction(async (tx) => {
        const admitted = await beginFirestoreOwnerEditorWrite(store, tx, claim, now);
        return admitted.kind === 'reply'
          ? admitted.reply
          : completeFirestoreOwnerEditorWrite(store, tx, admitted, result, now);
      });
    },
  };
}

/** Maintenance-only; never called by browser receipt/command routes. */
export async function rotateFirestoreOwnerEditorEpoch(
  store: InstallationStore,
  ownerId: string,
  ready: boolean,
): Promise<string> {
  return store.db.runTransaction((tx) =>
    rotateFirestoreOwnerEditorEpochInTransaction(store, tx, ownerId, ready),
  );
}

/** Call after other required reads and before any writes in the activation transaction. */
export async function rotateFirestoreOwnerEditorEpochInTransaction(
  store: InstallationStore,
  tx: Transaction,
  ownerId: string,
  ready: boolean,
): Promise<string> {
  const owners = await tx.get(store.collection('agents').limit(2));
  if (
    owners.size !== 1 ||
    owners.docs[0]?.get('id') !== ownerId ||
    owners.docs[0]?.id !== documentKey(ownerId)
  )
    throw new Error('Editor owner is unavailable');
  const job = await tx.get(store.doc('privacyErasureJobs', ownerId));
  const generation = ownerEditorFirestorePrivacyToken(job, ownerId);
  const epoch = randomUUID();
  const name = epochName(ownerId);
  tx.set(
    store.doc('maintenanceCursors', name),
    buildFirestoreOwnerEditorEpochRecord({
      ownerId,
      epoch,
      ready,
      privacyGeneration: generation,
      updatedAt: store.now(),
    }),
  );
  return epoch;
}

/** Read-only; a missing/disabled epoch never creates editor authority. */
export async function readFirestoreOwnerEditorIssuanceContext(
  store: InstallationStore,
  ownerId: string,
  transaction?: Transaction,
): Promise<import('@assistant/persistence').OwnerEditorIssuanceContext | null> {
  const read = async (tx: Transaction) => {
    const value = await metadata(tx, store, ownerId);
    if (
      !value?.ready ||
      value.privacyGenerationDigest !== ownerEditorPrivacyDigest(value.privacyGeneration)
    )
      return null;
    return { ownerId, epoch: value.epoch, privacyGeneration: value.privacyGeneration };
  };
  return transaction ? read(transaction) : store.db.runTransaction(read);
}
