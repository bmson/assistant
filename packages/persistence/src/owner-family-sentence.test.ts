import { describe, expect, it } from 'vitest';
import { presentOwnerFamilyFact, presentOwnerFamilySentence } from './owner-family-presentation.js';

const meaning = {
  subjectLabel: 'Alex_Rivera',
  objectLabel: 'Sam',
  predicate: 'parent_of',
  timing: 'present' as const,
  validity: { validFrom: null, validUntil: null },
  note: 'Private context stays in optional details.',
};

describe('compact family connection sentence', () => {
  it('preserves direction and exact owner labels without repeating dates or note', () => {
    expect(presentOwnerFamilySentence(meaning)).toBe("Alex_Rivera is Sam's parent.");
    expect(
      presentOwnerFamilySentence({ ...meaning, subjectLabel: 'Sam', objectLabel: 'Alex_Rivera' }),
    ).toBe("Sam is Alex_Rivera's parent.");
  });
  it('preserves past and unspecified meaning instead of implying a current relationship', () => {
    expect(presentOwnerFamilySentence({ ...meaning, timing: 'past' })).toBe(
      "Alex_Rivera was Sam's parent.",
    );
    expect(presentOwnerFamilySentence({ ...meaning, timing: 'unspecified' })).toBe(
      "Alex_Rivera is recorded as Sam's parent.",
    );
    expect(
      presentOwnerFamilySentence({ ...meaning, predicate: 'sibling_of', timing: 'unspecified' }),
    ).toBe('Alex_Rivera and Sam are recorded as siblings.');
    expect(
      presentOwnerFamilySentence({ ...meaning, predicate: 'former_spouse_of', timing: 'past' }),
    ).toBe('Alex_Rivera and Sam were spouses.');
  });
  it('retains canonical validation and leaves the full saved statement unchanged', () => {
    expect(() => presentOwnerFamilySentence({ ...meaning, predicate: 'employed_by' })).toThrow();
    expect(() =>
      presentOwnerFamilySentence({ ...meaning, predicate: 'former_spouse_of' }),
    ).toThrow();
    expect(() =>
      presentOwnerFamilySentence({
        ...meaning,
        validity: { validFrom: 'invalid', validUntil: null },
      }),
    ).toThrow();
    expect(presentOwnerFamilyFact(meaning)).toBe(
      "Recorded statement: Alex_Rivera is Sam's parent. Timing recorded: present. Recorded dates: Start and end not recorded. Owner note: Private context stays in optional details.",
    );
  });
});
