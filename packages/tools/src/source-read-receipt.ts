import { z } from 'zod';

const SourceRangeSchema = z.object({
  sourceId: z.string().optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  startRow: z.number().int().nonnegative().optional(),
  startColumn: z.number().int().nonnegative().optional(),
  endRow: z.number().int().nonnegative().optional(),
  endColumn: z.number().int().nonnegative().optional(),
});

/**
 * Shared, additive evidence receipt for bounded provider reads. `requested`
 * and `covered` describe the source boundary; `continuation` is an exact
 * same-tool input when the reader supports resuming it. Existing tool result
 * fields remain available for older consumers.
 */
export const SourceReadReceiptSchema = z.object({
  version: z.literal(1),
  source: z.object({
    kind: z.enum([
      'google-doc',
      'google-drive-file',
      'google-sheet',
      'gmail-search',
      'gmail-thread',
    ]),
    id: z.string().min(1).max(256),
    revision: z.string().max(256).optional(),
  }),
  requested: z
    .object({
      start: z.number().int().nonnegative().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
      cursor: z.string().max(4096).optional(),
      sheetIds: z.array(z.number().int().nonnegative()).max(20).optional(),
      ranges: z.array(SourceRangeSchema).max(200).optional(),
      scope: z.string().max(100).optional(),
    })
    .passthrough(),
  covered: z
    .object({
      start: z.number().int().nonnegative().optional(),
      offset: z.number().int().nonnegative().optional(),
      end: z.number().int().nonnegative().optional(),
      count: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().nullable().optional(),
      unavailable: z.number().int().nonnegative().default(0),
      ranges: z.array(SourceRangeSchema).max(200).optional(),
    })
    .passthrough(),
  complete: z.boolean(),
  losses: z
    .array(
      z.enum([
        'character-budget',
        'range-limit',
        'provider-page',
        'unavailable-item',
        'unsupported-representation',
        'coverage-unknown',
        'empty-source',
        'continuation-unavailable',
      ]),
    )
    .max(8),
  continuation: z
    .object({
      tool: z.string().min(1).max(80),
      input: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});

export type SourceReadReceipt = z.infer<typeof SourceReadReceiptSchema>;

export function sourceReadReceipt(receipt: SourceReadReceipt): SourceReadReceipt {
  return SourceReadReceiptSchema.parse(receipt);
}

/** Slice JavaScript text at UTF-16 offsets without splitting a surrogate pair. */
export function boundedTextPage(text: string, start: number, limit: number) {
  let safeStart = Math.max(0, Math.min(start, text.length));
  if (safeStart > 0 && safeStart < text.length) {
    const previous = text.charCodeAt(safeStart - 1);
    const current = text.charCodeAt(safeStart);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
      safeStart += 1;
  }
  let end = Math.min(text.length, safeStart + limit);
  if (end > safeStart && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const current = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
      end -= 1;
  }
  return { text: text.slice(safeStart, end), start: safeStart, end };
}
