import { describe, expect, it } from 'vitest';
import { phoneCallPolicyPresentation } from './approval-policy-presentation.js';

const brief = {
  to: '+14155550123',
  contactName: 'Harbor Hotel',
  goal: 'Confirm the late check-in time',
  context: 'Arriving Friday after 8 PM; booking reference HARBOR-42.',
  mayAgreeTo: 'A check-in time no later than 10 PM.',
  mustNot: 'Do not change the reservation or pay a deposit.',
  language: 'English',
  maxMinutes: 4,
  onVoicemail: 'leave_message',
  voicemailMessage: 'This is Alex confirming a late arrival.',
};

describe('phone-call standing-rule presentation', () => {
  it('projects every condition from a valid legacy exact-brief rule', () => {
    expect(
      phoneCallPolicyPresentation({
        toolName: 'phone.call',
        templateKey: 'phone.call.same_brief',
        match: { brief },
      }),
    ).toEqual({
      kind: 'same_brief',
      recipient: '+14155550123',
      contactName: 'Harbor Hotel',
      maxMinutes: 4,
      goal: 'Confirm the late check-in time',
      mayShare: 'Arriving Friday after 8 PM; booking reference HARBOR-42.',
      mayAgreeTo: 'A check-in time no later than 10 PM.',
      mustNot: 'Do not change the reservation or pay a deposit.',
      language: 'English',
      voicemailMode: 'leave_message',
      voicemailMessage: 'This is Alex confirming a late arrival.',
    });
  });

  it('keeps unknown and malformed phone rules as uninterpreted full JSON', () => {
    const unknownMatch = { number: '+14155550123', futureField: { enabled: true } };
    expect(
      phoneCallPolicyPresentation({
        toolName: 'phone.call',
        templateKey: 'phone.call.future_template',
        match: unknownMatch,
      }),
    ).toEqual({ kind: 'opaque', details: JSON.stringify(unknownMatch, null, 2) });

    const malformedMatch = { brief: { ...brief, addedAuthority: 'not allowed' } };
    expect(
      phoneCallPolicyPresentation({
        toolName: 'phone.call',
        templateKey: 'phone.call.same_brief',
        match: malformedMatch,
      }),
    ).toEqual({ kind: 'opaque', details: JSON.stringify(malformedMatch, null, 2) });
  });

  it('does not add phone-call presentation to other tools', () => {
    expect(
      phoneCallPolicyPresentation({
        toolName: 'gmail.send',
        templateKey: 'gmail.send.to_recipient',
        match: { recipient: 'owner@example.test' },
      }),
    ).toBeNull();
  });

  it('keeps voicemail modes distinct for the same saved number and duration', () => {
    const original = phoneCallPolicyPresentation({
      toolName: 'phone.call',
      templateKey: 'phone.call.same_brief',
      match: { brief },
    });
    const hangUp = phoneCallPolicyPresentation({
      toolName: 'phone.call',
      templateKey: 'phone.call.same_brief',
      match: {
        brief: {
          ...brief,
          onVoicemail: 'hang_up',
          voicemailMessage: 'Saved only for reference; do not leave this message.',
        },
      },
    });

    expect(original).toMatchObject({
      recipient: '+14155550123',
      maxMinutes: 4,
      voicemailMode: 'leave_message',
    });
    expect(hangUp).toMatchObject({
      recipient: '+14155550123',
      maxMinutes: 4,
      voicemailMode: 'hang_up',
      voicemailMessage: 'Saved only for reference; do not leave this message.',
    });
  });
});
