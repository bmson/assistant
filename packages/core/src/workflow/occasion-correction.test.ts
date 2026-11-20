import { describe, expect, it } from 'vitest';
import {
  isOccasionCorrectionRequest,
  matchesOccasionCorrection,
  occasionCorrectionReply,
  parseOccasionCorrection,
} from './occasion-correction.js';

const request = 'Change Mira Vale’s saved pottery-club anniversary from April 12 to April 14.';
const input = {
  subject: 'Mira Vale',
  kind: 'custom' as const,
  label: 'pottery-club anniversary',
  expectedDate: { month: 4, day: 12 },
  date: { month: 4, day: 14 },
};

describe('owner-chat occasion correction evidence', () => {
  it('binds the name, occasion and both dates to the owner’s instruction', () => {
    const correction = parseOccasionCorrection(request);
    expect(correction).toEqual(input);
    if (!correction) throw new Error('Missing grounded correction');
    expect(matchesOccasionCorrection(correction, { ...input, subject: 'mira vale' })).toBe(true);
    expect(matchesOccasionCorrection(correction, { ...input, subject: 'Mira' })).toBe(false);
    expect(matchesOccasionCorrection(correction, { ...input, subject: 'Rowan Reed' })).toBe(false);
    expect(matchesOccasionCorrection(correction, { ...input, kind: 'anniversary' })).toBe(false);
    expect(matchesOccasionCorrection(correction, { ...input, label: 'another anniversary' })).toBe(
      false,
    );
    expect(
      matchesOccasionCorrection(correction, { ...input, expectedDate: { month: 4, day: 13 } }),
    ).toBe(false);
    expect(matchesOccasionCorrection(correction, { ...input, date: { month: 4, day: 15 } })).toBe(
      false,
    );
    expect(
      matchesOccasionCorrection(correction, { ...input, date: { ...input.date, year: 2020 } }),
    ).toBe(false);
  });

  it('clarifies an incomplete correction and leaves neighboring requests alone', () => {
    const incomplete = 'Update Mira Vale’s birthday to April 14.';
    expect(isOccasionCorrectionRequest(incomplete)).toBe(true);
    expect(parseOccasionCorrection(incomplete)).toBeUndefined();
    expect(occasionCorrectionReply(incomplete, [])?.text).toMatch(/old date/);
    for (const text of [
      'Change the calendar invitation for Mira’s birthday.',
      'Edit this birthday email.',
      'Change Mira’s calendar invitation from April 12 to April 14.',
      'Change Mira’s birthday from April 12 to April 14. Do not use tools.',
    ]) {
      expect(isOccasionCorrectionRequest(text)).toBe(false);
      expect(occasionCorrectionReply(text, [])).toBeUndefined();
    }
  });

  it('confirms only durable evidence from the current turn', () => {
    const row = {
      status: 'succeeded',
      toolName: 'occasions.update',
      result: {
        ok: true,
        outcome: 'updated',
        operationId: 'operation',
        occasion: {
          id: 'occasion',
          contactId: 'contact',
          person: 'Mira Vale',
          kind: input.kind,
          label: input.label,
          ...input.date,
          year: null,
        },
      },
    };
    expect(occasionCorrectionReply(request, [row])?.text).toContain('April 14');
    expect(occasionCorrectionReply(request, [{ ...row, fromCurrentTask: false }])?.confirmed).toBe(
      false,
    );
    expect(
      occasionCorrectionReply(request, [
        {
          ...row,
          result: { ok: false, outcome: 'ambiguous_contact' },
        },
      ]),
    ).toMatchObject({ confirmed: false, text: expect.stringMatching(/more than one person/) });
  });
});
