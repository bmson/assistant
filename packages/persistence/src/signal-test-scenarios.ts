import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { extractBillEmailEvidence } from './bill-email-evidence.js';
import type { Records } from './records.js';
import type { SignalRepository } from './signals.js';

const billTime = new Date('2026-11-19T12:00:00Z');
const paymentTime = new Date('2026-11-20T12:00:00Z');
const yesterday = new Date('2026-11-18T12:00:00Z');
const tomorrow = new Date('2026-11-21T12:00:00Z');
const issuer = 'billing@example.test';

function invoice(number: string) {
  return `Invoice ${number}: USD 42.15 is due on November 23, 2026.`;
}
function receipt(number: string, amount = '42.15') {
  return `Payment received in full for invoice ${number}: USD ${amount}. Balance due: USD 0.00.`;
}

export function signalContract(
  open: () => Promise<{
    repository: SignalRepository;
    seedOwner(agentId: string): Promise<void>;
    seedSource(row: ReturnType<typeof emailIngestFixture>): Promise<void>;
  }>,
) {
  it('persists typed evidence, dedupes concurrent replays and closes exactly one bill at the payment instant', async () => {
    const { repository, seedOwner, seedSource } = await open();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await seedOwner(agentId);
    await seedOwner(otherAgentId);

    const bill = emailIngestFixture(agentId, invoice('SYN-104'), billTime);
    const duplicate = emailIngestFixture(agentId, invoice('SYN-104'), paymentTime);
    const paid = emailIngestFixture(agentId, receipt('SYN-104'), paymentTime);
    const wrongAmount = emailIngestFixture(agentId, receipt('SYN-104', '41.15'), paymentTime);
    const otherPerson = emailIngestFixture(agentId, invoice('SYN-105'), billTime);
    const outsideRange = emailIngestFixture(agentId, invoice('SYN-106'), billTime);
    const foreign = emailIngestFixture(otherAgentId, invoice('SYN-104'), billTime);
    const unauthenticated = emailIngestFixture(agentId, invoice('SYN-107'), billTime, false);
    await Promise.all(
      [bill, duplicate, paid, wrongAmount, otherPerson, outsideRange, foreign, unauthenticated].map(
        seedSource,
      ),
    );

    const billInput = {
      agentId,
      emailIngestId: bill.id,
      subjectPersonIds: ['childA', 'owner'],
      at: billTime,
    };
    const [record, concurrent] = await Promise.all([
      repository.record(billInput),
      repository.record({ ...billInput, subjectPersonIds: ['owner', 'childA', 'owner'] }),
    ]);
    expect(record).toMatchObject({
      version: 1,
      kind: 'bill',
      amountMinor: 4215,
      currency: 'USD',
      dueDate: '2026-11-23',
      validFrom: billTime.toISOString(),
      validTo: null,
      supersededBy: null,
      sourceRefs: [{ kind: 'email', id: bill.admittedSourceId }],
    });
    expect(concurrent).toEqual(record);
    expect(await repository.record({ ...billInput, emailIngestId: duplicate.id })).toEqual(record);
    await expect(repository.record({ ...billInput, emailIngestId: foreign.id })).rejects.toThrow(
      'unavailable',
    );
    await expect(
      repository.record({ ...billInput, emailIngestId: unauthenticated.id }),
    ).rejects.toThrow('not admitted');
    await repository.record({
      ...billInput,
      emailIngestId: otherPerson.id,
      subjectPersonIds: ['spouse'],
    });
    const unrelatedBill = await repository.record({
      ...billInput,
      emailIngestId: outsideRange.id,
      at: tomorrow,
    });
    const foreignBill = await repository.record({
      ...billInput,
      agentId: otherAgentId,
      emailIngestId: foreign.id,
    });

    const query = {
      agentId,
      kind: 'bill' as const,
      personId: 'owner',
      from: billTime,
      to: tomorrow,
      asOf: billTime,
    };
    expect(await repository.list(query)).toEqual([record]);
    expect(await repository.list({ ...query, personId: 'childA' })).toEqual([record]);
    expect(await repository.list({ ...query, asOf: yesterday })).toEqual([]);
    expect(await repository.get(otherAgentId, record.id)).toBeNull();
    expect(await repository.list({ ...query, agentId: otherAgentId })).toEqual([foreignBill]);

    const paymentInput = {
      ...billInput,
      emailIngestId: paid.id,
      at: paymentTime,
      replaces: record.id,
    };
    for (const rejected of [
      { ...paymentInput, replaces: foreignBill.id },
      { ...paymentInput, replaces: unrelatedBill.id },
      { ...paymentInput, emailIngestId: wrongAmount.id },
      { ...paymentInput, subjectPersonIds: ['owner'] },
    ]) {
      await expect(repository.record(rejected)).rejects.toThrow('does not match');
    }
    expect(await repository.get(agentId, record.id)).toEqual(record);
    const paymentQuery = { ...query, kind: 'payment' as const, asOf: paymentTime };
    expect(await repository.list(paymentQuery)).toEqual([]);

    const [payment, paymentReplay] = await Promise.all([
      repository.record(paymentInput),
      repository.record(paymentInput),
    ]);
    expect(paymentReplay).toEqual(payment);
    expect(payment).toMatchObject({
      version: 1,
      kind: 'payment',
      validFrom: paymentTime.toISOString(),
      validTo: null,
      sourceRefs: [{ kind: 'email', id: paid.admittedSourceId }],
    });
    expect(await repository.list({ ...query, asOf: paymentTime })).toEqual([]);
    expect(await repository.list(paymentQuery)).toEqual([payment]);
    expect(await repository.list({ ...paymentQuery, asOf: billTime })).toEqual([]);
    const closed = { ...record, validTo: paymentTime.toISOString(), supersededBy: payment.id };
    expect(await repository.get(agentId, record.id)).toEqual(closed);
    expect(await repository.list({ ...query, asOf: new Date(paymentTime.getTime() - 1) })).toEqual([
      closed,
    ]);
    expect(await repository.record(billInput)).toEqual(closed);
    await expect(repository.record({ ...paymentInput, at: tomorrow })).rejects.toThrow(
      'Conflicting replay',
    );
    expect(await repository.get(agentId, record.id)).toEqual(closed);
  });
}

function emailIngestFixture(
  agentId: string,
  body: string,
  providerReceivedAt: Date,
  authenticated = true,
) {
  const id = randomUUID();
  return {
    id,
    agentId,
    contentTrust: 'known',
    ingestMode: 'direct',
    fromEmail: issuer,
    authenticated,
    hasExternalOrUnknown: false,
    admittedSourceKind: 'message',
    admittedSourceId: randomUUID(),
    channelMessageId: `gmail:${id}`,
    pipelineStage: 'message_persisted',
    scoreStatus: 'prepared',
    messagePersisted: true,
    providerReceivedAt,
    billEvidence: extractBillEmailEvidence({
      agentId,
      issuer,
      body,
      provenance: {
        version: 1,
        mode: 'direct',
        authenticated: true,
        hasExternalOrUnknown: false,
        sourceLength: body.length,
        storedLength: body.length,
        prefixLength: 0,
        sourceHash: 'fixture',
        bodyHash: 'fixture',
        messageHash: 'fixture',
        spans: [{ start: 0, end: body.length, author: 'sender' }],
        parts: [],
      },
    }),
  } satisfies Partial<Records['emailIngest']>;
}
