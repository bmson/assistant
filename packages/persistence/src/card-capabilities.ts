/** Client-safe vocabulary and reference contract shared by web and mobile projection. */
import { CardFormSchema } from './card-form.js';

type Row = Record<string, unknown>;
type Rule = {
  required?: readonly string[];
  optional?: readonly string[];
  ids?: { field: string; min: number; max: number };
  enums?: Record<string, readonly string[]>;
};

/** Structural limits shared by server projection and native render admission. */
export const GENERATED_CARD_LIMITS = {
  spec: {
    facts: { min: 1, max: 40 },
    blocks: { min: 1, max: 12 },
    actions: { max: 6 },
    title: { max: 100 },
    subtitle: { max: 160 },
    accessibilityLabel: { max: 200 },
    sourceLabel: { max: 80 },
    icons: [
      'ticket',
      'plane',
      'sport',
      'package',
      'calendar',
      'map',
      'music',
      'star',
      'train',
      'car',
      'hotel',
      'food',
      'money',
      'health',
      'weather',
      'checklist',
      'generic',
    ],
    accents: ['mint', 'sky', 'amber', 'rose', 'violet', 'slate'],
  },
  fact: {
    idPattern: '^[a-z0-9_-]{1,40}$',
    value: { max: 500 },
    label: { max: 60 },
    source: { max: 80 },
  },
  action: {
    idPattern: '^[a-z0-9_-]{1,40}$',
    types: [
      'open_url',
      'copy_value',
      'reveal_sensitive',
      'refresh',
      'ask_assistant',
      'add_to_calendar',
      'directions',
    ],
    label: { max: 40 },
    prompt: { max: 160 },
  },
  section: { depth: 0, title: { max: 60 }, blocks: { min: 1, max: 6 } },
  table: { columns: { min: 2, max: 4, titleMax: 60 }, rows: { min: 1, max: 8 } },
  chart: { points: { min: 2, max: 12 } },
} as const;

export const GENERATED_BLOCK_RULES = {
  hero: { required: ['titleFact'], optional: ['subtitleFact'] },
  facts: { ids: { field: 'factIds', min: 1, max: 8 } },
  timeline: { ids: { field: 'factIds', min: 1, max: 8 } },
  score: {
    required: ['leftLabelFact', 'leftValueFact', 'rightLabelFact', 'rightValueFact'],
    optional: ['statusFact'],
  },
  code: { required: ['valueFact'], enums: { format: ['qr', 'barcode', 'text'] } },
  image: { required: ['urlFact'], optional: ['altFact'] },
  note: { required: ['factId'] },
  metrics: { ids: { field: 'factIds', min: 2, max: 4 } },
  journey: {
    required: ['fromFact', 'toFact'],
    optional: ['departFact', 'arriveFact', 'statusFact', 'durationFact'],
    enums: { mode: ['flight', 'train', 'bus', 'car', 'ferry', 'walk'] },
  },
  progress: { required: ['valueFact'], optional: ['totalFact', 'labelFact'] },
  stages: { required: ['currentFact'], ids: { field: 'factIds', min: 2, max: 8 } },
  countdown: { required: ['dateFact'], optional: ['labelFact'] },
  table: {},
  chart: { enums: { kind: ['bar', 'line'] } },
  checklist: { ids: { field: 'factIds', min: 1, max: 12 } },
  map: { ids: { field: 'placeFactIds', min: 1, max: 6 } },
} as const satisfies Record<string, Rule>;

/** Serializable source contract consumed by generated native admission rules. */
export const GENERATED_CARD_NATIVE_CONTRACT = {
  version: 1,
  limits: GENERATED_CARD_LIMITS,
  rules: GENERATED_BLOCK_RULES,
  surfaces: { webShellOnly: ['map', 'codeNonText'] },
} as const;

export type GeneratedCardSurface = 'web' | 'native';
export type GeneratedFactMap = ReadonlyMap<string, Row>;
export type BlockCapability = { shell: boolean; full: boolean };

