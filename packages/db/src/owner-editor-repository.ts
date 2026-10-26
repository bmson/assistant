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
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { agents, maintenanceCursors, ownerEditorOperations } from './schema.js';

type Tx = Pick<Db, 'select' | 'insert' | 'update'>;
const epochName = (owner: string) => `owner-editor-epoch:${owner}`;
const replayMs = 24 * 60 * 60 * 1000;
const claimMs = 60_000;
const fresh = (now: Date) => new Date(Math.max(now.getTime(), Date.now()));

async function current(
  tx: Tx,
  scope: OwnerEditorScope,
): Promise<'ready' | 'retired' | 'unavailable'> {
  const generation = await lockPostgresPrivacyObservationFence(tx, scope.ownerId);
  const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
  if (owners.length !== 1 || owners[0]?.id !== scope.ownerId)
    throw new Error('Editor owner is unavailable');
  const [row] = await tx
    .select()
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, epochName(scope.ownerId)))
    .for('update')
    .limit(1);
  if (!row?.cursor) return 'unavailable';
  let value: ReturnType<typeof parseOwnerEditorEpochCursor>;
  try {
    value = parseOwnerEditorEpochCursor(JSON.parse(row.cursor));
  } catch {
    return 'unavailable';
  }
  if (value.ownerId !== scope.ownerId) return 'unavailable';
  const actual = ownerEditorPrivacyDigest(generation);
  if (
    generation !== scope.privacyGeneration ||
    value.epoch !== scope.epoch ||
    value.privacyGenerationDigest !== actual
  )
    return 'retired';
  return value.ready ? 'ready' : 'unavailable';
}
async function rowFor(tx: Tx, scope: OwnerEditorScope): Promise<OwnerEditorOperationRecord | null> {
  const [row] = await tx
    .select()
    .from(ownerEditorOperations)
    .where(
      and(
        eq(ownerEditorOperations.id, ownerEditorOperationId(scope)),
        eq(ownerEditorOperations.ownerId, scope.ownerId),
      ),
    )
    .for('update')
    .limit(1);
  return row ? parseOwnerEditorOperationRecord(row) : null;
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
async function terminal(
  tx: Tx,
  row: OwnerEditorOperationRecord,
  result: OwnerEditorTerminalResult,
  now: Date,
): Promise<OwnerEditorReceiptReply> {
  result = parseOwnerEditorTerminalResult(result);
  const status =
    result.outcome === 'saved' || result.outcome === 'unchanged'
      ? 'committed'
      : result.outcome === 'not_applied'
        ? 'abandoned'
        : 'terminal_rejected';
  const [written] = await tx
    .update(ownerEditorOperations)
    .set({
      status,
      result,
      claimToken: null,
      claimExpiresAt: null,
      statusVersion: row.statusVersion + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(ownerEditorOperations.id, row.id),
        eq(ownerEditorOperations.ownerId, row.ownerId),
        eq(ownerEditorOperations.requestHash, row.requestHash),
        eq(ownerEditorOperations.status, 'preparing'),
        eq(ownerEditorOperations.statusVersion, row.statusVersion),
        eq(ownerEditorOperations.claimToken, row.claimToken ?? ''),
      ),
    )
    .returning();
  if (!written) throw new Error('Editor claim changed before terminal commit');
  return ownerEditorReceipt(parseOwnerEditorOperationRecord(written));
}

/** Call before domain reads/writes on the SAME leased transaction. */
export async function beginPostgresOwnerEditorWrite(
  tx: Tx,
  claim: OwnerEditorClaim,
  now: Date,
): Promise<OwnerEditorAtomicAdmission> {
  const currentState = await current(tx, claim.scope);
  now = fresh(now);
  const state = scopeReply(claim.scope, currentState, now);
  if (state) return { kind: 'reply', reply: state };
  return ownerEditorAdmitClaim(claim, await rowFor(tx, claim.scope), now);
}
/** Any failed conditional receipt update rolls back the caller's primary writes. */
export function completePostgresOwnerEditorWrite(
  tx: Tx,
  admitted: Extract<OwnerEditorAtomicAdmission, { kind: 'admitted' }>,
  result: OwnerEditorTerminalResult,
  now: Date,
): Promise<OwnerEditorReceiptReply> {
  return terminal(tx, admitted.operation, result, now);
}

export function createPostgresOwnerEditorOperationRepository(
  db: Db,
): OwnerEditorOperationRepository {
  return {
    kind: 'owner-editor-operation-repository',
    async reserve(scope, requestHash, now): Promise<OwnerEditorReservation> {
      return db.transaction(async (tx) => {
        const currentState = await current(tx, scope);
        now = fresh(now);
        const blocked = scopeReply(scope, currentState, now);
        if (blocked) return { kind: 'reply', reply: blocked };
        const existing = await rowFor(tx, scope);
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
        if (now.getTime() >= scope.expiresAt)
          return { kind: 'reply', reply: ownerEditorRetired(scope) };
        const claim: OwnerEditorClaim = {
          scope,
          requestHash,
          claimToken: randomUUID(),
          claimExpiresAt: new Date(now.getTime() + claimMs),
          statusVersion: 1,
        };
        const row: OwnerEditorOperationRecord = {
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
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(ownerEditorOperations).values(row);
        return { kind: 'claimed', claim };
      });
    },
    async lookup(scope, now): Promise<OwnerEditorLookup> {
      return db.transaction(async (tx) => {
        const currentState = await current(tx, scope);
        now = fresh(now);
        const blocked = scopeReply(scope, currentState, now);
        if (blocked) return { reply: blocked, operation: null };
        const operation = await rowFor(tx, scope);
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
      return db.transaction(async (tx) => {
        const scope = proof.scope;
        const currentState = await current(tx, scope);
        now = fresh(now);
        const blocked = scopeReply(scope, currentState, now);
        if (blocked) return blocked;
        const row = await rowFor(tx, scope);
        if (!row) return ownerEditorUnknown(scope, 'receipt_missing');
        if (!ownerEditorRecordMatches(scope, row) || row.requestHash !== proof.requestHash)
          return ownerEditorRejected(scope, 'request_binding_mismatch');
        if (row.status !== 'preparing') return ownerEditorReceipt(row);
        if (
          proof.expiresAt <= now.getTime() ||
          row.statusVersion !== proof.statusVersion ||
          ownerEditorSnapshotRevision({
            token: row.claimToken,
            expiresAt: row.claimExpiresAt?.toISOString() ?? null,
          }) !== proof.claimIdentityDigest
        )
          return ownerEditorUnknown(scope, 'proof_changed');
        if (!row.claimExpiresAt || row.claimExpiresAt.getTime() > now.getTime())
          return ownerEditorUnknown(scope, 'preparing');
        return terminal(tx, row, { outcome: 'not_applied', reason: 'claim_abandoned' }, now);
      });
    },
    async failPreparation(claim, result, now) {
      return db.transaction(async (tx) => {
        const admitted = await beginPostgresOwnerEditorWrite(tx, claim, now);
        return admitted.kind === 'reply'
          ? admitted.reply
          : completePostgresOwnerEditorWrite(tx, admitted, result, now);
      });
    },
  };
}

/** Maintenance-only activation. Browser mutation handlers never create epochs. */
export async function rotatePostgresOwnerEditorEpoch(
  db: Db,
  ownerId: string,
  ready: boolean,
): Promise<string> {
  return db.transaction(async (tx) => {
    const generation = await lockPostgresPrivacyObservationFence(tx, ownerId);
    const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
    if (owners.length !== 1 || owners[0]?.id !== ownerId)
      throw new Error('Editor owner is unavailable');
    const epoch = randomUUID();
    const cursor = JSON.stringify({
      ownerId,
      epoch,
      ready,
      privacyGenerationDigest: ownerEditorPrivacyDigest(generation),
    });
    await tx
      .insert(maintenanceCursors)
      .values({ name: epochName(ownerId), cursor, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor, updatedAt: new Date() },
      });
    return epoch;
  });
}

/** Read-only composition may pass its existing leased transaction. */
export async function readPostgresOwnerEditorIssuanceContext(
  tx: Pick<Db, 'select'>,
  ownerId: string,
): Promise<import('@assistant/persistence').OwnerEditorIssuanceContext | null> {
  const generation = await lockPostgresPrivacyObservationFence(tx, ownerId);
  const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
  if (owners.length !== 1 || owners[0]?.id !== ownerId)
    throw new Error('Editor owner is unavailable');
  const [row] = await tx
    .select()
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, epochName(ownerId)))
    .limit(1);
  if (!row?.cursor) return null;
  const value = parseOwnerEditorEpochCursor(JSON.parse(row.cursor));
  if (
    value.ownerId !== ownerId ||
    typeof value.epoch !== 'string' ||
    value.ready !== true ||
    value.privacyGenerationDigest !== ownerEditorPrivacyDigest(generation)
  )
    return null;
  return { ownerId, epoch: value.epoch, privacyGeneration: generation };
}
