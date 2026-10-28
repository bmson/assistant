import { createHash } from 'node:crypto';
import { parsePhoneCallToOwnerNumberGrantMatch } from './phone-call-owner-number-grant.js';

/** Content-free hash of the exact canonical scope stored by the owner-number grant policy. */
export function phoneCallOwnerNumberGrantScopeFingerprint(value: unknown): string | null {
  const grant = parsePhoneCallToOwnerNumberGrantMatch(value);
  if (!grant) return null;
  const canonical = JSON.stringify([
    'phone.call.to_owner_number.v1',
    grant.schemaVersion,
    grant.grantId,
    grant.recipientE164,
    grant.maxMinutes,
    grant.expiresAt,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
