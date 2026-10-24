import { describe, expect, it } from 'vitest';
import { projectStandingApprovalPolicy } from './standing-approval-view';

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

describe('standing approval web projection', () => {
  it('adds structured phone details without changing the legacy policy label or scope', () => {
    const policy = {
      id: 'call-rule',
      toolName: 'phone.call',
      templateKey: 'phone.call.same_brief',
      match: { brief },
      effect: 'allow',
      enabled: true,
      createdVia: 'owner',
    };

    expect(projectStandingApprovalPolicy(policy)).toMatchObject({
      id: 'call-rule',
      toolName: 'phone.call',
      templateKey: 'phone.call.same_brief',
      label: expect.any(String),
      scope: expect.any(String),
      effect: 'allow',
      enabled: true,
      createdVia: 'owner',
      phoneCallPresentation: {
        kind: 'same_brief',
        recipient: '+14155550123',
        maxMinutes: 4,
      },
    });
  });

  it('uses the default dictionary label and preserves a custom saved label', () => {
    const policy = {
      id: 'call-rule',
      toolName: 'phone.call',
      templateKey: 'phone.call.same_brief',
      match: { brief },
      effect: 'allow',
      enabled: true,
      createdVia: 'owner',
    };

    expect(projectStandingApprovalPolicy(policy).label).toBe('Repeat approved call');
    expect(projectStandingApprovalPolicy({ ...policy, label: 'Call the Harbor desk' }).label).toBe(
      'Call the Harbor desk',
    );
  });
});
