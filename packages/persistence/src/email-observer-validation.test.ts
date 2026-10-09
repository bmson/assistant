import { describe, expect, it } from 'vitest';
import {
  emailAttachmentManifestDigest,
  emailObserverPreparedCardMatches,
  isValidEmailAttachmentPreparedResult,
  isValidEmailObserverPreparedResult,
  sameEmailObserverPreparedResult,
} from './index.js';

describe('durable email observer prepared result validation', () => {
  it('accepts only explicitly registered empty-result observers', () => {
    expect(isValidEmailObserverPreparedResult('watches.email-match', {})).toBe(true);
    expect(isValidEmailObserverPreparedResult('google.application-confirmation', {})).toBe(true);
    expect(
      isValidEmailObserverPreparedResult('google.direct-email-routing', { route: 'email_triage' }),
    ).toBe(true);
    expect(
      isValidEmailObserverPreparedResult('google.direct-email-routing', {
        route: 'needs_attention',
      }),
    ).toBe(false);
    expect(isValidEmailObserverPreparedResult('unknown.observer', {})).toBe(false);
    expect(isValidEmailObserverPreparedResult('watches.email-match', { result: 'extra' })).toBe(
      false,
    );
  });

  it('binds every attachment entry to the ordered manifest digest', () => {
    const entries = [
      {
        providerAttachmentId: 'att-a',
        ordinal: 0,
        filename: 'invoice.pdf',
        mime: 'application/pdf',
        advertisedBytes: 123,
      },
      {
        providerAttachmentId: 'att-b',
        ordinal: 1,
        filename: 'notes.txt',
        mime: 'text/plain',
        advertisedBytes: 0,
      },
    ];
    const manifestDigest = emailAttachmentManifestDigest(entries);
    expect(manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    const valid = { messageId: 'gmail-message', manifestDigest, entries };
    expect(isValidEmailAttachmentPreparedResult(valid)).toBe(true);
    expect(isValidEmailObserverPreparedResult('google.email-attachments', valid)).toBe(true);
    expect(
      isValidEmailAttachmentPreparedResult({
        ...valid,
        entries: [entries[1], entries[0]],
      }),
    ).toBe(false);
    expect(
      isValidEmailAttachmentPreparedResult({
        ...valid,
        entries: [{ ...entries[0], filename: 'different.pdf' }, entries[1]],
      }),
    ).toBe(false);
    expect(
      isValidEmailAttachmentPreparedResult({
        ...valid,
        entries: [{ ...entries[0], extra: 'unbound' }, entries[1]],
      }),
    ).toBe(false);
    expect(
      isValidEmailAttachmentPreparedResult({
        ...valid,
        entries: [
          { ...entries[0], ordinal: 1 },
          { ...entries[1], ordinal: 0 },
        ],
      }),
    ).toBe(false);
  });

  it('rejects duplicate identities, invalid MIME, and more than eight entries', () => {
    const one = {
      providerAttachmentId: 'att-a',
      ordinal: 0,
      filename: 'invoice.pdf',
      mime: 'application/pdf',
      advertisedBytes: 123,
    };
    const valid = {
      messageId: 'gmail-message',
      manifestDigest: emailAttachmentManifestDigest([one]),
      entries: [one],
    };
    expect(
      isValidEmailAttachmentPreparedResult({
        ...valid,
        entries: [one, { ...one, ordinal: 1 }],
      }),
    ).toBe(false);
    expect(
      isValidEmailAttachmentPreparedResult({
        ...valid,
        entries: [{ ...one, mime: 'application/pdf\r\nX: bad' }],
      }),
    ).toBe(false);
    expect(
      isValidEmailAttachmentPreparedResult({
        ...valid,
        entries: Array.from({ length: 9 }, (_, ordinal) => ({
          ...one,
          ordinal,
          providerAttachmentId: `att-${ordinal}`,
        })),
      }),
    ).toBe(false);
  });

  it('enforces the byte bound for multibyte UTF-8 strings', () => {
    const valid = {
      kind: 'generated-card',
      id: '11111111-1111-4111-8111-111111111111',
      revisionId: '22222222-2222-4222-8222-222222222222',
      sourceFingerprint: 'a'.repeat(64),
      grounding: 'evidence',
      spec: { title: '🌊'.repeat(10_000), subtitle: '🌊'.repeat(10_000), actions: [] },
    };
    const oversized = { ...valid, spec: { ...valid.spec, description: '🌊'.repeat(10_000) } };
    expect(isValidEmailObserverPreparedResult('google.email-card', valid)).toBe(true);
    expect(isValidEmailObserverPreparedResult('google.email-card', oversized)).toBe(false);
  });

  it('binds a card effect to its frozen prepared spec and only permits core email normalization', () => {
    const prepared = {
      kind: 'generated-card',
      id: '11111111-1111-4111-8111-111111111111',
      revisionId: '22222222-2222-4222-8222-222222222222',
      sourceFingerprint: 'a'.repeat(64),
      grounding: 'evidence',
      spec: {
        title: 'Reservation',
        sourceLabel: 'Email',
        actions: [
          { id: 'refresh', type: 'refresh' },
          { id: 'open', type: 'open_app' },
        ],
      },
    };
    const identity = {
      id: prepared.id,
      revisionId: prepared.revisionId,
      sourceFingerprint: prepared.sourceFingerprint,
      sourceLabel: 'Email',
      spec: { ...prepared.spec, refreshable: false, actions: [{ id: 'open', type: 'open_app' }] },
    };
    expect(emailObserverPreparedCardMatches(prepared, identity)).toBe(true);
    expect(
      emailObserverPreparedCardMatches(prepared, {
        ...identity,
        spec: { ...identity.spec, title: 'Changed' },
      }),
    ).toBe(false);
    expect(
      emailObserverPreparedCardMatches(prepared, {
        ...identity,
        spec: { ...identity.spec, _runtime: { sources: [] } },
      }),
    ).toBe(false);
  });

  it('allows a null pre-erasure observation generation for the first voice sample', () => {
    expect(
      isValidEmailObserverPreparedResult('google.owner-voice-sample', {
        register: 'email_casual',
        context: 'inbound-email',
        observedGeneration: null,
        embeddingSpaceKey: 'space',
        embedding: [0.1],
      }),
    ).toBe(true);
  });

  it('compares prepared values canonically while rejecting changed output', () => {
    const first = {
      register: 'email_casual',
      context: 'inbound-email',
      observedGeneration: 'g1',
      embeddingSpaceKey: 'space',
      embedding: [0.1, -0.1],
    };
    const reordered = {
      embedding: [0.1, -0.1],
      embeddingSpaceKey: 'space',
      observedGeneration: 'g1',
      context: 'inbound-email',
      register: 'email_casual',
    };
    expect(sameEmailObserverPreparedResult('google.owner-voice-sample', first, reordered)).toBe(
      true,
    );
    expect(
      sameEmailObserverPreparedResult('google.owner-voice-sample', first, {
        ...first,
        observedGeneration: 'g2',
      }),
    ).toBe(false);
  });
});
