import { describe, expect, it } from 'vitest';
import {
  securityIncidentId,
  securityIncidentIdentity,
  validateSecurityIncidentEvidence,
} from './security-incidents.js';

describe('security incident provenance', () => {
  const base = {
    agentId: 'owner-a',
    authenticated: true,
    sourceText:
      'New sign-in to owner@example.com from Pixel 9 in San Francisco at 2026-10-06T18:30:00Z.',
  };
  const evidence = {
    eventType: 'sign-in',
    affectedAccount: 'owner@example.com',
    eventAt: '2026-10-06T18:30:00Z',
    device: 'Pixel 9',
    location: 'San Francisco',
    evidenceQuote:
      'New sign-in to owner@example.com from Pixel 9 in San Francisco at 2026-10-06T18:30:00Z.',
  };

  it('rejects extracted details unless the supporting quote is present verbatim', () => {
    expect(validateSecurityIncidentEvidence(evidence, base.sourceText)).toEqual(evidence);
    expect(
      validateSecurityIncidentEvidence(
        { ...evidence, affectedAccount: 'victim@example.com' },
        base.sourceText,
      ),
    ).toBeNull();
    expect(
      validateSecurityIncidentEvidence(
        { ...evidence, evidenceQuote: 'New sign-in from a device' },
        base.sourceText,
      ),
    ).toBeNull();
  });

  it('joins a recovery copy only when its explicit reference and event evidence match', () => {
    const original = securityIncidentIdentity({
      ...base,
      channelMessageId: 'gmail:original',
      sourceMessageId: '<source@example.net>',
      evidence,
    });
    const recovery = securityIncidentIdentity({
      ...base,
      channelMessageId: 'gmail:recovery',
      sourceMessageId: '<copy@example.net>',
      sourceText: `${base.sourceText} This is a recovery copy of <source@example.net>.`,
      evidence: {
        ...evidence,
        recoveryCopyOf: '<source@example.net>',
        evidenceQuote: `${evidence.evidenceQuote} This is a recovery copy of <source@example.net>.`,
      },
    });
    expect(recovery.incidentKey).toBe(original.incidentKey);
    expect(recovery.evidenceFingerprint).toBe(original.evidenceFingerprint);
    expect(recovery.confidence).toBe('recovery-reference');

    const differentEventTime = securityIncidentIdentity({
      ...base,
      channelMessageId: 'gmail:different-time',
      sourceMessageId: '<copy-2@example.net>',
      evidence: {
        ...evidence,
        eventAt: '2026-10-06T18:31:00Z',
        evidenceQuote:
          'New sign-in to owner@example.com from Pixel 9 in San Francisco at 2026-10-06T18:31:00Z.',
        recoveryCopyOf: '<source@example.net>',
      },
    });
    expect(differentEventTime.incidentKey).not.toBe(original.incidentKey);
  });

  it('keeps weak or unauthenticated observations separate without sender/subject clues', () => {
    const one = securityIncidentIdentity({
      ...base,
      channelMessageId: 'gmail:one',
      sourceMessageId: null,
      authenticated: false,
      evidence,
    });
    const two = securityIncidentIdentity({
      ...base,
      channelMessageId: 'gmail:two',
      sourceMessageId: null,
      authenticated: false,
      evidence,
    });
    expect(one.confidence).toBe('separate-source');
    expect(one.incidentKey).not.toBe(two.incidentKey);
  });

  it('returns a deterministic UUID-shaped id scoped to the owner', () => {
    const id = securityIncidentId('owner-a', 'incident-key');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(securityIncidentId('owner-a', 'incident-key')).toBe(id);
    expect(securityIncidentId('owner-b', 'incident-key')).not.toBe(id);
  });
});
