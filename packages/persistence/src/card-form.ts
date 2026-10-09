import { z } from 'zod';

const Id = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());
// The native/client contract counts UTF-16 units. Zod's max counts code points.
const Label = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value.length <= 60);
const Common = {
  id: Id,
  label: Label,
  required: z.boolean().default(false),
  defaultFact: Id.optional(),
  sensitive: z.boolean().default(false),
};

export const CardFormFieldSchema = z.discriminatedUnion('type', [
  z.object({ ...Common, type: z.literal('text') }).strict(),
  z.object({ ...Common, type: z.literal('date') }).strict(),
  z.object({ ...Common, type: z.literal('boolean') }).strict(),
  z
    .object({
      ...Common,
      type: z.literal('choice'),
      options: z
        .array(z.object({ id: Id, label: Label }).strict())
        .min(2)
        .max(6),
    })
    .strict(),
]);

/** App-owned controls and one fixed owner-chat action; no model-selected route or tool. */
export const CardFormSchema = z
  .object({
    type: z.literal('form'),
    id: Id,
    title: Label,
    serverAction: z.literal('submit_owner_chat_turn'),
    submitLabel: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.length <= 40),
    warningFactIds: z.array(Id).max(4).default([]),
    fields: z.array(CardFormFieldSchema).min(1).max(4),
  })
  .strict()
  .superRefine((form, ctx) => {
    if (new Set(form.fields.map((field) => field.id)).size !== form.fields.length)
      ctx.addIssue({ code: 'custom', message: 'Field IDs must be unique' });
    for (const field of form.fields) {
      if (
        field.type === 'choice' &&
        new Set(field.options.map((option) => option.id)).size !== field.options.length
      )
        ctx.addIssue({ code: 'custom', message: 'Choice IDs must be unique' });
    }
  });

export type CardForm = z.infer<typeof CardFormSchema>;
export type CardFormValues = Record<string, string | boolean>;

/** Fields prefill an editable composer. Only the owner's Send admits this message. */
const ValuesSchema = z
  .custom<Record<string, unknown>>((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    // Validate before Zod's record parser, which discards __proto__ keys.
    return keys.length <= 4 && keys.every((key) => Id.safeParse(key).success);
  })
  .pipe(z.record(Id, z.union([z.string().refine((value) => value.length <= 500), z.boolean()])));

export const CardFormSubmissionSchema = z
  .object({
    protocol: z.literal('card-form-v1'),
    conversationId: Uuid,
    cardId: Uuid,
    expectedRevisionId: Uuid,
    formId: Id,
    operationId: Uuid,
    values: ValuesSchema,
    ownerMessageText: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.length <= 4000),
  })
  .strict();
export type CardFormSubmission = z.infer<typeof CardFormSubmissionSchema>;

function calendarDate(value: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Order is presentation only. Optional empty text is omitted; false is a real answer. */
export function canonicalCardFormValues(
  form: CardForm,
  values: CardFormValues,
): CardFormValues | null {
  const allowed = new Set(form.fields.map((field) => field.id));
  if (Object.keys(values).some((id) => !allowed.has(id))) return null;
  const result: CardFormValues = Object.create(null);
  for (const field of [...form.fields].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    // Private inputs need a complete storage/projection contract before admission.
    if (field.sensitive) return null;
    const raw = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    if (raw === undefined || raw === '') {
      if (field.required) return null;
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof raw !== 'boolean') return null;
      result[field.id] = raw;
      continue;
    }
    if (typeof raw !== 'string') return null;
    const value = field.type === 'text' ? raw.trim() : raw;
    if (value.length > 500 || (field.required && !value)) return null;
    if (field.type === 'date' && !calendarDate(value)) return null;
    if (field.type === 'choice' && !field.options.some((option) => option.id === value))
      return null;
    if (value) result[field.id] = value;
  }
  return result;
}

/** Used after validating persisted definition and values; owner text is part of retry identity. */
export function canonicalCardFormRequest(
  submission: CardFormSubmission,
  values: CardFormValues,
): string {
  return JSON.stringify([
    submission.protocol,
    submission.conversationId,
    submission.cardId,
    submission.expectedRevisionId,
    submission.formId,
    'submit_owner_chat_turn',
    Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    submission.ownerMessageText,
  ]);
}

/** A card has at most one section level. Never recurse through untrusted spec data. */
export function findCardForm(spec: unknown, formId: string): CardForm | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const blocks = (spec as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 12) return null;
  const leaves: unknown[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
    const row = block as Record<string, unknown>;
    if (row.type !== 'section') {
      leaves.push(block);
      continue;
    }
    if (!Array.isArray(row.blocks) || row.blocks.length < 1 || row.blocks.length > 6) return null;
    for (const child of row.blocks) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) return null;
      if ((child as { type?: unknown }).type === 'section') return null;
      leaves.push(child);
    }
  }
  const matches = leaves.filter(
    (leaf) =>
      (leaf as { type?: unknown }).type === 'form' && (leaf as { id?: unknown }).id === formId,
  );
  if (matches.length !== 1) return null;
  const parsed = CardFormSchema.safeParse(matches[0]);
  return parsed.success ? parsed.data : null;
}
