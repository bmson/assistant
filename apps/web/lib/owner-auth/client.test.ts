import { describe, expect, it } from 'vitest';
import { OwnerAuthRequestError, ownerAuthMessage } from './client';

describe('owner passkey recovery guidance', () => {
  it('distinguishes cancellation from an already registered device', () => {
    expect(ownerAuthMessage(new DOMException('Cancelled', 'NotAllowedError'))).toContain(
      'cancelled or timed out',
    );
    expect(ownerAuthMessage(new DOMException('Registered', 'InvalidStateError'))).toContain(
      'already has a passkey',
    );
  });

  it('gives a usable next step for unsupported passkeys and the wrong address', () => {
    expect(ownerAuthMessage(new DOMException('Unsupported', 'NotSupportedError'))).toContain(
      'Try another device or browser',
    );
    expect(ownerAuthMessage(new DOMException('Wrong origin', 'SecurityError'))).toContain(
      'Open the configured assistant URL',
    );
  });

  it('keeps a mistyped recovery code distinct from a consumed setup link', () => {
    expect(ownerAuthMessage(new OwnerAuthRequestError('recovery_invalid'))).toContain(
      'Check it and try again',
    );
    expect(ownerAuthMessage(new OwnerAuthRequestError('claim_invalid'))).toContain('new link');
  });
});
