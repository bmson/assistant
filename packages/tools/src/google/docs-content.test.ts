import { describe, expect, it } from 'vitest';
import {
  documentContentPlan,
  expectedDocumentStructure,
  normalizeDocumentMarkdown,
  tableCellContentRequests,
} from './docs-content.js';

describe('document content planning', () => {
  it('preserves existing newlines and inline/code spaces exactly', () => {
    for (const content of [
      '# Heading\n\n- First\n- Second',
      'Keep  two  spaces in prose',
      '`code  - literal`',
      '```\n# literal\n- literal\n```',
    ])
      expect(normalizeDocumentMarkdown(content)).toBe(content);
  });

  it('plans native grids and preserves blocks before, between, and after tables', () => {
    const parts = documentContentPlan(
      '# Plan\n- First\n\n| A | B |\n|---|---|\n| **one** | [two](https://example.org) |\n\n## Next\n| X | Y |\n|---|---|\n| three | four |\nTail',
    );
    expect(parts.map((part) => part.kind)).toEqual(['text', 'table', 'text', 'table', 'text']);
    expect(expectedDocumentStructure(parts)).toEqual({
      complete: true,
      headings: [
        { text: 'Plan', style: 'HEADING_1' },
        { text: 'Next', style: 'HEADING_2' },
      ],
      bullets: ['First'],
      tables: [
        {
          rows: [
            ['A', 'B'],
            ['one', 'two'],
          ],
        },
        {
          rows: [
            ['X', 'Y'],
            ['three', 'four'],
          ],
        },
      ],
    });
  });

  it('checks column alignment and preserves escaped pipes as cell content', () => {
    expect(documentContentPlan('| A | B |\n|---|---|\n| one\\|two | three |')).toEqual([
      {
        kind: 'table',
        rows: [
          ['A', 'B'],
          ['one|two', 'three'],
        ],
      },
    ]);
    expect(() => documentContentPlan('| A | B |\n|---|---|\n| only one |')).toThrow(
      'same number of columns',
    );
  });

  it('styles only inline cell content without treating a leading dash as a bullet', () => {
    const requests = tableCellContentRequests('- **literal**', 57, true);
    expect(requests[0]).toEqual({ insertText: { location: { index: 57 }, text: '- literal' } });
    expect(requests.some((request) => request.createParagraphBullets)).toBe(false);
  });
});
