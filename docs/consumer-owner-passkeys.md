# Owner passkeys for customer-owned installations

`OWNER_AUTH_MODE=passkey` lets the owner of a customer-owned Firestore installation sign in with WebAuthn passkeys instead of a Google OAuth client. A fresh installation needs no Google Auth Platform client, consent screen, redirect URI, or email delivery. Existing installations keep `google` (the default) until they choose to switch.

## Requirements

- `PERSISTENCE_DRIVER=firestore`; credentials live in the installation's Firestore database.
- `AUTH_SECRET` of at least 32 characters (from Secret Manager). It signs sessions and short-lived WebAuthn challenges with separate HKDF-derived keys.
- `AUTH_URL` is the exact HTTPS origin the owner uses, such as the service's stable `https://SERVICE-PROJECT_NUMBER.REGION.run.app` URL or a custom domain. It becomes the WebAuthn relying-party ID, so **changing the hostname later requires re-registering passkeys** (use the recovery flow on the new hostname). Loopback HTTP is accepted for local development.
- No auth bypass may be enabled at the same time. The web process refuses to start on any of these mistakes.

## Flows

| Flow                 | Who                        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim                | Installer, then owner      | The installer writes only the SHA-256 verifier of a 256-bit claim code (24-hour expiry) and prints `https://…/setup#claim=CODE` once. The fragment never reaches server logs; the page reads it and removes it from history. The first passkey registration consumes the claim atomically, marks the installation claimed, starts a session, and shows a 125-bit offline recovery code once. A second claim can never be issued for a claimed installation. |
| Sign in              | Owner                      | `/signin` uses a discoverable passkey with user verification required. Challenges are stateless signed tokens (5 minutes); a successful assertion records a single-use challenge marker and the authenticator counter in one transaction.                                                                                                                                                                                                                   |
| Second passkey       | Signed-in owner            | `/security` adds another passkey (another device or a hardware key). Keep at least two.                                                                                                                                                                                                                                                                                                                                                                     |
| Offline recovery     | Owner with recovery code   | `/signin` → "Lost your passkey?" adds a passkey on the current device, replaces the recovery code, and signs out every other browser.                                                                                                                                                                                                                                                                                                                       |
| Cloud-owner recovery | Google Cloud project owner | When both passkeys and the recovery code are lost, the installer's owner-claim step issues a **recovery** claim link for an already-claimed installation. It works only for someone who can write the customer's Firestore database, requires no publisher service or email, and signs out every existing session when used.                                                                                                                                |
| Revocation           | Signed-in owner            | Removing a passkey or "Sign out everywhere" increments the session generation. Other web instances notice within 10 seconds. The last active passkey cannot be removed.                                                                                                                                                                                                                                                                                     |
| iPhone and devices   | Signed-in owner            | `/security` creates a per-device key (`asd1_…`), shown once, stored only as a verifier, and individually revocable (effective within 30 seconds). Enter it in the app's **Connection → Mobile access key** field. The legacy shared `MOBILE_API_TOKEN` keeps working if configured.                                                                                                                                                                         |

## Security properties and limits

- Stored data: claim/recovery/device verifiers, passkey public keys and counters, and challenge markers. No secret, password, or email is required. Challenge markers carry an `expiresAt` field suitable for a Firestore TTL policy.
- An unclaimed installation cannot be taken over by a first visitor: registration requires the unexpired claim code, and concurrent registrations with the same claim produce exactly one owner.
- All mutating owner-auth requests must carry an `Origin` equal to `AUTH_URL`; the session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and `__Host-` prefixed on HTTPS.
- Claim codes, recovery codes, and device keys are high entropy, so the endpoints do not add a separate attempt counter. Failed attempts do not write to Firestore.
- Auth.js endpoints return 404 in passkey mode, and the root layout renders no shell data for anonymous visitors.
- Not yet provided: a QR-based pairing exchange in the iOS app (device keys are copied manually), per-session (rather than all-session) revocation, and an automated domain-change credential transition.

## Local development

```sh
PERSISTENCE_DRIVER=firestore OWNER_AUTH_MODE=passkey AUTH_URL=http://localhost:3000 \
AUTH_SECRET=$(openssl rand -hex 32) FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm --filter @assistant/web dev
```

Issue a claim against the emulator with the installer's owner-claim command, then open the printed link.
