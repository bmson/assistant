/** Bind the existing captured retirement executor to this run's lifecycle receipt. */
import {
  acceptCapturedRetirement,
  beginCapturedRetirement,
  bindCapturedRetirementOperation,
  type Snapshot,
  type State,
  unknownCapturedRetirement,
} from './owner-web-release-lifecycle-model.js';
import { operationName } from './owner-web-tag-native.js';
import { type RetirementIO, WEB_SERVICE } from './owner-web-tag-retirement.js';

type ReceiptSink = {
  recordIntent(state: State): void;
  recordCheckpoint(state: State): void;
};
type RetirementResult = {
  serviceEtag: string;
  serviceGeneration: string;
  action: 'retire_exact_tags' | 'already_absent';
  drainSeconds: number;
  drainCompleted: boolean;
};
function requireCurrentPromotion(
  state: State,
  body: NonNullable<Parameters<RetirementIO['patchTraffic']>[0]>,
) {
  const current = state.snapshot.desired.find((row) => row.percent === 100);
  if (
    state.phase !== 'promotedP' ||
    state.admissionPossible ||
    state.retirementAttempt ||
    !current ||
    body.name !== WEB_SERVICE ||
    body.etag !== state.snapshot.etag ||
    Object.keys(body).sort().join(',') !== 'etag,name,traffic' ||
    body.traffic.length !== 1
  )
    throw new Error('Captured lifecycle does not match retirement request');
  const row = body.traffic[0] as Record<string, unknown> | undefined;
  const expected = state.snapshot.desired.find((entry) => entry.tag.startsWith('candidate-'));
  if (
    !expected ||
    !row ||
    Object.keys(row).sort().join(',') !== 'percent,revision,tag,type' ||
    row.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' ||
    row.revision !== expected.revision ||
    row.tag !== expected.tag ||
    row.percent !== 100 ||
    current.tag !== expected.tag ||
    current.revision !== expected.revision
  )
    throw new Error('Retirement would not preserve the exact paused candidate');
}

/**
 * Existing retirement executor keeps its planning, one-target CAS, postcheck
 * and mandatory drain. This wrapper durably binds its actual returned LRO
 * before allowing the executor to wait on that exact object.
 */
export function bindCapturedRetirementToLifecycle(
  prior: State,
  io: RetirementIO,
  receipts: ReceiptSink,
) {
  let attempted: State | undefined,
    bound: State | undefined,
    delegated = false;
  const markUnresolved = () => {
    const unresolved = bound ?? attempted;
    if (!unresolved || unresolved.retirementAttempt?.outcome === 'unknown') return;
    const held = unknownCapturedRetirement(unresolved);
    receipts.recordIntent(held);
    bound = held;
  };
  const wrapped: RetirementIO = {
    readService: () => io.readService(),
    readRevision: (revision) => io.readRevision(revision),
    patchTraffic: async (body) => {
      if (delegated) throw new Error('Captured retirement is single-attempt');
      requireCurrentPromotion(prior, body);
      delegated = true;
      attempted = beginCapturedRetirement(prior);
      receipts.recordIntent(attempted);
      let operation: unknown;
      try {
        operation = await io.patchTraffic(body);
        const name = operationName(operation);
        bound = bindCapturedRetirementOperation(attempted, name);
        receipts.recordIntent(bound);
        return operation;
      } catch {
        if (attempted) {
          try {
            markUnresolved();
          } catch {
            /* The immutable prewrite receipt remains the fail-closed evidence. */
          }
        }
        throw new Error('Captured retirement outcome is unresolved; release is held');
      }
    },
    waitOperation: async (operation) => {
      if (!bound || operationName(operation) !== bound.retirementAttempt?.operation)
        throw new Error('Captured retirement operation binding changed');
      try {
        await io.waitOperation(operation);
      } catch {
        try {
          markUnresolved();
        } catch {
          /* The immutable operation receipt remains the fail-closed evidence. */
        }
        throw new Error('Captured retirement operation is unresolved; release is held');
      }
    },
    drain: (seconds) => io.drain(seconds),
  };
  return {
    io: wrapped,
    markUnresolved,
    complete(result: RetirementResult, after: Snapshot) {
      if (
        bound?.retirementAttempt?.outcome !== 'attempted' ||
        typeof bound.retirementAttempt.operation !== 'string' ||
        result.action !== 'retire_exact_tags' ||
        result.drainSeconds !== 600 ||
        result.drainCompleted !== true
      )
        throw new Error('Captured retirement completion is unconfirmed');
      const settled = acceptCapturedRetirement(bound, after, {
        source: bound.context.source,
        runId: bound.context.runId,
        attempt: bound.context.attempt,
        manifest: bound.context.manifest,
        beforeReceipt: bound.receipt,
        serviceUid: after.uid,
        etag: result.serviceEtag,
        generation: result.serviceGeneration,
        drainSeconds: result.drainSeconds,
        drainCompleted: result.drainCompleted,
        operation: bound.retirementAttempt.operation,
      });
      receipts.recordCheckpoint(settled);
      return settled;
    },
  };
}
