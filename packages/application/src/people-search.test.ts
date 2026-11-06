import type { ProfileContact } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { matchesPersonSearch, personSummaryFromStoredRow } from './people.js';

function summarize(aliases: unknown) {
  const contact = {
    id: 'legacy-contact',
    name: 'Casey Person',
    aliases,
    relationship: 'friend',
    trust: 'known',
  } as unknown as ProfileContact;
  return personSummaryFromStoredRow(
    { contact, factCount: 0, birthday: null, lastContactAt: null, location: 'Reykjavik' },
    new Date('2026-11-05T12:00:00.000Z'),
  );
}

describe('People directory aliases from legacy records', () => {
  it.each([
    ['scalar alias field', 'Old Name', [] as string[], false],
    ['null alias entry', [null], [] as string[], false],
    ['mixed alias entries', ['Casey Two', null, 7, 'C. Person'], ['Casey Two', 'C. Person'], true],
    ['missing alias field', undefined, [] as string[], false],
  ])('projects %s safely for search', (_label, rawAliases, projectedAliases, matchesAlias) => {
    const summary = summarize(rawAliases);
    const rawSummary = { ...summary, aliases: rawAliases as string[] | undefined };
    expect(() => matchesPersonSearch(summary, 'missing-query')).not.toThrow();
    expect(() => matchesPersonSearch(rawSummary, 'missing-query')).not.toThrow();
    expect(summary.aliases).toEqual(projectedAliases);
    expect(matchesPersonSearch(summary, 'missing-query')).toBe(false);
    expect(matchesPersonSearch(rawSummary, 'missing-query')).toBe(false);
    expect(matchesPersonSearch(summary, 'casey person')).toBe(true);
    expect(matchesPersonSearch(summary, 'friend')).toBe(true);
    expect(matchesPersonSearch(summary, 'reykjavik')).toBe(true);
    expect(matchesPersonSearch(summary, 'casey two')).toBe(matchesAlias);
    expect(matchesPersonSearch(rawSummary, 'friend')).toBe(true);
    expect(matchesPersonSearch(rawSummary, 'casey two')).toBe(matchesAlias);
  });
});
