import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptInventoryFailure,
  encryptInventoryFailure,
  verifyFailureRecipient,
} from './owner-editor-inventory-failure-envelope.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const source = { sourceSha: 'a'.repeat(40), runId: '123' };
const secret = 'PRIVATE_fake_provider_failure_context';
describe('private bounded inventory failure envelope', () => {
  it('retains only authenticated ciphertext publicly and decrypts the bound diagnostic privately', () => {
    const envelope = encryptInventoryFailure(
      { stderr: secret, stdout: 'do-not-include-stdout', message: 'do-not-include-message' },
      publicKey,
      source,
    );
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(JSON.stringify(envelope)).not.toContain('do-not-include');
    expect(decryptInventoryFailure(envelope, privateKey)).toEqual({
      purpose: 'assistant-owner-editor-inventory-failure-v1',
      ...source,
      stage: 'cli_composites',
      stderr: secret,
      truncated: false,
      stderrAvailable: true,
    });
    for (const field of ['sourceSha', 'runId', 'purpose', 'stage', 'tag', 'ciphertext']) {
      const tampered = {
        ...envelope,
        [field]: field === 'sourceSha' ? 'b'.repeat(40) : field === 'runId' ? '456' : 'tampered',
      };
      expect(() => decryptInventoryFailure(tampered, privateKey)).toThrow();
    }
    const wrong = generateKeyPairSync('rsa', { modulusLength: 3072 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => decryptInventoryFailure(envelope, wrong)).toThrow();
  });
  it('redacts common credential shapes before encryption and caps retained stderr', () => {
    const text =
      'Bearer very-secret-token ya29.secret-token abcdefghijk.abcdefghijkl.abcdefghijk "access_token":"very-secret-token" -----BEGIN PRIVATE KEY-----\nprivate-key-content\n-----END PRIVATE KEY-----';
    const result = decryptInventoryFailure(
      encryptInventoryFailure({ stderr: text }, publicKey, source),
      privateKey,
    );
    for (const token of [
      'very-secret-token',
      'ya29.secret-token',
      'abcdefghijk.abcdefghijkl.abcdefghijk',
      'private-key-content',
    ])
      expect(result.stderr).not.toContain(token);
    const bounded = decryptInventoryFailure(
      encryptInventoryFailure({ stderr: 'x'.repeat(20000) + secret }, publicKey, source),
      privateKey,
    );
    expect(Buffer.byteLength(bounded.stderr)).toBe(16384);
    expect(bounded.truncated).toBe(true);
    expect(bounded.stderr).not.toContain(secret);
    for (const stderr of ['ya29.a '.repeat(3000), '人'.repeat(10000)]) {
      const result = decryptInventoryFailure(
        encryptInventoryFailure({ stderr }, publicKey, source),
        privateKey,
      );
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16384);
      expect(result.truncated).toBe(true);
    }
  });
  it('never invokes exception getters or coerces non-string stderr', () => {
    let calls = 0;
    const error = Object.defineProperty({}, 'stderr', {
      get() {
        calls++;
        throw new Error(secret);
      },
    });
    const result = decryptInventoryFailure(
      encryptInventoryFailure(error, publicKey, source),
      privateKey,
    );
    expect(result.stderr).toBe('');
    expect(result.stderrAvailable).toBe(false);
    expect(calls).toBe(0);
    expect(
      decryptInventoryFailure(
        encryptInventoryFailure(
          {
            stderr: {
              toString() {
                throw new Error(secret);
              },
            },
          },
          publicKey,
          source,
        ),
        privateKey,
      ).stderr,
    ).toBe('');
  });
  it('requires paired exact-source inputs and an RSA public key before authentication', () => {
    expect(verifyFailureRecipient({})).toBeNull();
    const env = {
      GITHUB_SHA: source.sourceSha,
      GITHUB_RUN_ID: source.runId,
      OWNER_EDITOR_DIAGNOSTIC_SOURCE_SHA: source.sourceSha,
      OWNER_EDITOR_DIAGNOSTIC_RECIPIENT_PUBLIC_KEY: publicKey,
    };
    expect(verifyFailureRecipient(env)).toBe(publicKey);
    for (const patch of [
      { OWNER_EDITOR_DIAGNOSTIC_SOURCE_SHA: '' },
      { GITHUB_SHA: 'b'.repeat(40) },
      { OWNER_EDITOR_DIAGNOSTIC_RECIPIENT_PUBLIC_KEY: privateKey },
      { GITHUB_RUN_ID: 'not-a-run' },
    ])
      expect(() => verifyFailureRecipient({ ...env, ...patch })).toThrow();
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(() => encryptInventoryFailure({}, weak, source)).toThrow();
  });
});
