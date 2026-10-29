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
  it('keeps the prompt, conditions, and voicemail under a closed Permission details disclosure', () => {
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
    expect(html).toContain('Permission details');
    expect(html).toContain('Saved recipient label');
    expect(html).toContain('Context from the approved brief');
    expect(collapsed).not.toContain('Booking HARBOR-42 is for Friday evening.');
    expect(collapsed).not.toContain('May agree to: Accept check-in');
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain(
      'May agree to Accept check-in until 10 PM only if there is no new fee',
    );
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain(
      'Instructions in approved brief Do not change the reservation',
    );
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain(
      'Voicemail Hang up on voicemail',
    );
    expect(html).toContain('Maximum duration');
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

    expect(collapsed).not.toContain('Context: Not specified');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('May agree to Not specified');
    expect(text).toContain('Instructions in approved brief Not specified');
    expect(text).toContain('Exact voicemail message Not specified');
    expect(html).not.toMatch(/<details[^>]* open/);
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
const savedBoundedGrant = {
  schemaVersion: 2,
  grantId: 'f25132df-f619-43c2-96c9-b9c349470b6c',
  action: 'phone.call',
  recipientE164: '+14155550123',
  maxMinutes: 12,
  maxCallsPerHour: 2,
  maxCallsPerDay: 5,
  maxCostUsdMicrosPerCall: 1_250_000,
  maxCostUsdMicrosPerDay: 4_500_000,
  expiresAt: '2099-10-30T12:00:00.000Z',
};
const savedBoundedPolicy = {
  ...savedOwnerPolicy,
  id: 'saved-bounded-owner-call',
  templateKey: 'phone.call.owner_action.v2',
  match: savedBoundedGrant,
};

function renderSaved(policy = savedOwnerPolicy, flag = false) {
  return renderToStaticMarkup(
    <StandingApprovals policies={[projectStandingApprovalPolicy(policy, flag)]} />,
  );
}

describe('combined phone saved rows', () => {
  it('renders v2 destination, duration, rolling counts, costs, and expiry in the saved row', () => {
    const html = renderSaved({ ...savedBoundedPolicy, enabled: true }, true);
    expect(html).toContain('Call · +14155550123');
    expect(html).toContain('Direct owner calls · up to 12 min · 2/60 min, 5/24 h');
    expect(html).toContain('USD 1.25/call, 4.50/24 h');
    expect(html).toContain('expires Oct 30, 2099');
    expect(html).toContain('does not verify a person or answerer');
    expect(html).not.toContain('Enable rule');
  });

  it('shows the paused canonical destination and limits, then details and review without offering Enable', () => {
    const html = renderSaved();
    expect(html).toContain('Call · +14155550123');
    expect(html).toContain('Paused');
    expect(html).toContain(
      'Future owner-number calls · up to 12 min · expires Oct 30, 2099, 12:00 PM (UTC)',
    );
    expect(html).toContain(
      'Requests that add a topic, script, or other instructions require approval',
    );
    expect(html).toContain('/approvals#waiting-for-you');
    expect(html).toContain('Review a new permission');
    expect(html).toContain('This saved rule stays unchanged.');
    expect(html).toContain('Remove permission');
    expect(html).not.toContain('Enable rule');
    expect(html).toContain('does not verify who answers the call');
  });

  it.each([
    ['available', true, savedOwnerGrant, 'Available for direct requests'],
    ['system disabled', false, savedOwnerGrant, 'Disabled by system'],
    ['expired', true, { ...savedOwnerGrant, expiresAt: '2000-10-30T12:00:00.000Z' }, 'Expired'],
  ] as const)(
    'shows effective state for %s without offering Enable',
    (_name, flag, match, expected) => {
      const html = renderSaved({ ...savedOwnerPolicy, enabled: true, match }, flag);
      expect(html).toContain(expected);
      expect(html).toContain('Pause rule');
      expect(html).toContain('Remove permission');
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
    expect(html).toContain('Call · Saved scope unavailable');
    expect(html).toContain('Saved scope unavailable');
    expect(html).toContain('Permission details');
    expect(html).toContain('opaque-');
    expect(html).toContain('Remove permission');
    expect(html).not.toContain('Enable rule');
    expect(html).toContain('Review a new permission');
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

  it('keeps strict exact-brief phone rules non-enableable and retains the full brief in details', () => {
    const view = projectStandingApprovalPolicy({
      ...savedOwnerPolicy,
      enabled: true,
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
    expect(html).toContain('Call · +14155550123');
    expect(html).toContain('Available for exact brief');
    expect(html).toContain('Exact approved brief · up to 4 min · expiry not recorded');
    expect(html).toContain('Permission details');
    expect(html).toContain('Saved voicemail message (not used when hanging up)');
    expect(html).toContain('Retained saved message');
    expect(html).not.toContain('Enable rule');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('does not verify who answers');
  });

  it('shows a real pending-call review path for a paused exact brief', () => {
    const policy = {
      id: 'same-brief',
      toolName: 'phone.call',
      templateKey: 'phone.call.same_brief',
      match: {
        brief: {
          to: '+14155550123',
          goal: 'Confirm arrival',
          context: 'Arrival only',
          mayAgreeTo: '',
          mustNot: 'Do not change the booking.',
          language: 'English',
          maxMinutes: 4,
          onVoicemail: 'hang_up',
          voicemailMessage: '',
        },
      },
      enabled: false,
      effect: 'allow',
      createdVia: 'owner',
    };
    const html = renderToStaticMarkup(
      <StandingApprovals policies={[projectStandingApprovalPolicy(policy)]} />,
    );
    expect(html).toContain('Paused');
    expect(html).toContain('Review a new permission');
    expect(html).toContain('/approvals#waiting-for-you');
    expect(html).not.toContain('Enable rule');
    expect(html).not.toContain('Edit permission');
  });
});
