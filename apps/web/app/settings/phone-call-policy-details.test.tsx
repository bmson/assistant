import type { PhoneCallPolicyPresentation } from '@assistant/application/approval-policy-presentation';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { policyScope } from '@/app/settings/labels';
import { projectStandingApprovalPolicy } from '@/lib/standing-approval-view';
import { StandingApprovals } from './standing-approvals';

vi.mock('./actions', () => ({
  deletePolicy: async () => {},
  setPolicyEnabled: async () => {},
}));

import { PhoneCallPolicyDetails } from './phone-call-policy-details';

describe('phone-call standing-rule settings details', () => {
  it('keeps long conditions readable and distinguishes a saved hang-up message from a message to leave', () => {
    const presentation: Extract<PhoneCallPolicyPresentation, { kind: 'same_brief' }> = {
      kind: 'same_brief',
      recipient: '+14155550123',
      contactName: 'Harbor Hotel',
      maxMinutes: 4,
      goal: 'Confirm the late check-in time',
      mayShare:
        'Booking HARBOR-42 is for Friday evening. The train is expected at 8:15 PM, and the front desk asked for an arrival estimate before 9 PM. Share only this booking and arrival context; do not add unrelated personal details.',
      mayAgreeTo:
        'Accept check-in until 10 PM only if there is no new fee, the room remains the existing reservation, and the hotel confirms the booking reference. If any condition is unclear, do not agree and ask Alex to decide.',
      mustNot:
        'Do not change the reservation, room type, dates, guest count, payment method, or cancellation terms. Do not accept a deposit, fee, upgrade, or other charge. Do not disclose a home address or any detail outside the approved context.',
      language: 'English',
      voicemailMode: 'hang_up',
      voicemailMessage:
        'This saved message belongs to the original brief and must remain visible for review even though the selected voicemail mode is hang up.',
    };
    const html = renderToStaticMarkup(<PhoneCallPolicyDetails presentation={presentation} />);
    const collapsed = html.split('<details')[0] ?? html;

    expect(html).toContain('Harbor Hotel');
    expect(html).toContain('+14155550123');
    expect(html).toContain('up to 4 min');
    expect(html).toContain('Exact approved brief');
    expect(html).toContain('Context from the approved brief');
    expect(collapsed).not.toContain('Booking HARBOR-42 is for Friday evening.');
    expect(html).toContain('May agree to: Accept check-in until 10 PM only if there is no new fee');
    expect(html).toContain('Instructions in approved brief: Do not change the reservation');
    expect(html).toContain('Voicemail: Hang up on voicemail');
    expect(html).toContain('Exact call brief');
    expect(html).toContain('Booking HARBOR-42 is for Friday evening.');
    expect(html).toContain('Do not change the reservation, room type, dates');
    expect(html).toContain('Saved voicemail message (not used when hanging up)');
    expect(html).toContain('This saved message belongs to the original brief');
    expect(html).toMatch(/<details class="[^"]*">/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('break-words');
  });

  it('uses Not specified consistently for empty approved-brief conditions', () => {
    const presentation: Extract<PhoneCallPolicyPresentation, { kind: 'same_brief' }> = {
      kind: 'same_brief',
      recipient: '+14155550123',
      contactName: '',
      maxMinutes: 4,
      goal: 'Confirm the late check-in time',
      mayShare: '',
      mayAgreeTo: '',
      mustNot: '',
      language: '',
      voicemailMode: 'leave_message',
      voicemailMessage: '',
    };
    const html = renderToStaticMarkup(<PhoneCallPolicyDetails presentation={presentation} />);
    const collapsed = html.split('<details')[0] ?? html;

    expect(collapsed).toContain('Context: Not specified');
    expect(html).toContain('May agree to: Not specified');
    expect(html).toContain('Instructions in approved brief: Not specified');
    expect(html).toContain('exact message: Not specified');
  });
});

const savedOwnerGrant = {
  schemaVersion: 1,
  grantId: 'e25132df-f619-43c2-96c9-b9c349470b6c',
  recipientE164: '+14155550123',
  maxMinutes: 12,
  expiresAt: '2099-10-30T12:00:00.000Z',
};
const savedOwnerPolicy = {
  id: 'saved-owner-call',
  toolName: 'phone.call',
  templateKey: 'phone.call.to_owner_number.v1',
  match: savedOwnerGrant,
  enabled: false,
  effect: 'allow',
  createdVia: 'approval_dialog',
};

