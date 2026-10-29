/** Test-only emulator auth. Never imported by production maintenance or application code. */
import { OAuth2Client } from 'google-auth-library';

export function ownerEditorEmulatorAuth(host: string) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Local emulator required');
  // Firestore SDK 9.3.1 uses Bearer owner for ssl=false; the pinned emulator
  // recognizes OWNER as an admin sentinel before attempting JWT parsing.
  return new OAuth2Client({
    universeDomain: 'googleapis.com',
    credentials: { access_token: 'owner', expiry_date: Number.MAX_SAFE_INTEGER },
  });
}