function row(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function bounded(value: unknown, min: number, max: number): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max;
}
export function safeCardHttpUrl(value: unknown): boolean {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function hasFact(facts: GeneratedFactMap, id: unknown): boolean {
  return text(id) && text(facts.get(id)?.value);
}

/** Unknown or malformed siblings never disappear from the full-support decision. */
export function generatedBlockCapability(
  value: unknown,
  facts: GeneratedFactMap,
  surface: GeneratedCardSurface,
  depth = 0,
  options: { formRendererAvailable?: boolean } = {},
): BlockCapability {
  const block = row(value);
  const unsupported = { shell: false, full: false };
  if (!block || !text(block.type)) return unsupported;
  if (block.type === 'section') {
    if (
      depth !== 0 ||
      !text(block.title) ||
      block.title.length > GENERATED_CARD_LIMITS.section.title.max ||
      !Array.isArray(block.blocks)
    )
      return unsupported;
    const children = block.blocks.map((child) =>
      generatedBlockCapability(child, facts, surface, 1, options),
    );
    return {
      shell: children.some((child) => child.shell),
      full:
        bounded(
          block.blocks,
          GENERATED_CARD_LIMITS.section.blocks.min,
          GENERATED_CARD_LIMITS.section.blocks.max,
        ) && children.every((child) => child.full),
    };
  }
  if (block.type === 'form') {
    if (surface === 'native' && options.formRendererAvailable !== true) return unsupported;
    const parsed = CardFormSchema.safeParse(block);
    if (!parsed.success || parsed.data.fields.some((field) => field.sensitive)) return unsupported;
    const refs = [
      ...parsed.data.warningFactIds,
      ...parsed.data.fields.flatMap((field) => (field.defaultFact ? [field.defaultFact] : [])),
    ];
    if (refs.some((id) => !hasFact(facts, id) || facts.get(id)?.sensitive === true))
      return unsupported;
    return { shell: true, full: options.formRendererAvailable === true };
  }
  const rule: Rule | undefined = Object.hasOwn(GENERATED_BLOCK_RULES, block.type)
    ? GENERATED_BLOCK_RULES[block.type as keyof typeof GENERATED_BLOCK_RULES]
    : undefined;
  if (!rule) return unsupported;
  if (rule.required?.some((key) => !hasFact(facts, block[key]))) return unsupported;
  if (rule.optional?.some((key) => block[key] !== undefined && !hasFact(facts, block[key])))
    return unsupported;
  if (
    rule.enums &&
    Object.entries(rule.enums).some(([key, values]) => !values.includes(String(block[key])))
  )
    return unsupported;
  if (rule.ids) {
    const ids = block[rule.ids.field];
    if (!bounded(ids, rule.ids.min, rule.ids.max) || !ids.every((id) => hasFact(facts, id)))
      return unsupported;
  }
  if (block.type === 'table') {
    if (
      !bounded(
        block.columns,
        GENERATED_CARD_LIMITS.table.columns.min,
        GENERATED_CARD_LIMITS.table.columns.max,
      ) ||
      !block.columns.every(
        (label) => text(label) && label.length <= GENERATED_CARD_LIMITS.table.columns.titleMax,
      ) ||
      !bounded(
        block.rows,
        GENERATED_CARD_LIMITS.table.rows.min,
        GENERATED_CARD_LIMITS.table.rows.max,
      ) ||
      !block.rows.every(
        (cells) =>
          Array.isArray(cells) &&
          cells.length === (block.columns as unknown[]).length &&
          cells.every((id) => hasFact(facts, id)),
      )
    )
      return unsupported;
  }
  if (block.type === 'chart') {
    if (
      !bounded(
        block.points,
        GENERATED_CARD_LIMITS.chart.points.min,
        GENERATED_CARD_LIMITS.chart.points.max,
      ) ||
      !block.points.every((point) => {
        const item = row(point);
        return item && hasFact(facts, item.labelFact) && hasFact(facts, item.valueFact);
      })
    )
      return unsupported;
  }
  if (block.type === 'image' && !safeCardHttpUrl(facts.get(String(block.urlFact))?.value))
    return unsupported;
  // The web offers place links and code text, with explicit native fallbacks;
  // those do not replace the material map/scannable content in the answer.
  return {
    shell: true,
    full:
      surface !== 'web' ||
      (block.type !== 'map' && (block.type !== 'code' || block.format === 'text')),
  };
}

function countFormBlocks(blocks: unknown, depth = 0): number {
  if (!Array.isArray(blocks) || depth > 1) return 0;
  return blocks.reduce((count, candidate) => {
    const block = row(candidate);
    if (!block) return count;
    if (block.type === 'form') return count + 1;
    if (block.type === 'section') return count + countFormBlocks(block.blocks, depth + 1);
    return count;
  }, 0);
}

export function generatedSpecBlockCapability(
  value: unknown,
  surface: GeneratedCardSurface,
  options: { formRendererAvailable?: boolean } = {},
): BlockCapability {
  const spec = row(value);
  if (
    spec?.version !== 1 ||
    !text(spec.title) ||
    !Array.isArray(spec.facts) ||
    !Array.isArray(spec.blocks)
  )
    return { shell: false, full: false };
  const nativeFormCount = countFormBlocks(spec.blocks);
  const formRendererAvailable = options.formRendererAvailable === true && nativeFormCount === 1;
  const facts = new Map<string, Row>();
  let factsValid = bounded(
    spec.facts,
    GENERATED_CARD_LIMITS.spec.facts.min,
    GENERATED_CARD_LIMITS.spec.facts.max,
  );
  for (const value of spec.facts) {
    const item = row(value);
    if (
      !item ||
      !text(item.id) ||
      !new RegExp(GENERATED_CARD_LIMITS.fact.idPattern).test(item.id) ||
      !text(item.value) ||
      item.value.length > GENERATED_CARD_LIMITS.fact.value.max ||
      facts.has(item.id)
    ) {
      factsValid = false;
      continue;
    }
    facts.set(item.id, item);
  }
  const blocks = spec.blocks.map((block) =>
    generatedBlockCapability(block, facts, surface, 0, {
      ...options,
      formRendererAvailable:
        surface === 'native' ? formRendererAvailable : options.formRendererAvailable,
    }),
  );
  return {
    shell: blocks.some((block) => block.shell),
    full:
      factsValid &&
      spec.title.length <= GENERATED_CARD_LIMITS.spec.title.max &&
      bounded(
        spec.blocks,
        GENERATED_CARD_LIMITS.spec.blocks.min,
        GENERATED_CARD_LIMITS.spec.blocks.max,
      ) &&
      blocks.every((block) => block.full),
  };
}
