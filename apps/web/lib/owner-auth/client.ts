'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type Json = Record<string, unknown>;

export class OwnerAuthRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function ownerPost(path: string, body: Json, method = 'POST'): Promise<Json> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const value = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new OwnerAuthRequestError(String(value.error ?? response.status));
  return value;
}

/** Two-step WebAuthn registration against one of the owner registration endpoints. */
export async function registerPasskey(path: string, first: Json, label: string): Promise<Json> {
  const begin = await ownerPost(path, { action: 'options', ...first });
  const response = await startRegistration({
    optionsJSON: begin.options as Parameters<typeof startRegistration>[0]['optionsJSON'],
  });
  return ownerPost(path, {
    action: 'verify',
    challengeToken: begin.challengeToken,
    response,
    label,
  });
}

export async function signInWithPasskey(): Promise<void> {
  const begin = await ownerPost('/api/owner/login', { action: 'options' });
  const response = await startAuthentication({
    optionsJSON: begin.options as Parameters<typeof startAuthentication>[0]['optionsJSON'],
  });
  await ownerPost('/api/owner/login', {
    action: 'verify',
    challengeToken: begin.challengeToken,
    response,
  });
}

export function deviceLabel(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad/.test(agent)) return 'iPad';
  if (/Mac OS X/.test(agent)) return 'Mac';
  if (/Android/.test(agent)) return 'Android';
  if (/Windows/.test(agent)) return 'Windows';
  return 'Passkey';
}

/** Human wording for failures; WebAuthn cancellation is the common case. */
export function ownerAuthMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'NotAllowedError')
    return 'The passkey prompt was cancelled or timed out. Try again.';
  if (error instanceof Error && error.name === 'InvalidStateError')
    return 'This device already has a passkey for your assistant. Sign in with it, or add a passkey on another device.';
  if (error instanceof Error && error.name === 'NotSupportedError')
    return 'This device could not use the requested passkey. Try another device or browser.';
  if (error instanceof Error && error.name === 'SecurityError')
    return 'Passkeys could not be used at this address. Open the configured assistant URL and try again.';
  const code = error instanceof OwnerAuthRequestError ? error.code : '';
  switch (code) {
    case 'claim_invalid':
      return 'This setup link is invalid, expired, or already used. Ask the person who manages this server for a new link.';
    case 'recovery_invalid':
      return 'That recovery code is not valid. Check it and try again.';
    case 'passkey_unknown':
    case 'assertion_invalid':
      return 'That passkey is not registered for this assistant.';
    case 'last_passkey':
      return 'Add another passkey before removing the last one.';
    case 'forbidden':
      return 'This request came from a different address than the configured assistant URL.';
    default:
      return 'Something went wrong. Try again.';
  }
}
