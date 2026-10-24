import { expect, it } from 'vitest';
import {
  phonePermissionAvailability,
  phonePermissionKind,
  phonePermissionLabel,
  phonePermissionOpaqueDetails,
  policyScope,
} from './labels.js';

const match = {
  schemaVersion: 1,
  grantId: '11111111-1111-4111-8111-111111111111',
  recipientE164: '+14155550123',
  maxMinutes: 8,
  expiresAt: '2026-10-30T12:00:00.000Z',
};
it('labels only strict known scopes; preserves all malformed/unknown details opaquely', () => {
  expect(phonePermissionKind('phone.call.to_owner_number.v1', match)).toBe('owner_number');
  expect(
    phonePermissionKind('phone.call.same_brief', {
      brief: { to: match.recipientE164, goal: 'Discuss appointment', maxMinutes: 8 },
    }),
  ).toBe('same_brief');
  for (const [template, scope] of [
    [
      'phone.call.future.v9',
      { topic: 'unrecognized', deep: { secretMeaning: 'retain every key' } },
    ],
    ['phone.call.to_owner_number.v1', { ...match, unexpected: 'retain this' }],
    [
      'phone.call.same_brief',
      { brief: { to: match.recipientE164, goal: 'Discuss appointment' }, unknown: 'retain this' },
    ],
  ] as const) {
    expect(phonePermissionKind(template, scope)).toBe('opaque');
    expect(phonePermissionLabel(template, scope)).toBe('Stored phone permission');
    expect(phonePermissionOpaqueDetails(template, scope)).toBe(JSON.stringify(scope, null, 2));
  }
});
it('distinguishes stored state from effective availability without enabling paused/system-disabled/expired entries', () => {
  const policy = {
    templateKey: 'phone.call.to_owner_number.v1',
    match,
    effect: 'allow',
    enabled: true,
  };
  const now = new Date('2026-10-23T12:00:00.000Z');
  expect(phonePermissionAvailability(policy, false, now)).toContain('disabled by the system');
  expect(phonePermissionAvailability({ ...policy, enabled: false }, true, now)).toContain('Paused');
  expect(phonePermissionAvailability(policy, true, new Date(match.expiresAt))).toContain('Expired');
  expect(phonePermissionAvailability(policy, true, now)).toContain('matching direct request');
  expect(policyScope(policy.templateKey, match)).toContain('Requested duration ceiling');
  expect(policyScope(policy.templateKey, match)).toContain(
    'Routing to this number does not verify who answers',
  );
});
