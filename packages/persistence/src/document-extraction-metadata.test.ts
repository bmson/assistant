import { describe, expect, it } from 'vitest';
import { documentExtractionMetadata } from './document-extraction-metadata.js';

describe('document format coverage', () => {
  it('keeps legacy missing coverage unknown', () => {
    expect(documentExtractionMetadata({})).toEqual({
      version: 1,
      source: 'processor',
      chars: null,
      structure: null,
    });
  });
  it.each(['cell-addresses', 'ordered-slides'] as const)(
    'retains %s coverage',
    (representation) => {
      expect(
        documentExtractionMetadata({ chars: 12, structure: { complete: true, representation } })
          .structure,
      ).toEqual({ complete: true, representation });
    },
  );
  it.each([
    null,
    [],
    { complete: false, representation: 'cell-addresses' },
    { complete: true, representation: 'guessed' },
    { complete: true, representation: 'cell-addresses', arbitrary: 'untrusted' },
  ])('rejects malformed coverage %j', (structure) => {
    expect(() => documentExtractionMetadata({ structure })).toThrow('structure coverage');
  });
  it.each([-1, NaN, Infinity, 0.2, '12'])('rejects invalid char count %s', (chars) => {
    expect(() => documentExtractionMetadata({ chars })).toThrow('character count');
  });
});
