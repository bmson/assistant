import { z } from 'zod';
import {
  OWNER_EDITOR_COMMANDS,
  type OwnerEditorEpochCursor,
  type OwnerEditorMaintenanceBinder,
  type OwnerEditorOperationRecord,
  type OwnerEditorTerminalResult,
} from './owner-editor.js';
import { ownerEditorMaintenanceTargetEpochDigest } from './owner-editor-identity.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const ids = z
  .strictObject({
    contactId: uuid.optional(),
    relationId: uuid.optional(),
    previousRelationId: uuid.optional(),
    memoryId: uuid.optional(),
    assertionId: uuid.optional(),
  })
  .refine(
    (v) => Boolean(v.contactId || v.relationId || v.memoryId || v.assertionId),
    'A saved receipt needs durable identity',
  );
const result = z.union([
  z.strictObject({
    outcome: z.enum(['saved', 'unchanged']),
    ids,
    revision: hash,
    refreshPending: z.boolean().optional(),
  }),
  z.strictObject({ outcome: z.literal('conflict'), reason: z.string().min(1).max(200) }),
  z.strictObject({
    outcome: z.literal('invalid'),
    fieldErrors: z.record(z.string(), z.string().max(500)),
  }),
  z.strictObject({ outcome: z.literal('unavailable'), reason: z.string().min(1).max(200) }),
  z.strictObject({
    outcome: z.literal('not_applied'),
    reason: z.enum(['claim_abandoned', 'preparation_failed']),
  }),
]);
const operation = z
  .strictObject({
    id: hash,
    ownerId: uuid,
    epoch: uuid,
    privacyGenerationDigest: hash,
    operationId: uuid,
    requestHash: hash,
    scopeDigest: hash,
    command: z.enum(OWNER_EDITOR_COMMANDS),
    protocolVersion: z.literal(1),
    formIssuedAt: z.date(),
    formExpiresAt: z.date(),
    claimToken: uuid.nullable(),
    claimExpiresAt: z.date().nullable(),
    statusVersion: z.number().int().positive(),
    status: z.enum(['preparing', 'committed', 'terminal_rejected', 'abandoned']),
    result: result.nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .superRefine((v, ctx) => {
    const pending = v.status === 'preparing';
    if (
      v.formExpiresAt <= v.formIssuedAt ||
      pending !== (v.result === null) ||
      pending !== (v.claimToken !== null && v.claimExpiresAt !== null) ||
      (!pending && (v.claimToken !== null || v.claimExpiresAt !== null))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid editor receipt state' });
    if (
      v.result &&
      ((v.status === 'committed') !== ['saved', 'unchanged'].includes(v.result.outcome) ||
        (v.status === 'abandoned') !== (v.result.outcome === 'not_applied'))
    )
      ctx.addIssue({ code: 'custom', message: 'Editor terminal outcome does not match state' });
  });

export function parseOwnerEditorTerminalResult(value: unknown): OwnerEditorTerminalResult {
  return result.parse(value);
}
export function parseOwnerEditorOperationRecord(value: unknown): OwnerEditorOperationRecord {
  return operation.parse(value);
}
const maintenanceBinder = z.strictObject({
  version: z.literal(1),
  operationId: uuid,
  requestDigest: hash,
  action: z.enum(['provision-disabled', 'enable', 'disable']),
  targetEpochDigest: hash,
});
const epochCursor = z
  .strictObject({
    ownerId: uuid,
    epoch: uuid,
    ready: z.boolean(),
    privacyGenerationDigest: hash,
    maintenanceBinder: maintenanceBinder.optional(),
  })
  .superRefine((cursor, ctx) => {
    const binder = cursor.maintenanceBinder;
    if (!binder) return;
    if (cursor.ready !== (binder.action === 'enable'))
      ctx.addIssue({
        code: 'custom',
        message: 'Editor maintenance action does not match readiness',
      });
    if (binder.targetEpochDigest !== ownerEditorMaintenanceTargetEpochDigest(cursor.epoch))
      ctx.addIssue({ code: 'custom', message: 'Editor maintenance target does not match epoch' });
  });

export function parseOwnerEditorEpochCursor(value: unknown): OwnerEditorEpochCursor {
  return epochCursor.parse(value);
}

export function parseOwnerEditorMaintenanceBinder(value: unknown): OwnerEditorMaintenanceBinder {
  return maintenanceBinder.parse(value);
}

export function ownerEditorEpochCursorWithoutMaintenanceBinder(
  cursor: OwnerEditorEpochCursor,
): Omit<OwnerEditorEpochCursor, 'maintenanceBinder'> {
  const withoutBinder = { ...cursor };
  delete withoutBinder.maintenanceBinder;
  return withoutBinder;
}
