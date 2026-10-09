import { z } from 'zod';

const title = z.string().trim().min(1).max(160);
const detail = z.string().trim().max(2000);
const itemId = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/);
export const PackSourceSchema = z.object({
  kind: z.enum(['card', 'commitment']),
  id: z.string().uuid(),
});
export const PackItemInputSchema = z.object({
  id: itemId,
  title,
  details: detail.default(''),
  lane: z.enum(['plan', 'i_owe', 'waiting_on']).default('plan'),
  dependsOn: z.array(itemId).max(30).default([]),
  source: PackSourceSchema.nullable().default(null),
});
export const PackSnapshotSchema = z.object({
  revision: z.string(),
  state: z.string(),
  title: z.string(),
  details: z.string(),
});
export const PackItemSchema = PackItemInputSchema.extend({
  snapshot: PackSnapshotSchema.nullable().default(null),
  needsReview: z.boolean().default(false),
});
export const PackDecisionSchema = z.object({
  id: itemId,
  option: title,
  outcome: z.enum(['chosen', 'rejected']),
  reason: detail.refine((value) => value.length > 0, 'A reason is required'),
  scope: z.enum(['situation', 'preference']).default('situation'),
  confirmed: z.boolean().default(false),
});
export const PackDataSchema = z.object({
  items: z.array(PackItemSchema).max(30).default([]),
  decisions: z.array(PackDecisionSchema).max(30).default([]),
});
export type PackData = z.infer<typeof PackDataSchema>;
export type PackItem = z.infer<typeof PackItemSchema>;
export type PackSnapshot = z.infer<typeof PackSnapshotSchema>;

export interface SituationPackView {
  id: string;
  title: string;
  version: number;
  archived: boolean;
  updatedAt: string;
  data: PackData;
  changes: { itemId: string; before: PackSnapshot | null; after: PackSnapshot | null }[];
  affectedIds: string[];
}

/** A confirmed situation choice with the exact pack revision it came from. */
export interface SituationDecisionContext {
  decisionId: string;
  option: string;
  outcome: 'chosen' | 'rejected';
  reason: string;
  scope: 'situation' | 'preference';
  packId: string;
  packTitle: string;
  packVersion: number;
  packUpdatedAt: string;
  relevance: number;
}

const CONTEXT_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'before',
  'could',
  'from',
  'have',
  'into',
  'just',
  'like',
  'more',
  'most',
  'that',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
  'your',
]);

function contextTerms(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (term) => !CONTEXT_STOP_WORDS.has(term),
  );
}

/**
 * Select owner-confirmed decisions relevant to a bounded discussion frame.
 * Each pack is an independent source: contradictory choices in different
 * packs stay visible as separate evidence instead of a last-write-wins map.
 */
