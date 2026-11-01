import {
  normalizeContactAliases,
  normalizeContactName,
} from '@assistant/persistence/contact-names';
import {
  OWNER_EDITOR_COMMANDS,
  type OwnerEditorApply,
  type OwnerEditorCommand,
  type OwnerEditorRequest,
  type OwnerEditorScope,
} from '@assistant/persistence/owner-editor';
import { PREDICATE_VOCABULARY } from '@assistant/persistence/predicate-vocabulary';
import { z } from 'zod';

export { ownerEditorCanonicalApply } from './owner-editor-canonical.js';

export const OWNER_EDITOR_MAX_BODY_BYTES = 16_384;
export const OWNER_EDITOR_BODY_TIMEOUT_MS = 5_000;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const familyPredicates = new Set(
  PREDICATE_VOCABULARY.filter(
    (p) =>
      p.group === 'family' && p.subjectKinds.includes('person') && p.objectKinds.includes('person'),
  ).map((p) => p.id),
);

/** Converters such as Date.UTC normalize invalid dates; validate first. */
export function isOwnerEditorCivilDay(value: string): boolean {
  const match = /^(1\d{3}|2\d{3})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}
const day = z.string().refine(isOwnerEditorCivilDay, 'Enter a real date in YYYY-MM-DD format.');
const validity = z
  .strictObject({ validFrom: day.nullable(), validUntil: day.nullable() })
  .refine((v) => v.validFrom === null || v.validUntil === null || v.validFrom <= v.validUntil, {
    message: 'The end date must be on or after the start date.',
    path: ['validUntil'],
  });
const familyShape = {
  subjectContactId: uuid,
  objectContactId: uuid,
  expectedSubjectRevision: revision,
  expectedObjectRevision: revision,
  predicate: z
    .string()
    .refine((p) => familyPredicates.has(p), 'Choose a supported family relationship.'),
  timing: z.enum(['unspecified', 'present', 'past']),
  validity,
  note: z.string().max(4_000),
  expectedCanonicalState: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('absent') }),
    z.strictObject({ kind: z.literal('revision'), revision }),
  ]),
};
const family = z.strictObject(familyShape).superRefine((v, ctx) => {
  if (v.subjectContactId.toLowerCase() === v.objectContactId.toLowerCase())
    ctx.addIssue({
      code: 'custom',
      path: ['objectContactId'],
      message: 'Choose two different people.',
    });
  if (v.predicate.startsWith('former_') && v.timing !== 'past')
    ctx.addIssue({
      code: 'custom',
      path: ['timing'],
      message: 'A former relationship must be marked as past.',
    });
  if (v.note.replace(/\s+/g, ' ').trim().length > 1_000)
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'Keep the note to 1,000 characters.' });
});
const envelope = { version: z.literal(1), intent: z.literal('apply'), operationId: uuid };
const identity = { name: z.string().max(4_000), aliases: z.array(z.string().max(4_000)).max(20) };
const applySchema = z.discriminatedUnion('command', [
  z.strictObject({ ...envelope, command: z.literal('create_person'), ...identity }),
  z.strictObject({
    ...envelope,
    command: z.literal('update_person_identity'),
    contactId: uuid,
    expectedContactRevision: revision,
    ...identity,
  }),
  z.strictObject({ ...envelope, command: z.literal('add_family_relationship'), ...familyShape }),
  z.strictObject({
    ...envelope,
    command: z.literal('correct_owner_family_relationship'),
    targetRelationId: uuid,
    expectedTargetRevision: revision,
    replacement: family,
  }),
  z.strictObject({
    ...envelope,
    command: z.literal('correct_owner_memory'),
    memoryId: uuid,
    expectedContentHash: revision,
    expectedMemoryRevision: revision,
    content: z
      .string()
      .transform((content) => content.trim())
      .pipe(z.string().min(3).max(4_000)),
  }),
]);
const reconcileSchema = z.strictObject({
  version: z.literal(1),
  intent: z.literal('reconcile'),
  command: z.enum(OWNER_EDITOR_COMMANDS),
  operationId: uuid,
  receiptBindingToken: z.string().min(1).max(8_192),
});

