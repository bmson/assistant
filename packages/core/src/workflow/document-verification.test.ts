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
