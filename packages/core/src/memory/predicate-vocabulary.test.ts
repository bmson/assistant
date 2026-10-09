import { describe, expect, it } from 'vitest';
import {
  canonicalPredicate,
  extractionVocabularyLines,
  GRAPH_ENTITY_KINDS,
  PREDICATE_VOCABULARY,
  predicateSpec,
  predicateSuggestionsFor,
} from './predicate-vocabulary.js';

describe('predicate vocabulary', () => {
  it('has unique ids and valid kind references', () => {
    const ids = new Set<string>();
    for (const spec of PREDICATE_VOCABULARY) {
      expect(ids.has(spec.id), `duplicate predicate ${spec.id}`).toBe(false);
      ids.add(spec.id);
      for (const kind of [...spec.subjectKinds, ...spec.objectKinds]) {
        expect(
          (GRAPH_ENTITY_KINDS as readonly string[]).includes(kind),
          `${spec.id} references unknown kind ${kind}`,
        ).toBe(true);
      }
      // Symmetric predicates never need an inverse; asymmetric ones in the
      // family and work groups should name one.
      if (spec.symmetric) expect(spec.inverse).toBeUndefined();
    }
  });

  it('covers the family roles the owner asked for', () => {
    for (const role of [
      'father_of',
      'mother_of',
      'brother_of',
      'sister_of',
      'grandmother_of',
      'grandfather_of',
      'spouse_of',
      'former_spouse_of',
      'cousin_of',
    ]) {
      expect(predicateSpec(role), role).toBeDefined();
    }
  });

  it('keeps past employment and marriage distinct from current relationships', () => {
    expect(canonicalPredicate('was_employed_by').id).toBe('worked_at');
    expect(canonicalPredicate('was employed at').id).toBe('worked_at');
    expect(canonicalPredicate('employed_by').id).toBe('works_at');
    expect(canonicalPredicate('was_married_to').id).toBe('former_spouse_of');
    expect(canonicalPredicate('married_to').id).toBe('spouse_of');
  });

  it('suggests by kind pair, in registry order', () => {
    const personPerson = predicateSuggestionsFor('person', 'person');
    expect(personPerson).toContain('father_of');
    expect(personPerson).toContain('sibling_of');
    expect(personPerson).toContain('met');

    // "Where they met" attaches to the place or event, not the person.
    expect(predicateSuggestionsFor('person', 'place')).toContain('met_at');
    expect(predicateSuggestionsFor('person', 'event')).toContain('met_at');

    expect(predicateSuggestionsFor('person', 'organization')).toContain('works_at');
    expect(predicateSuggestionsFor('person', 'organization')).toContain('studied_at');
    expect(predicateSuggestionsFor('person', 'date')).toEqual([
      'born_on',
      'engaged_on',
      'married_on',
      'divorced_on',
      'died_on',
    ]);
    expect(predicateSuggestionsFor('event', 'date')).toContain('happens_on');

    // Unknown pairs suggest nothing — the form falls back to its generic list.
    expect(predicateSuggestionsFor('topic', 'topic')).toEqual([]);
  });

  it('generates one prompt line per group with every predicate named', () => {
    const lines = extractionVocabularyLines();
    expect(lines.length).toBe(4);
    for (const [index, spec] of PREDICATE_VOCABULARY.entries()) {
      expect(
        lines.some((line) => line.includes(spec.id)),
        `${spec.id} missing`,
      ).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(lines[0]).toMatch(/^- family: /);
  });
});
