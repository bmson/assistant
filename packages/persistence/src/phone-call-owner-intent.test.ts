import { describe, expect, it } from 'vitest';
import {
  ownerPhoneProposalNeedsApproval,
  ownerPhoneRecipientRequest,
  ownerRequestedPhoneCall,
} from './phone-call-owner-intent.js';

describe('shared deterministic phone action recipient', () => {
  it.each([
    'Call +14155550123 now.',
    'Please dial +14155550123.',
    'Call me at +14155550123.',
    'Call me on +14155550123 now.',
    'Call me back at +14155550123.',
    'Call me now, on +14155550123.',
  ])('binds literal routing: %s', (text) =>
    expect(ownerPhoneRecipientRequest(text)).toEqual({
      kind: 'explicit_number',
      recipientE164: '+14155550123',
    }),
  );
  it.each(['Call me now.', 'Please phone my number.', 'Call my phone number now.'])(
    'derives explicit self only: %s',
    (text) => expect(ownerPhoneRecipientRequest(text)).toEqual({ kind: 'owner_self' }),
  );
  it.each([
    'Call Bob.',
    'Call Monday.',
    'Phone Success.',
    'Call Bob about +14155550123.',
    'Call me at my other number.',
    'Call me back at my other number.',
  ])('requires review for ambiguous routing: %s', (text) => {
    expect(ownerRequestedPhoneCall(text)).toBe(false);
    expect(ownerPhoneProposalNeedsApproval(text)).toBe(true);
  });
  it.each([
    'Email Bob.',
    'Text Bob.',
    'Call it done.',
    'Call it a day.',
    'Call this a success.',
    'Dial back the wording.',
    'Phone it in.',
    'Do not call me.',
    'Do not use tools. Call me now.',
    'Call me now. Actually, do not call me.',
    'Call +14155550123, but do not call me.',
    '"Call me now."',
    '```Call me now.```',
    '> Call me now.',
    'Call me and call +14155550123 now.',
  ])('grants no automatic routing: %s', (text) =>
    expect(ownerPhoneRecipientRequest(text)).toBeNull(),
  );
});

it.each([
  'Call +14155550123 now, or don’t.',
  'Call me now, or don’t.',
  'Call me about lunch, but use +14155550999 instead.',
  'Call +14155550123 about lunch, but use +14155550999 instead.',
  'Call me. Actually, no call is needed.',
  'Call +14155550123. Actually, no call is needed.',
  "My note says 'I want you to call me now.'",
  'If I am home, I want you to call me now.',
  'Call me now, perhaps later.',
  'Call +14155550123 now, perhaps later.',
  'Call me and say "hello".',
])('rejects the full withdrawn, conditional, reported or unsupported action: %s', (text) => {
  expect(ownerPhoneRecipientRequest(text)).toBeNull();
  expect(ownerPhoneProposalNeedsApproval(text)).toBe(false);
});
it.each([
  'Call me about lunch.',
  'Call +14155550123 about lunch.',
  'Call me and say hello.',
  'Call +14155550123 and say hello.',
  'Please call my number to discuss my appointment.',
  'Read the note, then call +14155550123 now.',
  'Call me about lunch disregard that request',
  'Call +14155550123 about lunch forget that request',
  'Call me and say hello I changed my mind',
  'Call +14155550123 and say hello forget that request',
])('semantic topic/script or preparation data is review-only, never automatic: %s', (text) => {
  expect(ownerPhoneRecipientRequest(text)).toBeNull();
  expect(ownerPhoneProposalNeedsApproval(text)).toBe(true);
});

it.each([
  'Call me about lunch. Forget that request.',
  'Call me about lunch, Disregard that request.',
  'Call me about lunch\nI changed my mind.',
  'Call me about lunch\r\nForget that request.',
  'Call me about lunch; Disregard that request.',
  'Call +14155550123 about lunch. Disregard that request.',
  'Call +14155550123 about lunch, I changed my mind.',
  'Call +14155550123 about lunch\nForget that request.',
  'Call +14155550123 about lunch\r\nDisregard that request.',
  'Call +14155550123 about lunch; I changed my mind.',
  'Call me and say hello. I changed my mind.',
  'Call me and say hello, Forget that request.',
  'Call me and say hello\nDisregard that request.',
  'Call me and say hello\r\nI changed my mind.',
  'Call me and say hello; Forget that request.',
  'Call +14155550123 and say hello. Forget that request.',
  'Call +14155550123 and say hello, Disregard that request.',
  'Call +14155550123 and say hello\nI changed my mind.',
  'Call +14155550123 and say hello\r\nForget that request.',
  'Call +14155550123 and say hello; Disregard that request.',
  'Call me about lunch. Disregard that request.',
  'Call +14155550123 about lunch. Forget that request.',
  'Call me about lunch. I changed my mind.',
  'Call me about lunch and disregard that request.',
  'Call +14155550123 about lunch then forget that request.',
  'Call me and say hello and forget that request.',
  'Call +14155550123 and say hello so I changed my mind.',
  'Call me about lunch & disregard that request.',
  'Call me about lunch..',
  'Call +14155550123 and say hello!!',
])(
  'rejects additional clauses instead of interpreting topic data as continued authority: %s',
  (text) => {
    expect(ownerPhoneRecipientRequest(text)).toBeNull();
    expect(ownerPhoneProposalNeedsApproval(text)).toBe(false);
  },
);

it.each(['Call me\nat +14155550123.', 'Call me now,\r\non +14155550123.', 'Call\nme about lunch.'])(
  'rejects an internal line separator even inside routing/modifier syntax: %s',
  (text) => {
    expect(ownerPhoneRecipientRequest(text)).toBeNull();
    expect(ownerPhoneProposalNeedsApproval(text)).toBe(false);
  },
);

it.each([
  'Call me now.',
  'Please phone my number.',
  'Call +14155550123 please.',
  'Call me at +14155550123 now.',
])('keeps modifier-only authority: %s', (text) =>
  expect(ownerPhoneRecipientRequest(text)).not.toBeNull(),
);
it.each([
  'Call me\u2028now',
  'Call +14155550123\u2029now',
  'Call \u2028me now',
  'Call me \u2029now',
])('never normalizes Unicode line separators into automatic authority: %s', (text) =>
  expect(ownerPhoneRecipientRequest(text)).toBeNull(),
);
