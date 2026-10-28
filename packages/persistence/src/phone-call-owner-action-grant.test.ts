import { describe, expect, it } from 'vitest';
import {
  type OwnerCallActionGrantMatch,
  parsePhoneCallOwnerActionGrantMatch,
  phoneCallOwnerActionGrantBindingMatches,
  phoneCallOwnerActionGrantIsLive,
  phoneCallOwnerActionGrantMatches,
  phoneCallOwnerActionGrantScopeFingerprint,
  reserveOwnerCallGrantUsage,
} from './phone-call-owner-action-grant.js';
import { parsePhoneCallOwnerActionIntent } from './phone-call-owner-action-intent.js';
import type { DirectOwnerCallRequestBinding } from './phone-call-owner-number-grant.js';

const valid: OwnerCallActionGrantMatch = {
  schemaVersion: 2,
  grantId: 'd42d54a2-83f4-4aa0-900d-1f3e67ae3a18',
  action: 'phone.call',
  recipientE164: '+14155550123',
  maxMinutes: 12,
  maxCallsPerHour: 2,
  maxCallsPerDay: 4,
  maxCostUsdMicrosPerCall: 500_000,
  maxCostUsdMicrosPerDay: 1_000_000,
  expiresAt: '2026-10-30T12:00:00.000Z',
};

const request: DirectOwnerCallRequestBinding = {
  agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ownerMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  requestHash: 'a'.repeat(64),
  clientOperationId: '11111111-1111-4111-8111-111111111111',
  taskTriggerFingerprint: 'b'.repeat(64),
  ownerMessageFingerprint: 'c'.repeat(64),
  recipientRequest: null,
};

const intent = {
  action: 'phone.call' as const,
  recipientRequest: { kind: 'owner_self' as const },
};

describe('phone.call.owner_action.v2 stored scope', () => {
  it('accepts only the exact bounded schema version', () => {
    expect(parsePhoneCallOwnerActionGrantMatch(valid)).toEqual(valid);
    expect(parsePhoneCallOwnerActionGrantMatch({ ...valid, extra: true })).toBeNull();
    expect(parsePhoneCallOwnerActionGrantMatch({ ...valid, schemaVersion: 1 })).toBeNull();
  });

  it.each([
    ['non-UUID grant id', { ...valid, grantId: 'server-generated' }],
    ['noncanonical recipient', { ...valid, recipientE164: '+1 (415) 555-0123' }],
    ['zero duration', { ...valid, maxMinutes: 0 }],
    ['duration beyond system ceiling', { ...valid, maxMinutes: 61 }],
    ['zero hourly cap', { ...valid, maxCallsPerHour: 0 }],
    ['hourly cap above bound', { ...valid, maxCallsPerHour: 101 }],
    ['fractional daily cap', { ...valid, maxCallsPerDay: 1.5 }],
    ['negative per-call cost', { ...valid, maxCostUsdMicrosPerCall: -1 }],
    ['zero daily cost', { ...valid, maxCostUsdMicrosPerDay: 0 }],
    ['negative daily cost', { ...valid, maxCostUsdMicrosPerDay: -1 }],
    ['hourly cap above daily cap', { ...valid, maxCallsPerHour: 5 }],
    ['per-call cost above daily budget', { ...valid, maxCostUsdMicrosPerCall: 2_000_000 }],
    ['unsafe daily cost', { ...valid, maxCostUsdMicrosPerDay: Number.MAX_SAFE_INTEGER + 1 }],
    ['offset expiry', { ...valid, expiresAt: '2026-10-30T05:00:00-07:00' }],
    ['invalid expiry', { ...valid, expiresAt: '2026-02-30T12:00:00.000Z' }],
  ])('rejects %s', (_label, value) => {
    expect(parsePhoneCallOwnerActionGrantMatch(value)).toBeNull();
  });

  it('matches only action destination and duration; topic text is not a grant field', () => {
    expect(
      phoneCallOwnerActionGrantMatches(valid, { to: valid.recipientE164, maxMinutes: 10 }),
    ).toBe(true);
    expect(phoneCallOwnerActionGrantMatches(valid, { to: '+14155550124', maxMinutes: 10 })).toBe(
      false,
    );
    expect(
      phoneCallOwnerActionGrantMatches(valid, { to: valid.recipientE164, maxMinutes: 13 }),
    ).toBe(false);
    expect(phoneCallOwnerActionGrantIsLive(valid, new Date('2026-10-30T11:59:59.999Z'))).toBe(true);
    expect(phoneCallOwnerActionGrantIsLive(valid, new Date(valid.expiresAt))).toBe(false);
    expect(phoneCallOwnerActionGrantIsLive(valid, new Date(Number.NaN))).toBe(false);
    expect(phoneCallOwnerActionGrantScopeFingerprint(valid)).toMatch(/^[a-f0-9]{64}$/);
    expect(phoneCallOwnerActionGrantScopeFingerprint({ ...valid, extra: true })).toBeNull();
  });

  it('binds the live parsed owner action, exact policy, recipient, and server cost quote', () => {
    const parsedIntent = parsePhoneCallOwnerActionIntent('Call me about my appointment.');
    expect(parsedIntent).not.toBeNull();
    if (!parsedIntent) return;
    const expected = {
      policyId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      match: valid,
      directOwnerRequest: request,
      ownerActionIntent: {
        intent: parsedIntent,
        ownerMessageFingerprint: request.ownerMessageFingerprint,
      },
      recipientAuthority: {
        kind: 'configured_owner_phone' as const,
        recipientE164: valid.recipientE164,
        fingerprint: 'd'.repeat(64),
      },
      estimatedCostUsdMicros: 400_000,
    };
    const row = {
      id: expected.policyId,
      agentId: request.agentId,
      toolName: 'phone.call',
      templateKey: 'phone.call.owner_action.v2',
      effect: 'allow',
      enabled: true,
      match: valid,
    };
    const current = { directOwnerRequest: request, ownerActionIntent: parsedIntent };
    const now = new Date('2026-10-23T12:00:00.000Z');
    expect(
      phoneCallOwnerActionGrantBindingMatches(
        expected,
        row,
        request.agentId,
        { to: valid.recipientE164, maxMinutes: 8 },
        now,
        expected.recipientAuthority.fingerprint,
        current,
      ),
    ).toBe(true);
    expect(
      phoneCallOwnerActionGrantBindingMatches(
        expected,
        { ...row, enabled: false },
        request.agentId,
        { to: valid.recipientE164, maxMinutes: 8 },
        now,
        expected.recipientAuthority.fingerprint,
        current,
      ),
    ).toBe(false);
    const mismatchedOwnerRequest = {
      ...request,
      recipientRequest: { kind: 'explicit_number' as const, recipientE164: '+14155550999' },
    };
    expect(
      phoneCallOwnerActionGrantBindingMatches(
        { ...expected, directOwnerRequest: mismatchedOwnerRequest },
        row,
        request.agentId,
        { to: valid.recipientE164, maxMinutes: 8 },
        now,
        expected.recipientAuthority.fingerprint,
        { directOwnerRequest: mismatchedOwnerRequest, ownerActionIntent: parsedIntent },
      ),
    ).toBe(false);
    expect(
      phoneCallOwnerActionGrantBindingMatches(
        { ...expected, estimatedCostUsdMicros: 500_001 },
        row,
        request.agentId,
        { to: valid.recipientE164, maxMinutes: 8 },
        now,
        expected.recipientAuthority.fingerprint,
        current,
      ),
    ).toBe(false);
    expect(
      phoneCallOwnerActionGrantBindingMatches(
        expected,
        row,
        request.agentId,
        { to: '+14155550124', maxMinutes: 8 },
        now,
        expected.recipientAuthority.fingerprint,
        current,
      ),
    ).toBe(false);
    expect(
      phoneCallOwnerActionGrantBindingMatches(
        expected,
        row,
        request.agentId,
        { to: valid.recipientE164, maxMinutes: 8 },
        now,
        'e'.repeat(64),
        current,
      ),
    ).toBe(false);
  });
});

