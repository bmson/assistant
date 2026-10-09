import { GenerativeCardSpecV1Schema } from '@assistant/core/generative-card';
import { GENERATED_CARD_LIMITS } from '@assistant/persistence/card-capabilities';
import { describe, expect, it } from 'vitest';

function spec(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    title: 'Card',
    icon: 'generic',
    accent: 'mint',
    accessibilityLabel: 'Card',
    sourceLabel: 'Source',
    facts: [{ id: 'f', value: 'Value', label: 'Fact', source: 'Source' }],
    blocks: [{ type: 'note', factId: 'f' }],
    actions: [],
    ...overrides,
  };
}

describe('generated native contract parity with core schema', () => {
  it('keeps shared spec and fact bounds aligned with core validation', () => {
    const limit = GENERATED_CARD_LIMITS;
    expect(
      GenerativeCardSpecV1Schema.safeParse(spec({ title: 'T'.repeat(limit.spec.title.max) }))
        .success,
    ).toBe(true);
    expect(
      GenerativeCardSpecV1Schema.safeParse(spec({ title: 'T'.repeat(limit.spec.title.max + 1) }))
        .success,
    ).toBe(false);
    expect(
      GenerativeCardSpecV1Schema.safeParse(
        spec({
          facts: Array.from({ length: limit.spec.facts.max }, (_, index) => ({
            id: `f${index}`,
            value: 'V',
            source: 'Source',
          })),
        }),
      ).success,
    ).toBe(true);
    expect(
      GenerativeCardSpecV1Schema.safeParse(
        spec({
          facts: Array.from({ length: limit.spec.facts.max + 1 }, (_, index) => ({
            id: `f${index}`,
            value: 'V',
            source: 'Source',
          })),
        }),
      ).success,
    ).toBe(false);
    expect(
      GenerativeCardSpecV1Schema.safeParse(
        spec({ facts: [{ id: 'f', value: 'V'.repeat(limit.fact.value.max), source: 'Source' }] }),
      ).success,
    ).toBe(true);
    expect(
      GenerativeCardSpecV1Schema.safeParse(
        spec({
          facts: [{ id: 'f', value: 'V'.repeat(limit.fact.value.max + 1), source: 'Source' }],
        }),
      ).success,
    ).toBe(false);
  });

  it('keeps each registry block rule represented by the core generated schema', () => {
    const samples: Record<string, unknown>[] = [
      { type: 'hero', titleFact: 'f' },
      { type: 'facts', factIds: ['f'] },
      { type: 'timeline', factIds: ['f'] },
      {
        type: 'score',
        leftLabelFact: 'f',
        leftValueFact: 'f',
        rightLabelFact: 'f',
        rightValueFact: 'f',
      },
      { type: 'code', valueFact: 'f', format: 'text' },
      { type: 'image', urlFact: 'f' },
      { type: 'note', factId: 'f' },
      { type: 'metrics', factIds: ['f', 'f'] },
      { type: 'journey', mode: 'flight', fromFact: 'f', toFact: 'f' },
      { type: 'progress', valueFact: 'f' },
      { type: 'stages', factIds: ['f', 'f'], currentFact: 'f' },
      { type: 'countdown', dateFact: 'f' },
      { type: 'table', columns: ['A', 'B'], rows: [['f', 'f']] },
      {
        type: 'chart',
        kind: 'bar',
        points: [
          { labelFact: 'f', valueFact: 'f' },
          { labelFact: 'f', valueFact: 'f' },
        ],
      },
      { type: 'checklist', factIds: ['f'] },
      { type: 'map', placeFactIds: ['f'] },
      { type: 'section', title: 'Section', blocks: [{ type: 'note', factId: 'f' }] },
    ];
    for (const block of samples) {
      expect(GenerativeCardSpecV1Schema.safeParse(spec({ blocks: [block] })).success).toBe(true);
    }
  });

  it('keeps native manifest enums aligned with core icon, accent, and action enums', () => {
    const limits = GENERATED_CARD_LIMITS;
    for (const icon of limits.spec.icons) {
      expect(GenerativeCardSpecV1Schema.safeParse(spec({ icon })).success).toBe(true);
    }
    for (const accent of limits.spec.accents) {
      expect(GenerativeCardSpecV1Schema.safeParse(spec({ accent })).success).toBe(true);
    }
    for (const type of limits.action.types) {
      expect(
        GenerativeCardSpecV1Schema.safeParse(
          spec({
            actions: [{ id: 'action', type, label: 'Open', factId: 'f' }],
          }),
        ).success,
      ).toBe(true);
    }
    expect(GenerativeCardSpecV1Schema.safeParse(spec({ icon: 'unknown' })).success).toBe(false);
    expect(GenerativeCardSpecV1Schema.safeParse(spec({ accent: 'unknown' })).success).toBe(false);
    expect(
      GenerativeCardSpecV1Schema.safeParse(
        spec({ actions: [{ id: 'action', type: 'unknown', label: 'Open' }] }),
      ).success,
    ).toBe(false);
  });
});