function renderSaved(policy = savedOwnerPolicy, flag = false) {
  return renderToStaticMarkup(
    <StandingApprovals policies={[projectStandingApprovalPolicy(policy, flag)]} />,
  );
}

describe('combined phone saved rows', () => {
  it('shows paused validated C full scope/raw/state and fresh review without offering Enable', () => {
    const html = renderSaved();
    expect(html).toContain('Stored setting: Off');
    expect(html).toContain('2099-10-30T12:00:00.000Z');
    expect(html).toContain(savedOwnerGrant.grantId);
    expect(html).toContain(
      'Requests that add a topic, script, or other instructions require approval',
    );
    expect(html).toContain('/approvals#waiting-for-you');
    expect(html).toContain('This paused entry remains unchanged.');
    expect(html).toContain('Delete rule');
    expect(html).not.toContain('Enable rule');
    expect(html).not.toContain('Saved phone-call scope (not interpreted)');
  });

  it.each([
    ['available', true, savedOwnerGrant, 'Available for a matching direct request'],
    ['system disabled', false, savedOwnerGrant, 'disabled by the system'],
    ['expired', true, { ...savedOwnerGrant, expiresAt: '2000-10-30T12:00:00.000Z' }, 'Expired'],
  ] as const)(
    'keeps stored On distinct from %s and permits Pause/Delete only',
    (_name, flag, match, expected) => {
      const html = renderSaved({ ...savedOwnerPolicy, enabled: true, match }, flag);
      expect(html).toContain('Stored setting: On');
      expect(html).toContain(expected);
      expect(html).toContain('Pause rule');
      expect(html).toContain('Delete rule');
      expect(html).not.toContain('Enable rule');
    },
  );

  it.each([
    [
      'malformed C',
      'phone.call.to_owner_number.v1',
      { ...savedOwnerGrant, unexpected: 'opaque-extra' },
    ],
    ['unknown PHONE', 'phone.call.future.v2', { fullUnknownData: 'opaque-full-value' }],
  ])('preserves %s raw/state without resume guidance', (_name, templateKey, match) => {
    const policy = { ...savedOwnerPolicy, templateKey, match };
    const html = renderToStaticMarkup(
      <StandingApprovals policies={[projectStandingApprovalPolicy(policy, true)]} />,
    );
    expect(html).toContain('Stored setting: Off');
    expect(html).toContain('Saved phone-call scope (not interpreted)');
    expect(html).toContain('Stored permission details');
    expect(html).toContain('opaque-');
    expect(html).toContain('Delete rule');
    expect(html).not.toContain('Enable rule');
    expect(html).not.toContain('pending owner call');
    const on = renderToStaticMarkup(
      <StandingApprovals
        policies={[projectStandingApprovalPolicy({ ...policy, enabled: true }, true)]}
      />,
    );
    expect(on).toContain('Pause rule');
  });

  it('keeps non-phone generic Enable behavior even with a phone-like template', () => {
    const policy = { ...savedOwnerPolicy, toolName: 'other.tool' };
    const view = projectStandingApprovalPolicy(policy);
    expect(view.scope).toBe(policyScope(policy.templateKey, policy.match));
    const html = renderToStaticMarkup(<StandingApprovals policies={[view]} />);
    expect(html).toContain('Enable rule');
    expect(html).not.toContain('Stored setting:');
    expect(html).not.toContain('/approvals#waiting-for-you');
    expect(html).not.toContain('This paused entry remains unchanged.');
  });

  it('keeps strict A renderer and generic enable controls', () => {
    const view = projectStandingApprovalPolicy({
      ...savedOwnerPolicy,
      templateKey: 'phone.call.same_brief',
      match: {
        brief: {
          to: '+14155550123',
          goal: 'Confirm arrival',
          context: 'Only arrival',
          mayAgreeTo: '',
          mustNot: '',
          language: 'English',
          maxMinutes: 4,
          onVoicemail: 'hang_up',
          voicemailMessage: 'Retained saved message',
        },
      },
    });
    const html = renderToStaticMarkup(<StandingApprovals policies={[view]} />);
    expect(html).toContain('Repeat approved call');
    expect(html).toContain('Exact approved brief');
    expect(html).toContain('Saved voicemail message (not used when hanging up)');
    expect(html).toContain('Retained saved message');
    expect(html).toContain('Enable rule');
    expect(html).not.toContain('Stored setting:');
  });
});
