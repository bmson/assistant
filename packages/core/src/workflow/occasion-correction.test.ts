import { describe, expect, it } from 'vitest';
import {
  isOccasionCorrectionRequest,
  matchesOccasionCorrection,
  matchesOccasionTarget,
  occasionCorrectionReply,
  occasionMutationTool,
  parseOccasionCorrection,
  parseOccasionDeletion,
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

  it('recognizes an explicitly named custom occasion and preserves its entire label', () => {
    const target = {
      subject: 'Mira Vale',
      kind: 'custom',
      label: 'Pottery Club Day',
      expectedDate: { month: 5, day: 7 },
    };
    expect(
      parseOccasionCorrection(
        'Change Mira Vale’s saved occasion named Pottery Club Day from May 7 to May 9.',
      ),
    ).toEqual({ ...target, date: { month: 5, day: 9 } });
    expect(
      parseOccasionDeletion('Remove Mira Vale’s saved occasion named “Pottery Club Day” on May 7.'),
    ).toEqual(target);
    expect(
      parseOccasionCorrection(
        'Change Mira Vale’s saved occasion named Gifts from Studio on Main from May 7 to 2027-05-09.',
      ),
    ).toEqual({
      ...target,
      label: 'Gifts from Studio on Main',
      date: { month: 5, day: 9, year: 2027 },
    });
    expect(
      parseOccasionDeletion('Remove Mira Vale’s saved occasion named Birthday on May 7.'),
    ).toEqual({ ...target, label: 'Birthday' });
    expect(
      parseOccasionDeletion('Remove Mira Vale’s saved occasion named on May 7.'),
    ).toBeUndefined();
    expect(parseOccasionDeletion('Remove Mira Vale’s saved occasion on May 7.')).toBeUndefined();
  });

  it('keeps neighboring requests and explicit tool opt-outs out of occasion mutation', () => {
    for (const request of [
      'Remove Mira Vale’s Pottery Club Day on May 7.',
      'Remove Mira Vale’s saved reminder named Pottery Club Day on May 7.',
      'Remove Mira Vale’s saved birthday reminder on May 7.',
      'Change Mira Vale’s saved birthday invitation from May 7 to May 9.',
      'Remove Mira Vale’s saved occasion named Pottery Club Day on May 7. Do not use tools.',
      'Change Mira Vale’s saved occasion named Pottery Club Day from May 7 to May 9. Do not use tools.',
    ]) {
      expect(occasionMutationTool(request)).toBeUndefined();
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

describe('owner-chat occasion deletion evidence', () => {
  const deleteRequest = 'Delete Mira Vale’s saved pottery-club anniversary on April 12.';
  const target = {
    subject: input.subject,
    kind: input.kind,
    label: input.label,
    expectedDate: input.expectedDate,
  };

  it('requires the owner’s exact target and saved date', () => {
    expect(occasionMutationTool(deleteRequest)).toBe('occasions.delete');
    const deletion = parseOccasionDeletion(deleteRequest);
    expect(deletion).toEqual(target);
    if (!deletion) throw new Error('Missing grounded deletion');
    expect(matchesOccasionTarget(deletion, { ...target, subject: 'Rowan Reed' })).toBe(false);
    expect(matchesOccasionTarget(deletion, { ...target, expectedDate: input.date })).toBe(false);
    for (const neighboring of [
      'Delete the calendar invitation for Mira’s birthday on April 12.',
      'Delete Mira’s birthday invitation on April 12.',
      'Delete Mira’s birthday email.',
      'Delete Mira’s birthday on April 12. Do not use tools.',
    ]) {
      expect(occasionMutationTool(neighboring)).toBeUndefined();
    }
  });

  it('requires a current deletion receipt identifying the removed occasion', () => {
    const receipt = {
      status: 'succeeded',
      toolName: 'occasions.delete',
      result: {
        operationId: 'delete-operation',
        outcome: 'deleted',
        ok: true,
        occasion: {
          id: 'occasion',
          contactId: 'contact',
          person: target.subject,
          kind: target.kind,
          label: target.label,
          ...target.expectedDate,
          year: null,
        },
      },
    };
    expect(occasionCorrectionReply(deleteRequest, [receipt])).toMatchObject({
      confirmed: true,
      text: expect.stringMatching(/Deleted Mira Vale.*April 12/),
    });
    expect(
      occasionCorrectionReply(deleteRequest, [{ ...receipt, fromCurrentTask: false }]),
    ).toMatchObject({ confirmed: false });
    expect(
      occasionCorrectionReply(deleteRequest, [
        {
          ...receipt,
          result: { ok: false, outcome: 'occasion_not_found' },
        },
      ]),
    ).toMatchObject({ confirmed: false });
  });
});
