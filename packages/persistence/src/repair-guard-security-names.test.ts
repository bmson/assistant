import { describe, expect, it } from 'vitest';
import { repairPathBlocked } from './repair-guard.js';

describe('repair guard protects renamed authentication surfaces', () => {
  it.each([
    'apps/agent/src/firestore-owner-authentication.ts',
    'apps/agent/src/firestore-owner-authorization.ts',
    'apps/web/lib/owner-authenticator.ts',
    'apps/web/lib/account-device-key.ts',
    'apps/web/lib/passkeys.ts',
    'apps/web/lib/owner-authentication.test.ts',
  ])('blocks security-equivalent path %s', (path) => {
    expect(repairPathBlocked(path)).toBe(true);
  });

  it.each([
    'apps/web/app/settings/account/page.tsx',
    'apps/web/app/api/mobile/v1/profile/route.ts',
    'packages/core/src/authoring.ts',
    'packages/tools/src/workspace-authoring.ts',
  ])('keeps ordinary product path %s eligible', (path) => {
    expect(repairPathBlocked(path)).toBe(false);
  });
});
