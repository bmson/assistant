import { describe, expect, it } from 'vitest';
import { communicationReceipt, makeCommunicationReceipt } from './communication-receipt.js';
import { buildRequestChecklist, reconcileRequestChecklist } from './workflow/request-checklist.js';

describe('communication receipts', () => {
  const args = { to: '+15551234567', body: 'hotel' };
  const receipt = makeCommunicationReceipt({
    channel: 'sms',
    provider: 'twilio',
    providerMessageId: 'SM1',
    args,
  });
  it('binds provider acceptance to exact recipient and sent content', () => {
    const row = {
      toolName: 'sms.send',
      status: 'succeeded',
      args,
      result: { communicationReceipt: receipt },
    };
    expect(communicationReceipt(row)?.providerMessageId).toBe('SM1');
    expect(communicationReceipt({ ...row, args: { ...args, to: '+15559876543' } })).toBeUndefined();
    expect(communicationReceipt({ ...row, args: { ...args, body: 'flight' } })).toBeUndefined();
    for (const state of ['unknown', 'rejected']) {
      expect(
        communicationReceipt({ ...row, result: { communicationReceipt: { ...receipt, state } } }),
      ).toBeUndefined();
    }
  });
  it('rejects contradictory typed and legacy pending or failed statuses', () => {
    for (const deliveryStatus of [
      'pending',
      'failed',
      'rejected',
      'unknown',
      'sent',
      null,
      false,
    ]) {
      for (const payload of [{ communicationReceipt: receipt }, { sid: 'SM1' }]) {
        expect(
          communicationReceipt({
            toolName: 'sms.send',
            status: 'succeeded',
            args,
            result: { ...payload, deliveryStatus },
          }),
        ).toBeUndefined();
      }
    }
  });
  it('bridges actual legacy provider identities and rejects missing acknowledgement', () => {
    expect(
      communicationReceipt({
        toolName: 'sms.send',
        status: 'succeeded',
        args,
        result: { sid: 'SM1' },
      })?.channel,
    ).toBe('sms');
    expect(
      communicationReceipt({
        toolName: 'sms.send',
        status: 'succeeded',
        args,
        result: { messageId: 'fictional' },
      }),
    ).toBeUndefined();
    expect(
      communicationReceipt({
        toolName: 'sms.send',
        status: 'succeeded',
        args,
        result: { sid: 'SM1', deliveryStatus: 'unknown' },
      }),
    ).toBeUndefined();
  });
  it('recognizes mixed email and SMS exactly once and preserves partial failure', () => {
    const checklist = buildRequestChecklist(
      'Send SMS hotel to +15551234567 and send email flight to alice@example.com',
    );
    if (!checklist) throw new Error('Checklist missing');
    const emailArgs = { to: ['alice@example.com'], body: 'flight' };
    const rows = [
      {
        id: 'sms',
        toolName: 'sms.send',
        status: 'succeeded',
        args,
        result: { communicationReceipt: receipt },
      },
      {
        id: 'email',
        toolName: 'gmail.send',
        status: 'succeeded',
        args: emailArgs,
        result: {
          communicationReceipt: makeCommunicationReceipt({
            channel: 'email',
            provider: 'gmail',
            providerMessageId: 'm1',
            args: emailArgs,
          }),
        },
      },
    ];
    expect(reconcileRequestChecklist(checklist, rows).items.map((i) => i.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(
      reconcileRequestChecklist(checklist, rows.slice(0, 1)).items.map((i) => i.status),
    ).toEqual(['completed', 'pending']);
  });
});