export function ownerEditorPath(command: OwnerEditorCommand): string {
  switch (command) {
    case 'create_person':
    case 'update_person_identity':
      return '/api/people/editor';
    case 'add_family_relationship':
    case 'correct_owner_family_relationship':
      return '/api/profile/knowledge/family';
    case 'correct_owner_memory':
      return '/api/profile/knowledge/memory';
    case 'remove_person':
      return '/api/people/editor';
    case 'remove_owner_family_relationship':
      return '/api/profile/knowledge/family';
  }
}

export function ownerEditorApplyMatchesScope(
  request: OwnerEditorApply,
  scope: OwnerEditorScope,
): boolean {
  const target = (() => {
    switch (request.command) {
      case 'create_person':
        return scope.targetId === null;
      case 'update_person_identity':
        return scope.targetId === request.contactId;
      case 'add_family_relationship':
        return (
          scope.targetId === request.subjectContactId || scope.targetId === request.objectContactId
        );
      case 'correct_owner_family_relationship':
        return scope.targetId === request.targetRelationId;
      case 'correct_owner_memory':
        return scope.targetId === request.memoryId;
      case 'remove_person':
      case 'remove_owner_family_relationship':
        return false;
    }
  })();
  return (
    target === true &&
    scope.operationId === request.operationId &&
    scope.command === request.command
  );
}

export type OwnerEditorParseResult =
  | { ok: true; request: OwnerEditorRequest }
  | { ok: false; fieldErrors: Record<string, string> };

export function parseOwnerEditorRequest(value: unknown, path: string): OwnerEditorParseResult {
  const isReconcile =
    typeof value === 'object' &&
    value !== null &&
    'intent' in value &&
    value.intent === 'reconcile';
  const parsed = isReconcile ? reconcileSchema.safeParse(value) : applySchema.safeParse(value);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[issue.path.join('.') || 'request'] ??= issue.message;
    return { ok: false, fieldErrors };
  }
  const request = parsed.data;
  if (ownerEditorPath(request.command) !== path)
    return { ok: false, fieldErrors: { command: 'This command is not available on this route.' } };
  if (request.intent === 'reconcile') return { ok: true, request };
  if (request.command === 'create_person' || request.command === 'update_person_identity') {
    try {
      request.name = normalizeContactName(request.name);
    } catch (error) {
      return {
        ok: false,
        fieldErrors: { name: error instanceof Error ? error.message : 'Check the name.' },
      };
    }
    try {
      request.aliases = normalizeContactAliases(request.aliases, request.name);
    } catch (error) {
      return {
        ok: false,
        fieldErrors: { aliases: error instanceof Error ? error.message : 'Check the aliases.' },
      };
    }
  } else if (request.command === 'correct_owner_memory') {
    request.content = request.content.trim();
    if (request.content.length < 3 || request.content.length > 4_000)
      return {
        ok: false,
        fieldErrors: { content: 'Enter a saved note between 3 and 4,000 characters.' },
      };
  } else {
    const fields = request.command === 'add_family_relationship' ? request : request.replacement;
    const checked = family.safeParse({
      subjectContactId: fields.subjectContactId,
      objectContactId: fields.objectContactId,
      expectedSubjectRevision: fields.expectedSubjectRevision,
      expectedObjectRevision: fields.expectedObjectRevision,
      predicate: fields.predicate,
      timing: fields.timing,
      validity: fields.validity,
      note: fields.note,
      expectedCanonicalState: fields.expectedCanonicalState,
    });
    if (!checked.success) {
      const prefix = request.command === 'correct_owner_family_relationship' ? 'replacement.' : '';
      return {
        ok: false,
        fieldErrors: Object.fromEntries(
          checked.error.issues.map((i) => [prefix + i.path.join('.'), i.message]),
        ),
      };
    }
    fields.note = fields.note.replace(/\s+/g, ' ').trim();
  }
  return { ok: true, request };
}
