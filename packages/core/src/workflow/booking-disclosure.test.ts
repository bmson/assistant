import { expect, it } from 'vitest';
import { bookingEvidence } from './booking-disclosure.js';

it('keeps a ticket confirmation subject while withholding unrelated text from the same result', () => {
  const row = bookingEvidence({
    toolName: 'gmail.search',
    result: {
      results: [
        { subject: 'Museum ticket confirmation' },
        { subject: 'Science Museum ticket confirmation includes private arrangements' },
        { subject: 'Clinic ticket confirmation' },
        { subject: 'Unrelated personal arrangements' },
      ],
    },
  });
  expect(row.result.results.map((message) => message.subject)).toEqual([
    'Museum ticket confirmation',
    'Science Museum ticket confirmation',
    '',
    '',
  ]);
});
