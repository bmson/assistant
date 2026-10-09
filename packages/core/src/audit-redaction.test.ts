import { describe, expect, it } from 'vitest';
import { scrubAuditCredentials } from './audit-redaction.js';
import { captureField, redactAuditText } from './model-router/audit-capture.js';

describe('audit credential and URL minimization', () => {
  it.each([
    'https://example.test?access_token=SECRET',
    'https://name:SECRET@example.test?x=1',
    'https://example.test#code=SECRET',
    'https://example.test?%61pi_key=SECRET',
    'https://example.test?X-Amz-Signature=SECRET',
  ])('removes sensitive URL data in both capture modes: %s', (url) => {
    for (const mode of ['full', 'redacted'] as const)
      expect(captureField(`Read ${url}`, mode).text).not.toContain('SECRET');
  });
  it('minimizes paths, query and fragment without confusing IPv6 host boundaries', () => {
    expect(redactAuditText('https://[2606:4700::1111]/private?name=Alice#session')).toBe(
      'https://[2606:4700::1111]/[path]',
    );
    expect(redactAuditText('https://example.test?account=Alice')).toBe('https://example.test');
  });
  it('scrubs nested secret fields in JSON text and structured records', () => {
    const value = {
      context: {
        client_secret: 'SECRET',
        privateKey: 'SECRET',
        token: 'SECRET',
        email: 'alice@example.test',
      },
      count: 5,
    };
    expect(JSON.stringify(scrubAuditCredentials(value))).not.toContain('SECRET');
    expect(captureField(JSON.stringify(value), 'full').text).not.toContain('SECRET');
    expect(captureField(JSON.stringify(value), 'full').text).toContain('alice@example.test');
    expect(captureField(JSON.stringify(value), 'redacted').text).not.toContain(
      'alice@example.test',
    );
  });
  it('scrubs nested redirect URLs without erasing useful full-mode fields', () => {
    const url =
      'https://example.test?date=2026-10-07&redirect=' +
      encodeURIComponent('https://other.test?token=SECRET');
    const clean = String(scrubAuditCredentials(url));
    expect(clean).not.toContain('SECRET');
    expect(clean).toContain('date=2026-10-07');
  });
  it('is idempotent for minimized URL markers', () => {
    const once = redactAuditText('Read https://example.test/path?a=SECRET');
    expect(redactAuditText(once)).toBe(once);
  });
});
