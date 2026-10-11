import { z } from 'zod';

export const RequestedOutcomeSchema = z.object({
  /** Exact owner-authored clause, never a generated task or permission. */
  requestSpan: z.string().min(3).max(500),
});
const ChecklistRevisionAuditSchema = z.object({
  revision: z.number().int().min(1).max(12),
  taskId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128),
  ownerTaskId: z.string().min(1).max(128),
  ownerMessageId: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128),
  fromLabel: z.string().min(1).max(500),
  fromTargetTerms: z.array(z.string().min(1).max(100)).max(8),
  toLabel: z.string().min(1).max(500),
  /** Present on newly authored audits; optional for existing v1 history. */
  toKind: z
    .enum(['lookup', 'save', 'card', 'reminder', 'send', 'draft', 'document', 'calendar'])
    .optional(),
  toTargetTerms: z.array(z.string().min(1).max(100)).max(8),
  excludedEvidenceIds: z.array(z.string().min(1).max(128)).max(256),
});
const ChecklistCancellationAuditSchema = z.object({
  revision: z.number().int().min(1).max(12),
  /** Checklist replacement revision observed when this cancellation was recorded. */
  checklistRevision: z.number().int().min(0).max(12).optional(),
  taskId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128),
  ownerTaskId: z.string().min(1).max(128),
  ownerMessageId: z.string().min(1).max(128),
  itemIds: z.array(z.string().min(1).max(128)).min(1).max(12),
  requestSpans: z.array(z.string().min(1).max(500)).min(1).max(12),
});
const ChecklistLastOwnerActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    revision: z.number().int().min(1).max(12),
    ownerMessageId: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128),
  }),
  z.object({
    kind: z.literal('cancel'),
    revision: z.number().int().min(1).max(12),
    ownerMessageId: z.string().min(1).max(128),
    itemIds: z.array(z.string().min(1).max(128)).min(1).max(12),
  }),
]);
export const RequestChecklistSchema = z.object({
  version: z.literal(1),
  request: z.string().max(8_000),
  /** Optional for backward-compatible v1 records. */
  revision: z.number().int().min(0).max(12).optional(),
  /** Bounded, runtime-authored correction history; never supplied by a model. */
  revisionAudit: z.array(ChecklistRevisionAuditSchema).max(12).optional(),
  /** Independently versioned owner cancellations; replacement history is retained. */
  cancellationRevision: z.number().int().min(0).max(12).optional(),
  cancellationAudit: z.array(ChecklistCancellationAuditSchema).max(12).optional(),
  /** Distinguishes the latest owner operation when both histories exist. */
  lastOwnerAction: ChecklistLastOwnerActionSchema.optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().max(500),
        kind: z.enum([
          'lookup',
          'save',
          'card',
          'reminder',
          'send',
          'draft',
          'document',
          'calendar',
        ]),
        targetTerms: z.array(z.string()).max(8),
        status: z.enum(['pending', 'completed', 'blocked', 'awaiting_approval', 'cancelled']),
        /** Only populated from an authenticated owner message by the runtime. */
        ownerCancellation: z
          .object({
            messageId: z.string().min(1),
            requestSpan: z.string().min(1).max(500),
          })
          .optional(),
        evidence: z.array(z.object({ id: z.string(), toolName: z.string() })),
        detail: z.string().optional(),
      }),
    )
    .max(12),
  /** Written only after persistGeneratedCard succeeds, never from model output. */
  savedCards: z
    .array(z.object({ id: z.string(), revisionId: z.string(), title: z.string() }))
    .default([]),
});
export type RequestChecklist = z.infer<typeof RequestChecklistSchema>;
