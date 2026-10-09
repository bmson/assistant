import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applicationConfirmationTokenInSource } from './application-confirmations.js';

function snapshot(
  body: string,
  spans: Array<{ start: number; end: number; author: 'sender' | 'external' | 'unknown' }>,
) {
  const bodyHash = createHash('sha256')
    .update('assistant-email-content-v1\0')
    .update(body)
    .digest('hex');
  return {
    version: 1 as const,
    mode: 'direct' as const,
    authenticated: true,
    sourceLength: body.length,
    storedLength: body.length,
    sourceHash: bodyHash,
    bodyHash,
    messageHash: bodyHash,
    prefixLength: 0,
    hasExternalOrUnknown: spans.some((span) => span.author !== 'sender'),
    spans,
    parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
  };
}

const hash = (value: string) => createHash('sha256').update(value.toUpperCase()).digest('hex');

describe('application confirmation token source binding', () => {
  it('accepts a token in a sender-authored span and rejects one only in quoted content', () => {
    const authored = 'Please confirm REQ-43129.\n';
    const quoted = '> Original reference APP-93421';
    const body = authored + quoted;
    const provenance = snapshot(body, [
      { start: 0, end: authored.length, author: 'sender' },
      { start: authored.length, end: body.length, author: 'external' },
    ]);
    expect(
      applicationConfirmationTokenInSource({
        tokenHash: hash('REQ-43129'),
        subject: 'Application confirmation',
        body,
        provenance,
      }),
    ).toBe(true);
    expect(
      applicationConfirmationTokenInSource({
        tokenHash: hash('APP-93421'),
        subject: 'Application confirmation',
        body,
        provenance,
      }),
    ).toBe(false);
  });

  it('does not use an unprovenanced subject token when the message contains external content', () => {
    const authored = 'Received, thank you.\n';
    const quoted = '> Original confirmation REQ-43129';
    const body = authored + quoted;
    expect(
      applicationConfirmationTokenInSource({
        tokenHash: hash('REQ-43129'),
        subject: 'Re: Application REQ-43129',
        body,
        provenance: snapshot(body, [
          { start: 0, end: authored.length, author: 'sender' },
          { start: authored.length, end: body.length, author: 'external' },
        ]),
      }),
    ).toBe(false);
  });
});
