import { describe, expect, it } from 'vitest';
import {
  AUDIT_FIELD_CAP,
  captureField,
  captureInput,
  flattenMessages,
  redactAuditText,
} from './audit-capture.js';

describe('redactAuditText', () => {
  it('removes email addresses', () => {
    expect(redactAuditText('Write to alice.berg+q3@example.co.uk about it')).toBe(
      'Write to [email] about it',
    );
  });

  it('keeps the host of a URL but drops the path and query', () => {
    expect(redactAuditText('Read https://mail.google.com/mail/u/0/#inbox/FMfcgz')).toBe(
      'Read https://mail.google.com/[path]',
    );
  });

  it('leaves a bare host alone', () => {
    expect(redactAuditText('Fetched https://statsapi.mlb.com')).toBe(
      'Fetched https://statsapi.mlb.com',
    );
  });

  it('removes phone numbers in the shapes people write them', () => {
    for (const phone of [
      '+1 (415) 555-0132',
      '415-555-0132',
      '+47 912 34 567',
      '+1 415 555 0132',
      '415 555 0123',
    ]) {
      expect(redactAuditText(`Call ${phone} today`)).toBe('Call [phone] today');
    }
  });

  it('removes a parenthesized national number without stopping at a short prefix', () => {
    expect(redactAuditText('Call (415) 555-0123.')).toBe('Call [phone].');
  });

  it('removes a dotted phone number', () => {
    expect(redactAuditText('Call 415.555.0123.')).toBe('Call [phone].');
  });

  it('preserves a date beside a phone number', () => {
    expect(redactAuditText('Date 2026-09-07 415-555-0123.')).toBe('Date 2026-09-07 [phone].');
  });

  it('preserves a decimal amount beside a phone number', () => {
    for (const text of [
      'Total USD 10.99 415-555-0123.',
      'Total 10.99 415-555-0123.',
      'Total $ 10.99 415-555-0123.',
    ]) {
      expect(redactAuditText(text)).toBe(text.replace('415-555-0123', '[phone]'));
    }
  });

  it('redacts a written extension along with its phone number', () => {
    expect(redactAuditText('Call +1 (415) 555-0132 ext. 99 today')).toBe('Call [phone] today');
  });

  it('does not count an extension toward the minimum phone length', () => {
    expect(redactAuditText('Code 123-456 ext. 789')).toBe('Code 123-456 ext. 789');
  });

  it('removes long digit runs that identify a booking or an account', () => {
    expect(redactAuditText('Reference 4532015112830366 on the invoice')).toBe(
      'Reference [number] on the invoice',
    );
  });

  it('keeps the facts that make a record worth reviewing', () => {
    // Scores, times, dates, money and short codes are the substance of an
    // answer; redaction that ate these would defeat the point of the table.
    const text =
      'Giants 5, Cardinals 4, final in 11 innings on 2026-09-07; total $105.85 at 4:00 PM';
    expect(redactAuditText(text)).toBe(text);
  });

  it('does not mangle the digits inside an address it already removed', () => {
    expect(redactAuditText('from booking123456789@airline.example.com')).toBe('from [email]');
  });

  it('is idempotent', () => {
    const once = redactAuditText('alice@example.com called +1 415 555 0132');
    expect(redactAuditText(once)).toBe(once);
  });
});

describe('captureField', () => {
  it('passes text through verbatim in full mode', () => {
    expect(captureField('alice@example.com', 'full').text).toBe('alice@example.com');
  });

  it('scrubs in redacted mode', () => {
    expect(captureField('alice@example.com', 'redacted').text).toBe('[email]');
  });

  it('preserves undefined rather than storing an empty string', () => {
    expect(captureField(undefined, 'full')).toEqual({ text: undefined, truncated: false });
  });

  it('caps an oversized field and reports that it did', () => {
    const result = captureField('x'.repeat(AUDIT_FIELD_CAP + 10), 'full');
    expect(result.text).toHaveLength(AUDIT_FIELD_CAP);
    expect(result.truncated).toBe(true);
  });

  it('does not report truncation for a field at exactly the cap', () => {
    expect(captureField('x'.repeat(AUDIT_FIELD_CAP), 'full').truncated).toBe(false);
  });
});

describe('flattenMessages', () => {
  it('renders a plain window as role-prefixed text', () => {
    expect(
      flattenMessages([
        { role: 'user', content: 'what is on today' },
        { role: 'assistant', content: 'Two things.' },
      ]),
    ).toBe('user: what is on today\n\nassistant: Two things.');
  });

  it('keeps text parts and names non-text ones', () => {
    const flattened = flattenMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking your calendar.' },
          { type: 'tool-call', toolCallId: '1', toolName: 'calendar.list_events', input: {} },
        ],
      },
    ]);
    expect(flattened).toContain('Checking your calendar.');
    expect(flattened).toContain('[tool-call: calendar.list_events]');
  });

  it('returns undefined for an absent or empty window', () => {
    expect(flattenMessages(undefined)).toBeUndefined();
    expect(flattenMessages([])).toBeUndefined();
  });
});

describe('captureInput', () => {
  it('prefers an explicit prompt', () => {
    expect(captureInput({ prompt: 'score?', messages: [{ role: 'user', content: 'x' }] })).toBe(
      'score?',
    );
  });

  it('falls back to the message window', () => {
    expect(captureInput({ messages: [{ role: 'user', content: 'x' }] })).toBe('user: x');
  });

  it('returns undefined when a call carried neither', () => {
    expect(captureInput({})).toBeUndefined();
  });
});
