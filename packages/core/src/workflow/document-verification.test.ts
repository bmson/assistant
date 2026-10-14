import { describe, expect, it } from 'vitest';
import {
  createdDocumentVerification,
  type DocumentVerificationEvidence,
  nextCreatedDocumentRead,
} from './document-verification.js';
import { enforceResponseContract } from './response-contract.js';

const request =
  'Create a new private Google Doc titled "Study plan" with a heading "Our plan", exactly three bullets, and a two-column table. Read the document back to verify those details.';
const structure = {
  complete: true,
  headings: [{ text: 'Our plan', style: 'HEADING_1' }],
  bullets: ['Read', 'Discuss', 'Write'],
  tables: [
    {
      rows: [
        ['Task', 'Owner'],
        ['Read', 'Morgan'],
        ['Review', 'Taylor'],
      ],
    },
  ],
};
const create = {
  toolName: 'docs.create',
  status: 'succeeded',
  args: { title: 'Study plan' },
  result: { documentId: 'DOCUMENT12345', contentStructure: structure },
};
const read = {
  toolName: 'docs.get',
  status: 'succeeded',
  args: { documentId: 'DOCUMENT12345' },
  result: { documentId: 'DOCUMENT12345', title: 'Study plan', complete: true, structure },
};

describe('native document verification', () => {
  it('schedules exactly one read of the created document, excluding old task evidence and other IDs', () => {
    const input = { documentId: 'DOCUMENT12345', startOffset: 0, maxChars: 50_000 };
    expect(nextCreatedDocumentRead(request, [create])).toEqual(input);
    expect(nextCreatedDocumentRead(request, [{ ...read, fromCurrentTask: false }, create])).toEqual(
      input,
    );
    expect(
      nextCreatedDocumentRead(request, [
        create,
        { ...read, args: { documentId: 'OTHERDOC12345' } },
      ]),
    ).toEqual(input);
    expect(nextCreatedDocumentRead(request, [create, read])).toBeUndefined();
    expect(
      nextCreatedDocumentRead(request, [create, { ...read, status: 'failed' }]),
    ).toBeUndefined();
    expect(nextCreatedDocumentRead('Read an existing Google Doc', [create])).toBeUndefined();
  });

  it('verifies native heading, bullets and table cells against the creation receipt', () => {
    const result = createdDocumentVerification(request, [create, read], 'Done; verified.');
    expect(result?.verified).toBe(true);
    expect(result?.text).toContain('3 native bullets');
    expect(result?.text).toContain('a native table with 2 data rows');
    expect(result?.text).toContain('https://docs.google.com/document/d/DOCUMENT12345/edit');
  });

  it('does not let complete literal Markdown text prove native formatting', () => {
    const textRead = {
      ...read,
      result: {
        documentId: 'DOCUMENT12345',
        title: 'Study plan',
        complete: true,
        text: '# Our plan - Read - Discuss - Write | Task | Owner | |---|---| | Read | Morgan |',
      },
    };
    const result = enforceResponseContract(
      'Created and verified the heading, three bullets and table.',
      [create, textRead],
      { requestText: request },
    );
    expect(result.text).toContain(
      'could not verify the native heading, bullet, and table formatting',
    );
    expect(result.text).not.toContain('Readback confirmed');
    expect(result.groundingFallback).toEqual(['document-native-structure-unavailable']);
  });

  it('rejects missing bullets, altered cells, title mismatch and incomplete structural evidence', () => {
    const variants = [
      { ...read.result, title: 'Wrong title' },
      { ...read.result, complete: false },
      { ...read.result, structure: { ...structure, bullets: ['Read', 'Write'] } },
      {
        ...read.result,
        structure: {
          ...structure,
          tables: [
            {
              rows: [
                ['Task', 'Owner'],
                ['Read', 'Wrong'],
              ],
            },
          ],
        },
      },
      { ...read.result, structure: { ...structure, complete: false } },
    ];
    for (const result of variants) {
      const answer = createdDocumentVerification(
        request,
        [create, { ...read, result }],
        'All verified.',
      );
      expect(answer?.verified).toBe(false);
      expect(answer?.text).not.toContain('Readback confirmed');
    }
  });

  it('checks requested counts even when the submitted content forgot a requested bullet', () => {
    const two = { ...structure, bullets: ['Read', 'Write'] };
    expect(
      createdDocumentVerification(
        request,
        [
          { ...create, result: { ...create.result, contentStructure: two } },
          { ...read, result: { ...read.result, structure: two } },
        ],
        'Verified.',
      )?.verified,
    ).toBe(false);
  });

  it('requires unquoted singular headings and tables even when both receipts omit them', () => {
    const ownerRequest =
      'Create a new Google Doc titled "Study plan" with a heading, exactly three bullets, and a two-column table.';
    for (const shape of [
      { ...structure, headings: [], tables: [] },
      { ...structure, headings: [] },
      { ...structure, tables: [] },
      { ...structure, tables: [{ rows: [] }] },
    ]) {
      expect(
        createdDocumentVerification(
          ownerRequest,
          [
            { ...create, result: { ...create.result, contentStructure: shape } },
            { ...read, result: { ...read.result, structure: shape } },
          ],
          'Verified.',
        )?.verified,
      ).toBe(false);
    }
    expect(createdDocumentVerification(ownerRequest, [create, read], 'Verified.')?.verified).toBe(
      true,
    );
    const checklist =
      'Create a new Google Doc titled "Study plan":\n- A heading\n- Exactly three bullets\n- A two-column table';
    const omitted = { ...structure, headings: [], tables: [] };
    expect(
      createdDocumentVerification(
        checklist,
        [
          { ...create, result: { ...create.result, contentStructure: omitted } },
          { ...read, result: { ...read.result, structure: omitted } },
        ],
        'Verified.',
      )?.verified,
    ).toBe(false);
    expect(createdDocumentVerification(checklist, [create, read], 'Verified.')?.verified).toBe(
      true,
    );
  });

  it('starts a new formatting scope after a conjunction following a heading topic', () => {
    const verify = (detail: string, shape = structure) =>
      createdDocumentVerification(
        `Create a Google Doc titled "Study plan" with ${detail}.`,
        [
          { ...create, result: { ...create.result, contentStructure: shape } },
          { ...read, result: { ...read.result, structure: shape } },
        ],
        'Verified.',
      )?.verified;
    const noTable = { ...structure, tables: [] };
    expect(verify('a heading about our project and a two-column table', noTable)).toBe(false);
    expect(verify('a heading about our project and a two-column table')).toBe(true);
    expect(verify('a heading about our project and two tables')).toBe(false);
    expect(verify('a heading about our project and exactly four bullets')).toBe(false);
    expect(verify('a table about our project and a heading', { ...structure, headings: [] })).toBe(
      false,
    );
    expect(
      verify('a heading about our project and a two-column table containing three data rows'),
    ).toBe(false);
    expect(
      verify('a heading about our project and a two-column table containing two data rows'),
    ).toBe(true);
    expect(
      verify('a heading about headings and tables and include a two-column table', noTable),
    ).toBe(false);
  });

  it('checks explicit heading and table counts against the owner request', () => {
    const ownerRequest =
      'Create a new Google Doc titled "Study plan" with two headings, exactly three bullets, and two tables.';
    expect(createdDocumentVerification(ownerRequest, [create, read], 'Verified.')?.verified).toBe(
      false,
    );
    const shape = {
      ...structure,
      headings: [...structure.headings, { text: 'Next', style: 'HEADING_2' }],
      tables: [...structure.tables, ...structure.tables],
    };
    expect(
      createdDocumentVerification(
        ownerRequest,
        [
          { ...create, result: { ...create.result, contentStructure: shape } },
          { ...read, result: { ...read.result, structure: shape } },
        ],
        'Verified.',
      )?.verified,
    ).toBe(true);
  });

  it('distinguishes requested data rows from total table rows and verifies row counts', () => {
    const verify = (detail: string, shape = structure) =>
      createdDocumentVerification(
        `Create a Google Doc titled "Study plan" with a two-column table containing ${detail}.`,
        [
          { ...create, result: { ...create.result, contentStructure: shape } },
          { ...read, result: { ...read.result, structure: shape } },
        ],
        'Verified.',
      )?.verified;
    expect(verify('two data rows')).toBe(true);
    expect(verify('three rows')).toBe(true);
    expect(verify('three data rows')).toBe(false);
    expect(verify('two rows')).toBe(false);
    expect(verify('a data row')).toBe(false);
    const missingRow = {
      ...structure,
      tables: [
        {
          rows: [
            ['Task', 'Owner'],
            ['Read', 'Morgan'],
          ],
        },
      ],
    };
    expect(verify('two data rows', missingRow)).toBe(false);
    expect(verify('a data row', missingRow)).toBe(true);
    const twoTables = { ...structure, tables: [...structure.tables, ...structure.tables] };
    expect(verify('two data rows each', twoTables)).toBe(true);
    expect(verify('four data rows total', twoTables)).toBe(true);
    expect(verify('two data rows total', twoTables)).toBe(false);
  });

  it('does not treat quoted content, prose topics, prohibitions, or a table of contents as native requirements', () => {
    const shape = { ...structure, headings: [], tables: [] };
    for (const detail of [
      'with exactly three bullets and a paragraph saying "two headings and three tables with five data rows".',
      'with exactly three bullets discussing two headings, and a paragraph comparing four tables with five data rows.',
      'with exactly three bullets. Explain two headings and three tables.',
      'with exactly three bullets about headings and tables.',
      'with exactly three bullets about two headings and three tables.',
      'with a paragraph about headings and a table plus exactly three bullets.',
      'with exactly three bullets. Do not include headings or tables.',
      'with exactly three bullets and a table of contents.',
    ]) {
      expect(
        createdDocumentVerification(
          `Create a Google Doc titled "Study plan" ${detail}`,
          [
            { ...create, result: { ...create.result, contentStructure: shape } },
            { ...read, result: { ...read.result, structure: shape } },
          ],
          'Verified.',
        )?.verified,
        detail,
      ).toBe(true);
    }
  });

  it('requires a matching read after creation, not a prior read or another document', () => {
    for (const evidence of [
      [read, create],
      [create, { ...read, result: { ...read.result, documentId: 'OTHERDOC12345' } }],
      [create, { ...read, fromCurrentTask: false }],
    ]) {
      expect(createdDocumentVerification(request, evidence, 'Verified.')?.verified).toBe(false);
    }
    const legacy: DocumentVerificationEvidence = {
      ...create,
      result: { documentId: 'DOCUMENT12345' },
    };
    expect(createdDocumentVerification(request, [legacy, read], 'Verified.')?.verified).toBe(false);
  });
});
