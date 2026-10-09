import { describe, expect, it } from 'vitest';
import { mergeDocumentPassagePage } from './document-passage-state.js';

describe('document passage page stitching', () => {
  it('reassembles escaped and multibyte text in order without duplicate replay', () => {
    const source = '🧭 é "quote" \\\n'.repeat(100);
    const first = {
      chunkIndex: 4,
      text: source.slice(0, 37),
      charCount: 37,
      fragment: { offset: 0, totalChars: source.length, complete: false },
    };
    const second = {
      chunkIndex: 4,
      text: source.slice(37, 129),
      charCount: 92,
      fragment: { offset: 37, totalChars: source.length, complete: false },
    };
    const final = {
      chunkIndex: 4,
      text: source.slice(129),
      charCount: source.length - 129,
      fragment: { offset: 129, totalChars: source.length, complete: true },
    };

    const afterFirst = mergeDocumentPassagePage([], [first]);
    const afterReplay = mergeDocumentPassagePage(afterFirst, [first]);
    expect(afterReplay[0]?.text).toBe(first.text);
    const afterSecond = mergeDocumentPassagePage(afterReplay, [second]);
    const complete = mergeDocumentPassagePage(afterSecond, [final]);
    expect(complete[0]?.text).toBe(source);
    expect(complete[0]?.fragment?.complete).toBe(true);
    expect(complete.map((chunk) => chunk.chunkIndex)).toEqual([4]);
  });

  it('rejects missing or inconsistent fragment ranges rather than displaying a false complete passage', () => {
    expect(() =>
      mergeDocumentPassagePage(
        [],
        [
          {
            chunkIndex: 1,
            text: 'cut',
            charCount: 3,
            fragment: { offset: 2, totalChars: 10, complete: false },
          },
        ],
      ),
    ).toThrow(/invalid bounds/);
    expect(() =>
      mergeDocumentPassagePage(
        [
          {
            chunkIndex: 1,
            text: 'first',
            charCount: 5,
            fragment: { offset: 0, totalChars: 10, complete: false },
          },
        ],
        [
          {
            chunkIndex: 1,
            text: 'last',
            charCount: 4,
            fragment: { offset: 7, totalChars: 10, complete: true },
          },
        ],
      ),
    ).toThrow(/out of order/);
  });
});
