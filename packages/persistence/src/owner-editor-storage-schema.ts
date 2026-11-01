import { z } from 'zod';
import { OWNER_EDITOR_COMMANDS } from './owner-editor.js';

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
export const ownerEditorTerminalResultSchema = z.union([
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

const operationFields = {
  id: hash,
  ownerId: uuid,
  epoch: uuid,
  privacyGenerationDigest: hash,
  operationId: uuid,
  requestHash: hash,
  scopeDigest: hash,
  protocolVersion: z.literal(1),
  formIssuedAt: z.date(),
  formExpiresAt: z.date(),
  claimToken: uuid.nullable(),
  claimExpiresAt: z.date().nullable(),
  statusVersion: z.number().int().positive(),
  status: z.enum(['preparing', 'committed', 'terminal_rejected', 'abandoned']),
  result: ownerEditorTerminalResultSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};
const operationBase = z.strictObject({ ...operationFields, command: z.string() });
function refineOperation(v: z.infer<typeof operationBase>, ctx: z.RefinementCtx) {
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
  if (
    v.result &&
    (v.result.outcome === 'saved' || v.result.outcome === 'unchanged') &&
    v.command === 'correct_owner_memory' &&
    (Object.keys(v.result.ids).length !== 1 || !v.result.ids.memoryId)
  )
    ctx.addIssue({ code: 'custom', message: 'Memory correction receipt identity is invalid' });
}

export const ownerEditorOperationRecordSchema = operationBase
  .extend({ command: z.enum(OWNER_EDITOR_COMMANDS) })
  .superRefine(refineOperation);

export const inactiveOwnerFamilyRemovalOperationRecordSchema = operationBase
  .extend({ command: z.literal('remove_owner_family_relationship') })
  .superRefine((v, ctx) => {
    refineOperation(v, ctx);
    if (
      v.result &&
      (v.result.outcome === 'saved' || v.result.outcome === 'unchanged') &&
      (Object.keys(v.result.ids).length !== 3 ||
        !v.result.ids.relationId ||
        !v.result.ids.memoryId ||
        !v.result.ids.assertionId)
    )
      ctx.addIssue({ code: 'custom', message: 'Family removal receipt identity is invalid' });
  });

export const ownerEditorEpochCursorSchema = z.strictObject({
  ownerId: uuid,
  epoch: uuid,
  ready: z.boolean(),
  privacyGenerationDigest: hash,
});

export const inactiveOwnerFamilyRemovalRequestSchema = z.strictObject({
  version: z.literal(1),
  intent: z.literal('apply'),
  command: z.literal('remove_owner_family_relationship'),
  operationId: uuid,
  targetRelationId: uuid,
  expectedTargetRevision: hash,
});

export const inactiveOwnerFamilyRemovalCacheCursorSchema = z.strictObject({
  version: z.literal(1),
  ownerId: uuid,
  installationLineageId: z.string().min(1).max(200),
  revision: uuid,
  protocolVersion: z.literal(1),
  state: z.literal('active'),
});

export const inactiveOwnerFamilyRejectionMarkerSchema = z
  .strictObject({
    version: z.literal(2),
    id: hash,
    installationLineageId: z.string().min(1).max(200),
    ownerId: uuid,
    sourceMemoryId: uuid,
    state: z.literal('active'),
    stableContactMeaningKey: hash,
    meaning: z.strictObject({
      subjectContactId: uuid,
      objectContactId: uuid,
      predicate: z.string().min(1).max(120),
      assertion: z.strictObject({
        tense: z.enum(['unspecified', 'present', 'past']),
        polarity: z.literal('positive'),
        modality: z.literal('asserted'),
      }),
      validFrom: z.string().nullable(),
      validUntil: z.string().nullable(),
      qualifiers: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .refine((value) => Object.keys(value).length <= 64),
    }),
    original: z.strictObject({
      relationId: uuid,
      assertionId: uuid,
      evidenceId: uuid,
      subjectEntityId: uuid,
      objectEntityId: uuid,
      sourceContentHash: hash,
    }),
    operationId: uuid,
    requestHash: hash,
    reviewClosureHash: hash,
    createdAt: z.date(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4096,
    'Source rejection marker exceeds its UTF-8 storage limit',
  );

export type InactiveOwnerFamilyRemovalRequest = z.infer<
  typeof inactiveOwnerFamilyRemovalRequestSchema
>;
export type InactiveOwnerFamilyRemovalCacheCursor = z.infer<
  typeof inactiveOwnerFamilyRemovalCacheCursorSchema
>;
export type InactiveOwnerFamilyRejectionMarker = z.infer<
  typeof inactiveOwnerFamilyRejectionMarkerSchema
>;
