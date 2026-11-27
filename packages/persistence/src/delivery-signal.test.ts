import { describe, expect, it } from 'vitest';
import { emailTextHash } from './email-provenance-text.js';
import type { EmailContentProvenanceSnapshot } from './email-sync.js';
import type { Records } from './records.js';
import { parseSignal, planDeliveryAdmission, prepareDeliverySignal } from './signals.js';

const body = [
  'Store delivery SYN-SHIPMENT was moved from 2026-12-09. The current delivery date is 2026-12-10.',
  'Carrier for delivery SYN-SHIPMENT: Synthetic Carrier.',
].join('\n');
const prefix = 'From: dispatch@example.test\nSubject: Synthetic shipping update\n\n';
const provenance: EmailContentProvenanceSnapshot = {
  version: 1,
  mode: 'direct',
  authenticated: true,
  sourceLength: body.length,
  storedLength: body.length,
  prefixLength: prefix.length,
  hasExternalOrUnknown: false,
  spans: [{ start: 0, end: body.length, author: 'sender' }],
  parts: [],
  sourceHash: emailTextHash(body),
  bodyHash: emailTextHash(body),
  messageHash: emailTextHash(prefix + body),
};
const observed: Partial<Records['emailIngest']> = {
  agentId: '00000000-0000-4000-8000-000000000001',
  fromEmail: 'dispatch@example.test',
  providerReceivedAt: new Date('2026-12-09T09:00:00Z'),
  ingestMode: 'direct',
  contentTrust: 'known',
  authenticated: true,
  emailContentProvenance: provenance,
};

function senderProvenance(body: string): EmailContentProvenanceSnapshot {
  const hash = emailTextHash(body);
  return {
    ...provenance,
    prefixLength: 0,
    storedLength: body.length,
    sourceLength: body.length,
    bodyHash: hash,
    messageHash: hash,
    sourceHash: hash,
    spans: [{ start: 0, end: body.length, author: 'sender' }],
  };
}

describe('delivery source binding', () => {
  it('uses canonical email identity for both source body representations', () => {
    const signal = prepareDeliverySignal(observed, body, 'canonical-source');
    expect(signal).toMatchObject({
      kind: 'delivery',
      version: 1,
      deliveryDate: '2026-12-10',
      previousDeliveryDate: '2026-12-09',
      signatureRequired: null,
      sourceRefs: [{ kind: 'email', id: 'canonical-source' }],
    });
    expect(prepareDeliverySignal(observed, prefix + body, 'canonical-source')).toEqual(signal);
    expect(parseSignal(signal)).toEqual(signal);
    expect(() =>
      parseSignal({ ...signal, sourceRefs: [{ kind: 'calendar', id: 'unverified' }] }),
    ).toThrow();
  });

  it('admits explicit store delivery without carrier and only replaces the matching current date', () => {
    const prepare = (body: string, id: string, at: string) => {
      const signal = prepareDeliverySignal(
        {
          ...observed,
          providerReceivedAt: new Date(at),
          emailContentProvenance: senderProvenance(body),
        },
        body,
        id,
      );
      if (!signal) throw new Error('Expected a source-bound delivery signal');
      return signal;
    };
    const original = prepare(
      'Store delivery SYN-SHIPMENT is scheduled for 2026-12-09.',
      'original',
      '2026-12-08T12:00:00Z',
    );
    const updated = prepare(body.split('\n')[0] ?? '', 'replacement', '2026-12-09T12:00:00Z');
    expect(original).toMatchObject({ carrier: null, previousDeliveryDate: null, replaces: null });
    expect(updated).toMatchObject({ carrier: null, previousDeliveryDate: original.deliveryDate });
    const change = planDeliveryAdmission(updated, [original]);
    expect(change?.next).toMatchObject({ replaces: original.id, deliveryDate: '2026-12-10' });
    expect(change?.close).toMatchObject({
      supersededBy: change?.next.id,
      validTo: updated.validFrom,
    });
    if (!change?.close) throw new Error('Expected the prior delivery to close');
    const history = [change.close, change.next];
    expect(planDeliveryAdmission(updated, history)).toBeNull();
    expect(
      planDeliveryAdmission({ ...updated, sourceRefs: [{ kind: 'email', id: 'stale' }] }, history),
    ).toBeNull();
    expect(() =>
      planDeliveryAdmission({ ...updated, shipmentIdentity: '3'.repeat(64) }, history),
    ).toThrow('Delivery signal identity mismatch');
  });

  it('rejects ambiguous sender dates and carriers for the identified order', () => {
    for (const extra of [
      'Store delivery OTHER-ORDER is scheduled for 2026-12-12.',
      'Carrier for delivery SYN-SHIPMENT: Another Carrier.',
    ]) {
      const text = `${body}\n${extra}`;
      expect(
        prepareDeliverySignal(
          {
            ...observed,
            emailContentProvenance: senderProvenance(text),
          },
          text,
          'ambiguous',
        ),
      ).toBeNull();
    }
  });

  it('rejects source drift, unknown senders, forwarded mail, and incomplete sender evidence', () => {
    expect(prepareDeliverySignal(observed, body.replace('12-10', '12-12'), 'canonical')).toBeNull();
    expect(
      prepareDeliverySignal({ ...observed, contentTrust: 'unknown' }, body, 'canonical'),
    ).toBeNull();
    expect(
      prepareDeliverySignal({ ...observed, ingestMode: 'forwarded' }, body, 'canonical'),
    ).toBeNull();
    expect(
      prepareDeliverySignal(
        {
          ...observed,
          emailContentProvenance: {
            ...provenance,
            spans: [{ start: 0, end: body.length, author: 'external' }],
            hasExternalOrUnknown: true,
          },
        },
        body,
        'canonical',
      ),
    ).toBeNull();
    expect(prepareDeliverySignal(observed, body, '')).toBeNull();
  });
});