export function selectSituationDecisionContext(
  packs: ReadonlyArray<
    Pick<SituationPackView, 'id' | 'title' | 'version' | 'archived' | 'updatedAt'> & {
      data: unknown;
    }
  >,
  query: string,
  limit = 12,
): SituationDecisionContext[] {
  const terms = [...new Set(contextTerms(query).reverse())].slice(0, 128);
  if (terms.length === 0) return [];

  const candidates: Array<SituationDecisionContext & { optionKey: string }> = [];
  for (const pack of packs) {
    if (pack.archived) continue;
    const parsed = PackDataSchema.safeParse(pack.data);
    if (!parsed.success) continue;
    const packContext = [
      pack.title,
      ...parsed.data.items.flatMap((item) => [item.title, item.details]),
    ]
      .join(' ')
      .toLocaleLowerCase();
    const packTerms = new Set(contextTerms(packContext));
    for (const decision of parsed.data.decisions) {
      if (!decision.confirmed) continue;
      const decisionTerms = new Set(contextTerms(`${decision.option} ${decision.reason}`));
      const decisionScore = terms.reduce(
        (score, term) => score + Number(decisionTerms.has(term)),
        0,
      );
      const contextScore = terms.reduce((score, term) => score + Number(packTerms.has(term)), 0);
      // A situation-only choice must be connected to the pack or its decision
      // wording. A lasting preference needs a direct match to its own claim.
      if (
        decisionScore === 0 ||
        (decision.scope === 'situation' && contextScore === 0 && decisionScore < 2)
      )
        continue;
      candidates.push({
        decisionId: decision.id,
        option: decision.option,
        outcome: decision.outcome,
        reason: decision.reason,
        scope: decision.scope,
        packId: pack.id,
        packTitle: pack.title,
        packVersion: pack.version,
        packUpdatedAt: pack.updatedAt,
        relevance: decisionScore * 2 + contextScore,
        optionKey: decision.option.trim().toLocaleLowerCase(),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      b.packUpdatedAt.localeCompare(a.packUpdatedAt) ||
      a.packId.localeCompare(b.packId) ||
      a.decisionId.localeCompare(b.decisionId),
  );
  const max = Math.max(1, Math.min(limit, 24));
  const selected = candidates.slice(0, max);
  const selectedIds = new Set(
    selected.map((candidate) => `${candidate.packId}:${candidate.decisionId}`),
  );
  // If a selected option has credible opposing evidence in another pack,
  // retain the best opposing record even when it falls just below the limit.
  for (const candidate of selected) {
    const opposing = candidates.find(
      (other) =>
        other.optionKey === candidate.optionKey &&
        other.outcome !== candidate.outcome &&
        other.packId !== candidate.packId &&
        !selectedIds.has(`${other.packId}:${other.decisionId}`),
    );
    if (opposing) {
      selected.push(opposing);
      selectedIds.add(`${opposing.packId}:${opposing.decisionId}`);
    }
  }
  return selected.map(({ optionKey: _optionKey, ...candidate }) => candidate);
}

/** No orphan edges or cycles: propagation must always have an explainable path. */
export function validatePack(data: PackData): void {
  PackDataSchema.parse(data);
  const items = new Map(data.items.map((item) => [item.id, item]));
  if (items.size !== data.items.length) throw new Error('Item IDs must be unique.');
  if (new Set(data.decisions.map((item) => item.id)).size !== data.decisions.length)
    throw new Error('Decision IDs must be unique.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Dependencies cannot form a cycle.');
    if (visited.has(id)) return;
    const item = items.get(id);
    if (!item) throw new Error('A dependency does not exist in this pack.');
    visiting.add(id);
    for (const dependency of item.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of items.keys()) visit(id);
}

export function affectedItems(items: PackItem[], changedIds: string[]): string[] {
  const affected = new Set(changedIds);
  for (let pass = 0; pass < items.length; pass++) {
    for (const item of items) {
      if (item.dependsOn.some((id) => affected.has(id))) affected.add(item.id);
    }
  }
  return items.filter((item) => affected.has(item.id)).map((item) => item.id);
}

export const PackCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('forget_decision'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    decisionId: itemId,
  }),
  z.object({ action: z.literal('create'), title, creationKey: z.string().min(1).max(100) }),
  z.object({
    action: z.literal('item'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    item: PackItemInputSchema,
  }),
  z.object({
    action: z.literal('decision'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    decision: PackDecisionSchema,
  }),
  z.object({
    action: z.literal('preview'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    item: PackItemInputSchema,
  }),
  z.object({ action: z.literal('apply'), packId: z.string().uuid(), previewId: z.string().uuid() }),
  z.object({
    action: z.literal('dismiss_preview'),
    packId: z.string().uuid(),
    previewId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('archive'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('reviewed'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    itemId,
  }),
]);
export type PackCommand = z.infer<typeof PackCommandSchema>;

export function isSituationRequest(text: string): boolean {
  if (
    /\b(situation packs?|my packs?|this pack|the pack|create a pack|build a pack|decision memory)\b/i.test(
      text,
    )
  )
    return true;
  // Ordinary conceptual hypotheticals must not trigger private-account reads.
  const planningSubject = /\b(hotel|booking|flight|itinerary|trip|reservation|plan)\b/i.test(text);
  return (
    planningSubject &&
    ((/\bwhat[- ]if\b/i.test(text) &&
      /\b(change|replace|move|switch|cancel|delay)\b/i.test(text)) ||
      /\brehearse (?:this|a|the|my|our)\b/i.test(text))
  );
}
