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

const ownerGrant = {
  schemaVersion: 1,
  grantId: 'e25132df-f619-43c2-96c9-b9c349470b6c',
  recipientE164: '+14155550123',
  maxMinutes: 12,
  expiresAt: '2099-10-30T12:00:00.000Z',
};
const ownerPolicy = {
  id: 'owner-call',
  toolName: 'phone.call',
  templateKey: 'phone.call.to_owner_number.v1',
  match: ownerGrant,
  effect: 'allow',
  enabled: true,
  createdVia: 'approval_dialog',
};

describe('combined strict phone presentation', () => {
  it('adds validated C availability and full saved data without changing the accepted A projector', () => {
    const view = projectStandingApprovalPolicy(ownerPolicy, true);
    expect(view.phonePermissionKind).toBe('owner_number');
    expect(view.scope).toContain(
      'Requests that add a topic, script, or other instructions require approval',
    );
    expect(view.label).toBe('Future calls to an approved number');
    expect(view.effectiveAvailability).toContain('Available for a matching direct request');
    expect(JSON.parse(view.opaqueDetails!)).toEqual(ownerGrant);
    expect(view.phoneCallPresentation?.kind).toBe('opaque');
  });

  it.each([
    ['system disabled', ownerPolicy, false, 'disabled by the system'],
    ['paused', { ...ownerPolicy, enabled: false }, true, 'this entry remains paused'],
    [
      'expired',
      { ...ownerPolicy, match: { ...ownerGrant, expiresAt: '2000-10-30T12:00:00.000Z' } },
      true,
      'Expired',
    ],
  ] as const)('preserves the effective state: %s', (_name, policy, flag, text) => {
    expect(projectStandingApprovalPolicy(policy, flag).effectiveAvailability).toContain(text);
  });

  it.each([
    ['malformed C', 'phone.call.to_owner_number.v1', { ...ownerGrant, extra: true }],
    ['unknown phone', 'phone.call.future.v2', { fullUnknownData: 'retain this' }],
    ['malformed A', 'phone.call.same_brief', { brief: { ...brief, futureUnknownKey: true } }],
  ])('keeps %s opaque without inferred authority', (_name, templateKey, match) => {
    const view = projectStandingApprovalPolicy({ ...ownerPolicy, templateKey, match }, true);
    expect(view.phonePermissionKind).toBe('opaque');
    expect(view.label).toBe('Stored phone permission');
    expect(view.scope).toBeNull();
    expect(view.phoneCallPresentation?.kind).toBe('opaque');
    expect(JSON.parse(view.opaqueDetails!)).toEqual(match);
    expect(view.effectiveAvailability ?? '').not.toContain(
      'Available for a matching direct request',
    );
  });

  it('keeps non-phone generic behavior with a phone-like template and never adds phone authority fields', () => {
    const view = projectStandingApprovalPolicy(
      { ...ownerPolicy, toolName: 'other.tool', label: 'Custom generic label' },
      true,
    );
    expect(view.label).toBe('Custom generic label');
    expect(view.phonePermissionKind).toBeNull();
    expect(view.phoneCallPresentation).toBeNull();
    expect(view.opaqueDetails).toBeNull();
    expect(view.effectiveAvailability).toBeNull();
  });
});
