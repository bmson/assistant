import type {
  OwnerEditorOperationRecord,
  OwnerEditorRecoveryStorageOptions,
  OwnerEditorRecoveryTransaction,
  OwnerEditorScope,
  OwnerEditorSessionView,
} from '@assistant/persistence';
import {
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import * as proof from './owner-editor-recovery-proof';
import {
  handleDormantOwnerEditorRecoveryRequest,
  type OwnerEditorRecoveryRuntimeDependencies,
} from './owner-editor-recovery-runtime';
import { issueOwnerEditorFormGrant, verifyOwnerEditorHandle } from './owner-editor-scope';

const NOW = Date.parse('2026-11-01T20:00:00Z');
const ORIGIN = 'https://assistant.example.test';
const SECRET = 'fixture-dormant-runtime-secret';
function fixture(driver: 'postgres' | 'firestore' = 'postgres') {
  const session: OwnerEditorSessionView = {
    ownerId: '10000000-0000-4000-8000-000000000001',
    formSessionScope: 'runtime_scope_0123456789',
  };
  const epoch = '20000000-0000-4000-8000-000000000002';
  const grant = issueOwnerEditorFormGrant({
    context: { ownerId: session.ownerId, epoch, privacyGeneration: null },
    session,
    command: 'correct_owner_memory',
    targetId: '30000000-0000-4000-8000-000000000003',
    secret: SECRET,
    now: NOW - 3_600_000,
  });
  const checked = verifyOwnerEditorHandle({
    token: grant.issuedOperationHandle,
    session,
    secret: SECRET,
    now: NOW,
  });
  if (checked.kind !== 'verified') throw new Error('Invalid fixture');
  const scope = checked.scope;
  const operation: OwnerEditorOperationRecord = {
    id: ownerEditorOperationId(scope),
    ownerId: session.ownerId,
    epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    operationId: scope.operationId,
    requestHash: 'a'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(scope),
    command: scope.command,
    protocolVersion: 1,
    formIssuedAt: new Date(scope.issuedAt),
    formExpiresAt: new Date(scope.expiresAt),
    claimToken: '40000000-0000-4000-8000-000000000004',
    claimExpiresAt: new Date(NOW - 1),
    status: 'preparing',
    statusVersion: 1,
    result: null,
    createdAt: new Date(scope.issuedAt),
    updatedAt: new Date(NOW - 1),
  };
  const config = {
    driver,
    origin: ORIGIN,
    secret: SECRET,
    releaseWritesPaused: false,
    restoreRehearsal: false,
    postgresSourceWritesFenced: false,
  };
  const authenticate = vi.fn(async (_request: Request) => ({
    formSessionScope: session.formSessionScope,
  }));
  const resolveOwner = vi.fn(async () => session.ownerId);
  const readFresh = vi.fn(async () => ({
    current: { ownerId: session.ownerId, epoch, privacyGeneration: null, ready: true },
    maintenance: {
      driver,
      releaseWritesPaused: false,
      restoreRehearsal: false,
      postgresSourceWritesFenced: false,
    },
    operation,
  }));
  const abandon = vi.fn(async () => null);
  let storageOptions: OwnerEditorRecoveryStorageOptions | undefined;
  let attempts = 1;
  let failCommit = false;
  const storage = vi.fn(async (_driver, options: OwnerEditorRecoveryStorageOptions) => {
    storageOptions = options;
    return {
      async withRecoveryTransaction<T>(
        s: OwnerEditorScope,
        run: (transaction: OwnerEditorRecoveryTransaction) => Promise<T>,
      ) {
        let value: T | undefined;
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (!(await options.authorize(s))) throw new Error('Authorization changed');
          value = await run({ readFresh, abandonExpiredOriginal: abandon });
          expect(proof.issueOwnerEditorRecoveryProof).toHaveBeenCalledTimes(0);
        }
        if (failCommit) throw new Error('Transaction cancelled before commit');
        return value as T;
      },
    };
  });
  let currentNow = NOW;
  const dependencies: OwnerEditorRecoveryRuntimeDependencies = {
    config: () => config,
    authenticate,
    resolveOwner,
    storage,
    now: () => currentNow,
  };
  const request = (method: 'GET' | 'POST' = 'POST') =>
    new Request(
      `${ORIGIN}/api/owner-editor/recovery/v2/${method === 'GET' ? 'receipt' : 'authorize'}`,
      {
        method,
        headers: {
          'x-owner-editor-protocol': '2',
          'x-editor-form-scope': grant.issuedOperationHandle,
          'x-editor-session-scope': session.formSessionScope,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        ...(method === 'POST'
          ? { body: JSON.stringify({ version: 2, intent: 'authorize_original_reconcile' }) }
          : {}),
      },
    );
  return {
    config,
    dependencies,
    request,
    scope,
    operation,
    authenticate,
    resolveOwner,
    storage,
    readFresh,
    abandon,
    setNow(value: number) {
      currentNow = value;
    },
    setAttempts(value: number) {
      attempts = value;
    },
    setFailCommit() {
      failCommit = true;
    },
    getOptions() {
      return storageOptions;
    },
  };
}

vi.mock('./owner-editor-recovery-proof', { spy: true });

describe('unmounted recovery runtime', () => {
  it('defaults off and never takes activation from request headers', async () => {
    const f = fixture();
    const response = await handleDormantOwnerEditorRecoveryRequest(f.request(), {}, f.dependencies);
    expect(response.status).toBe(404);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
  });
  it('lookup mode rejects POST before authentication or storage', async () => {
    const f = fixture();
    expect(
      (
        await handleDormantOwnerEditorRecoveryRequest(
          f.request(),
          { mode: 'lookup' },
          f.dependencies,
        )
      ).status,
    ).toBe(403);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
  });
  it.each(['postgres', 'firestore'] as const)(
    'mints once after all %s transaction attempts resolve',
    async (driver) => {
      const f = fixture(driver);
      vi.mocked(proof.issueOwnerEditorRecoveryProof).mockClear();
      f.setAttempts(3);
      const request = f.request();
      const response = await handleDormantOwnerEditorRecoveryRequest(
        request,
        { mode: 'authorize' },
        f.dependencies,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        intent: 'recovery_authorized',
        authorization: expect.stringMatching(/^oer2\./),
      });
      expect(proof.issueOwnerEditorRecoveryProof).toHaveBeenCalledTimes(1);
      expect(f.readFresh).toHaveBeenCalledTimes(3);
      expect(f.abandon).not.toHaveBeenCalled();
      expect(f.resolveOwner).toHaveBeenCalledTimes(1);
      for (const [actualRequest] of f.authenticate.mock.calls) expect(actualRequest).toBe(request);
      expect(
        await f.getOptions()?.authorize(f.scope, {
          ownerId: f.scope.ownerId,
          formSessionScope: 'wrong_scope_0123456789',
        }),
      ).toBe(false);
    },
  );
  it('retires an original replay window that expires while the read transaction resolves', async () => {
    const f = fixture();
    vi.mocked(proof.issueOwnerEditorRecoveryProof).mockClear();
    const originalStorage = f.dependencies.storage;
    f.dependencies.storage = async (driver, options) => {
      const storage = await originalStorage(driver, options);
      return {
        async withRecoveryTransaction(scope, run) {
          const result = await storage.withRecoveryTransaction(scope, run);
          f.setNow(f.scope.issuedAt + 24 * 60 * 60_000);
          return result;
        },
      };
    };
    const response = await handleDormantOwnerEditorRecoveryRequest(
      f.request(),
      { mode: 'authorize' },
      f.dependencies,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ authority: 'scope_retirement' });
    expect(proof.issueOwnerEditorRecoveryProof).not.toHaveBeenCalled();
  });

  it('rechecks the clock after awaited post-transaction session authentication', async () => {
    const f = fixture();
    vi.mocked(proof.issueOwnerEditorRecoveryProof).mockClear();
    const authenticate = f.dependencies.authenticate;
    let checks = 0;
    f.dependencies.authenticate = async (request) => {
      const session = await authenticate(request);
      checks += 1;
      if (checks === 3) f.setNow(f.scope.issuedAt + 24 * 60 * 60_000);
      return session;
    };
    const response = await handleDormantOwnerEditorRecoveryRequest(
      f.request(),
      { mode: 'authorize' },
      f.dependencies,
    );
    expect(checks).toBe(3);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ authority: 'scope_retirement' });
    expect(proof.issueOwnerEditorRecoveryProof).not.toHaveBeenCalled();
  });

  it('never mints or exposes a proof when storage cancellation prevents resolution', async () => {
    const f = fixture();
    vi.mocked(proof.issueOwnerEditorRecoveryProof).mockClear();
    f.setFailCommit();
    const response = await handleDormantOwnerEditorRecoveryRequest(
      f.request(),
      { mode: 'authorize' },
      f.dependencies,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(proof.issueOwnerEditorRecoveryProof).not.toHaveBeenCalled();
  });
  it.each(['releaseWritesPaused', 'restoreRehearsal', 'postgresSourceWritesFenced'] as const)(
    'preserves direct preflight %s before owner/storage resolution',
    async (flag) => {
      const f = fixture();
      f.config[flag] = true;
      const response = await handleDormantOwnerEditorRecoveryRequest(
        f.request(),
        { mode: 'authorize' },
        f.dependencies,
      );
      expect(response.status).toBe(503);
      expect(f.authenticate).not.toHaveBeenCalled();
      expect(f.resolveOwner).not.toHaveBeenCalled();
      expect(f.storage).not.toHaveBeenCalled();
    },
  );
  it('does not resolve an owner or construct storage on authentication failure', async () => {
    const f = fixture();
    f.authenticate.mockRejectedValueOnce(new Error('Unauthenticated'));
    expect(
      (
        await handleDormantOwnerEditorRecoveryRequest(
          f.request(),
          { mode: 'authorize' },
          f.dependencies,
        )
      ).status,
    ).toBe(401);
    expect(f.resolveOwner).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
  });
});
