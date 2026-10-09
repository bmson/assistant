import { z } from 'zod';

export const RequestedOutcomeSchema = z.object({
  /** Exact owner-authored clause, never a generated task or permission. */
  requestSpan: z.string().min(3).max(500),
});
export const RequestChecklistSchema = z.object({
  version: z.literal(1),
  request: z.string().max(8_000),
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
          .object({ messageId: z.string().min(1), requestSpan: z.string().min(1).max(500) })
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
