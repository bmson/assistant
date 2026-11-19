import { describe, expect, it } from 'vitest';
import { extractPracticeChangeMail } from './practice-change-mail.js';
import type { Records } from './records.js';

const received = new Date('2026-11-18T23:01:00Z');
const line =
  'Thursday, November 19 practice has moved from 4:30 PM at South Field to 5:30 PM at North Field.';

function evidence(
  body: string,
  author: 'sender' | 'external' = 'sender',
): NonNullable<Records['emailIngest']['emailContentProvenance']> {
  return {
    sourceLength: body.length,
    storedLength: body.length,
    sourceHash: 'fixture',
    bodyHash: 'fixture',
    messageHash: 'fixture',
    prefixLength: 0,
    hasExternalOrUnknown: author !== 'sender',
    spans: [{ start: 0, end: body.length, author }],
    parts: [],
  } as NonNullable<Records['emailIngest']['emailContentProvenance']>;
}

describe('practice-change evidence', () => {
  it.each([
    line.replace('Thursday', 'Friday'),
    line.replace('North Field', 'North Field or West Field'),
    line.replace('November 19', 'December 3'),
    line.replace('5:30', '4:30'),
    `${line}\n${line.replace('North Field', 'West Field')}`,
  ])('holds ambiguous or unsupported mail %s', (body) => {
    expect(
      extractPracticeChangeMail(body, evidence(body), received, 'America/Los_Angeles'),
    ).toBeNull();
  });

  it('holds a forwarded quote even when the wrapper sender was authenticated', () => {
    expect(
      extractPracticeChangeMail(line, evidence(line, 'external'), received, 'America/Los_Angeles'),
    ).toBeNull();
  });

  it('holds a wall time with two possible instants', () => {
    const body =
      'Sunday, November 1 practice has moved from 12:30 AM at South Field to 1:30 AM at North Field.';
    expect(
      extractPracticeChangeMail(
        body,
        evidence(body),
        new Date('2026-10-31T21:00:00Z'),
        'America/Los_Angeles',
      ),
    ).toBeNull();
  });
});
