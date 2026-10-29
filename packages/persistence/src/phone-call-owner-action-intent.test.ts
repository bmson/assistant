import { describe, expect, it } from 'vitest';
import {
  hasAmbiguousOrWithdrawnPhoneCallOwnerAction,
  parsePhoneCallOwnerActionIntent,
} from './phone-call-owner-action-intent.js';
import { ownerPhoneRecipientRequest } from './phone-call-owner-intent.js';

describe('v2 owner call action intent', () => {
  it.each([
    ['Call me now.', { kind: 'owner_self' }],
    ['Please call my number to discuss my appointment.', { kind: 'owner_self' }],
    ['Call +14155550123 about lunch.', { kind: 'explicit_number', recipientE164: '+14155550123' }],
    ['Call +14155550123, now.', { kind: 'explicit_number', recipientE164: '+14155550123' }],
    [
      'Call me at +14155550123 to ask about scheduling.',
      { kind: 'explicit_number', recipientE164: '+14155550123' },
    ],
    ['I would like you to phone me regarding the order', { kind: 'owner_self' }],
    [
      'Go ahead and call +14155550123 about lunch',
      { kind: 'explicit_number', recipientE164: '+14155550123' },
    ],
    [
      "I'd like you to call +14155550123 about lunch.",
      { kind: 'explicit_number', recipientE164: '+14155550123' },
    ],
  ] as const)('accepts a direct action with bounded destination: %s', (text, recipientRequest) => {
    expect(parsePhoneCallOwnerActionIntent(text)).toEqual({
      action: 'phone.call',
      recipientRequest,
    });
  });

  it('accepts a clear topic tail without changing the legacy parser result', () => {
    const text = 'Call me about my appointment.';
    expect(ownerPhoneRecipientRequest(text)).toBeNull();
    expect(parsePhoneCallOwnerActionIntent(text)).toEqual({
      action: 'phone.call',
      recipientRequest: { kind: 'owner_self' },
    });
  });

  it.each([
    'Call +14155550123 about lunch, I changed my mind.',
    'Call me about lunch. Forget that request.',
    'Call me now, perhaps later.',
    'Call +14155550123 about lunch maybe.',
    'Call +14155550123 or +14155550124.',
  ])('marks a routed withdrawn or ambiguous request as unsafe: %s', (text) => {
    expect(parsePhoneCallOwnerActionIntent(text)).toBeNull();
    expect(hasAmbiguousOrWithdrawnPhoneCallOwnerAction(text)).toBe(true);
  });

  it.each([
    'Call +14155550123 about rescheduling my appointment.',
    'Call +14155550123, now.',
    'Call me, please.',
  ])('does not classify a complete direct request as withdrawn: %s', (text) => {
    expect(parsePhoneCallOwnerActionIntent(text)).not.toBeNull();
    expect(hasAmbiguousOrWithdrawnPhoneCallOwnerAction(text)).toBe(false);
  });

  it.each(['Call +14155550123 to cancel my reservation.', 'Call +14155550123 about the bus stop.'])(
    'does not treat a topic word as a call withdrawal: %s',
    (text) => {
      expect(parsePhoneCallOwnerActionIntent(text)).toBeNull();
      expect(hasAmbiguousOrWithdrawnPhoneCallOwnerAction(text)).toBe(false);
    },
  );

  it.each([
    'My note says "Call +14155550123 about lunch."',
    'Please summarize the note about the call.',
    'Email Bob instead.',
    'Call it a day.',
  ])('does not classify a quoted or unrelated message as a routed call: %s', (text) => {
    expect(parsePhoneCallOwnerActionIntent(text)).toBeNull();
    expect(hasAmbiguousOrWithdrawnPhoneCallOwnerAction(text)).toBe(false);
  });

  it('marks a direct call that changes topic into an unrelated action as unsafe', () => {
    const text = 'Call +14155550123 about lunch. Actually, email Bob instead.';
    expect(parsePhoneCallOwnerActionIntent(text)).toBeNull();
    expect(hasAmbiguousOrWithdrawnPhoneCallOwnerAction(text)).toBe(true);
  });

  it.each([
    'Email Bob.',
    'Text Bob.',
    'Call Bob about the appointment.',
    'Call +14155550123 or +14155550124.',
    'If I am home, call me about the appointment.',
    'Call me about the appointment, but do not call.',
    'Call +14155550123 about lunch, I changed my mind.',
    'Call +14155550123 about lunch, forget that request.',
    'Call me now, perhaps later.',
    'Call +14155550123 about lunch and cancel if the office is closed.',
    'Call +14155550123 about lunch..',
    'Read the note, then call me.',
    'Do not call me about the appointment.',
    'Call me. Actually, no call is needed.',
    'My note says "Call me about the appointment."',
    "My note says 'Call me about the appointment.'",
    '> Call me about the appointment.',
    'Call me about the appointment\nwhen you can.',
    'Call me to say hello.',
    'Call the number I gave you about the appointment.',
    'Call me after the meeting.',
  ])('rejects unsafe, indirect, named, or unsupported text: %s', (text) => {
    expect(parsePhoneCallOwnerActionIntent(text)).toBeNull();
  });
});
