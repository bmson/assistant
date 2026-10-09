import { createHash } from 'node:crypto';

export interface CommunicationReceipt {
  version: 1;
  channel: 'email' | 'sms';
  provider: 'gmail' | 'twilio';
  providerMessageId: string;
  state: 'accepted' | 'rejected' | 'unknown';
  recipients: string[];
  contentDigest: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function recipients(value: unknown): string[] {
  return (typeof value === 'string' ? [value] : Array.isArray(value) ? value : []).filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}
function digest(args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        to: recipients(args.to),
        subject: args.subject ?? '',
        body: args.body ?? '',
      }),
    )
    .digest('hex');
}

/** Accepted means the provider acknowledged this send; it is not a read receipt. */
export function makeCommunicationReceipt(input: {
  channel: CommunicationReceipt['channel'];
  provider: CommunicationReceipt['provider'];
  providerMessageId: string;
  args: unknown;
}): CommunicationReceipt {
  if (!input.providerMessageId)
    throw new Error('Provider did not acknowledge the message identity');
  const args = object(input.args);
  return {
    version: 1,
    channel: input.channel,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    state: 'accepted',
    recipients: recipients(args.to),
    contentDigest: digest(args),
  };
}

/** One adapter bridge serves checklists and final-response evidence together. */
export function communicationReceipt(evidence: {
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
}): CommunicationReceipt | undefined {
  if (evidence.status !== 'succeeded') return undefined;
  const result = object(evidence.result);
  if (
    result.ok === false ||
    (result.deliveryStatus !== undefined && result.deliveryStatus !== 'accepted')
  )
    return undefined;
  const args = object(evidence.args);
  const channel =
    evidence.toolName === 'sms.send'
      ? 'sms'
      : evidence.toolName === 'gmail.send'
        ? 'email'
        : undefined;
  if (!channel) return undefined;
  const receipt = object(result.communicationReceipt);
  if (Object.keys(receipt).length) {
    if (
      receipt.version !== 1 ||
      receipt.channel !== channel ||
      receipt.provider !== (channel === 'sms' ? 'twilio' : 'gmail') ||
      receipt.state !== 'accepted' ||
      typeof receipt.providerMessageId !== 'string' ||
      !receipt.providerMessageId ||
      !Array.isArray(receipt.recipients) ||
      !receipt.recipients.every((r) => typeof r === 'string' && r.length > 0) ||
      typeof receipt.contentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.contentDigest)
    )
      return undefined;
    if (
      evidence.args &&
      (receipt.contentDigest !== digest(args) ||
        JSON.stringify(receipt.recipients) !== JSON.stringify(recipients(args.to)))
    )
      return undefined;
    return receipt as unknown as CommunicationReceipt;
  }
  // Historical provider-specific records remain usable without pretending an arbitrary id is a send receipt.
  const id = channel === 'sms' ? result.sid : (result.messageId ?? result.id);
  if (typeof id !== 'string' || !id) return undefined;
  return makeCommunicationReceipt({
    channel,
    provider: channel === 'sms' ? 'twilio' : 'gmail',
    providerMessageId: id,
    args: evidence.args ?? { to: result.to },
  });
}