describe('phone.call.owner_action.v2 rolling usage receipt', () => {
  const scope = {
    ownerId: request.agentId,
    policyId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    match: valid,
  };
  const now = new Date('2026-10-23T12:00:00.000Z');

  it('charges the server quote once and makes same-id/same-cost retries idempotent', () => {
    const first = reserveOwnerCallGrantUsage(
      scope,
      null,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      now,
      400_000,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.usage.events).toEqual([
      { toolCallId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', at: now, costUsdMicros: 400_000 },
    ]);
    const replay = reserveOwnerCallGrantUsage(
      scope,
      first.usage,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      now,
      400_000,
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (replay.ok) expect(replay.usage.events).toHaveLength(1);
    expect(
      reserveOwnerCallGrantUsage(
        scope,
        first.usage,
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        now,
        400_001,
      ),
    ).toMatchObject({ ok: false });
  });

  it('enforces rolling count and cost limits and prunes events older than 24 hours', () => {
    const oneCallScope = { ...scope, match: { ...valid, maxCallsPerHour: 1, maxCallsPerDay: 1 } };
    const first = reserveOwnerCallGrantUsage(
      oneCallScope,
      null,
      '11111111-1111-4111-8111-111111111112',
      now,
      400_000,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      reserveOwnerCallGrantUsage(
        oneCallScope,
        first.usage,
        '22222222-2222-4222-8222-222222222222',
        new Date(now.getTime() + 1),
        100_000,
      ),
    ).toMatchObject({ ok: false, reason: 'owner-call grant daily call limit reached' });

    const expiredUsage = {
      ownerId: scope.ownerId,
      policyId: scope.policyId,
      grantScopeFingerprint: phoneCallOwnerActionGrantScopeFingerprint(valid)!,
      events: [
        {
          toolCallId: '33333333-3333-4333-8333-333333333333',
          at: new Date(now.getTime() - 24 * 60 * 60_000),
          costUsdMicros: 900_000,
        },
      ],
      updatedAt: now,
    };
    const pruned = reserveOwnerCallGrantUsage(
      scope,
      expiredUsage,
      '44444444-4444-4444-8444-444444444444',
      now,
      400_000,
    );
    expect(pruned).toMatchObject({ ok: true, replayed: false });
    if (pruned.ok)
      expect(pruned.usage.events.map((event) => event.toolCallId)).toEqual([
        '44444444-4444-4444-8444-444444444444',
      ]);

    const costLimited = {
      ...scope,
      match: { ...valid, maxCostUsdMicrosPerDay: 600_000 },
    };
    const costFirst = reserveOwnerCallGrantUsage(
      costLimited,
      null,
      '55555555-5555-4555-8555-555555555555',
      now,
      400_000,
    );
    expect(costFirst.ok).toBe(true);
    if (!costFirst.ok) return;
    expect(
      reserveOwnerCallGrantUsage(
        costLimited,
        costFirst.usage,
        '66666666-6666-4666-8666-666666666666',
        now,
        300_000,
      ),
    ).toMatchObject({ ok: false, reason: 'owner-call grant daily cost limit reached' });
  });
});
