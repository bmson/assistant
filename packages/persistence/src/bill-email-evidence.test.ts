import { describe, expect, it } from 'vitest';
import { emailBillStatus, extractBillEmailEvidence } from './bill-email-evidence.js';
import type { Records } from './records.js';

const AGENT = 'synthetic-owner';
const ISSUER = 'billing@example.test';
const NOW = new Date('2026-11-19T21:00:00Z');
const INVOICE = 'Invoice SYN-104: USD 42.15 is due on November 20, 2026.';
const RECEIPT = 'Payment received in full for invoice SYN-104: USD 42.15. Balance due: USD 0.00.';

function parse(body: string, issuer = ISSUER, authenticated = true) {
  return extractBillEmailEvidence({
    agentId: AGENT,
    issuer,
    body,
    provenance: {
      version: 1,
      mode: 'direct',
      authenticated,
      hasExternalOrUnknown: !authenticated,
      sourceLength: body.length,
      storedLength: body.length,
      prefixLength: 0,
      sourceHash: 'fixture',
      bodyHash: 'fixture',
      messageHash: 'fixture',
      spans: [{ start: 0, end: body.length, author: authenticated ? 'sender' : 'external' }],
      parts: [],
    },
  });
}

function admitted(body: string, issuer = ISSUER): Partial<Records['emailIngest']> {
  return {
    agentId: AGENT,
    fromEmail: issuer,
    contentTrust: 'known',
    providerReceivedAt: NOW,
    channelMessageId: 'gmail:receipt',
    billEvidence: parse(body, issuer),
    admittedSourceId: 'canonical',
    admittedSourceKind: 'message',
    ingestMode: 'direct',
    authenticated: true,
    hasExternalOrUnknown: false,
    pipelineStage: 'message_persisted',
    scoreStatus: 'prepared',
    messagePersisted: true,
  };
}

describe('exact bill evidence', () => {
  it.each([
    'November statement total USD 42.15',
    INVOICE.replace('42.15', '0.00'),
    INVOICE.replace('42.15', '-42.15'),
    INVOICE.replace('November 20', 'November 31'),
    RECEIPT.replace('in full', 'in part'),
    RECEIPT.replace('USD 0.00', 'USD 5.00'),
  ])('rejects insufficient or contradictory evidence %s', (body) => {
    expect(parse(body)).toBeNull();
  });

  it('requires exact issuer, invoice, and amount from a durably admitted source', () => {
    const invoice = parse(INVOICE);
    if (invoice?.kind !== 'invoice') throw new Error('Fixture invoice missing');
    expect(parse(RECEIPT, ISSUER, false)).toBeNull();
    expect(emailBillStatus(invoice, [admitted(RECEIPT, 'other@example.test')], NOW)).toEqual({
      kind: 'due',
    });
    expect(
      emailBillStatus(invoice, [admitted(RECEIPT.replace('SYN-104', 'SYN-105'))], NOW),
    ).toEqual({ kind: 'due' });
    expect(
      emailBillStatus(invoice, [{ ...admitted(RECEIPT), pipelineStage: 'score_prepared' }], NOW),
    ).toEqual({ kind: 'due' });
    expect(emailBillStatus(invoice, [admitted(RECEIPT.replace('42.15', '41.15'))], NOW)).toEqual({
      kind: 'conflicting-evidence',
    });
    expect(emailBillStatus(invoice, [admitted(RECEIPT)], NOW)).toEqual({
      kind: 'paid',
      sourceKey: 'gmail:receipt',
    });
    expect(
      emailBillStatus(
        invoice,
        [admitted(RECEIPT), { ...admitted(INVOICE), obligationDecision: 'reopen' }],
        NOW,
      ),
    ).toEqual({ kind: 'owner-decision' });
  });
});
