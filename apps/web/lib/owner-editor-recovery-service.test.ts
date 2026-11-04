import { createHmac } from 'node:crypto';
import {
  type OwnerEditorCommand,
  type OwnerEditorOperationRecord,
  type OwnerEditorScope,
  type OwnerEditorSessionView,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerEditorRecoveryCurrentState } from './owner-editor-recovery-proof';
import {
  handleOwnerEditorRecoveryRequest,
  type OwnerEditorExpiredClaimExpectation,
  type OwnerEditorRecoveryFreshSnapshot,
  type OwnerEditorRecoveryMaintenanceState,
  type OwnerEditorRecoveryServicePorts,
  type OwnerEditorRecoveryTransaction,
} from './owner-editor-recovery-service';
import { isBasicOwnerEditorCommand } from './owner-editor-release-policy';
import {
  issueOwnerEditorFormGrant,
  ownerEditorSessionDigest,
  verifyOwnerEditorHandle,
} from './owner-editor-scope';

const NOW = Date.parse('2026-11-01T20:00:00.000Z');
const SECRET = 'fixture-recovery-service-secret';
const owner = '10000000-0000-4000-8000-000000000001';
const subject = '20000000-0000-4000-8000-000000000002';
const epoch = '30000000-0000-4000-8000-000000000003';
const PATH = '/api/owner-editor/recovery/v2';
const ORIGIN = 'https://assistant.example.test';

function fixture(
  options: {
    ready?: boolean;
    maintenance?: Partial<OwnerEditorRecoveryMaintenanceState>;
    command?: OwnerEditorCommand;
  } = {},
) {
  const session: OwnerEditorSessionView = {
    ownerId: owner,
    formSessionScope: 'service_scope_0123456789',
  };
  const command = options.command ?? 'correct_owner_memory';
  const issuedAt = NOW - 60 * 60_000;
  const scopeSeed: OwnerEditorScope = {
    ownerId: owner,
    sessionDigest: ownerEditorSessionDigest(session),
    epoch,
    privacyGeneration: 'privacy-generation-a',
    command,
    operationId: '40000000-0000-4000-8000-000000000004',
    targetId: command === 'create_person' ? null : subject,
    nonce: '60000000-0000-4000-8000-000000000006',
    issuedAt,
    expiresAt: issuedAt + 10 * 60_000,
  };
  const grant =
    command === 'create_owner_memory' || command.startsWith('remove_')
      ? { issuedOperationHandle: signFormScope(scopeSeed) }
      : isBasicOwnerEditorCommand(command)
        ? issueOwnerEditorFormGrant({
            context: { ownerId: owner, epoch, privacyGeneration: 'privacy-generation-a' },
            session,
            command,
            targetId: scopeSeed.targetId,
            secret: SECRET,
            now: issuedAt,
          })
        : { issuedOperationHandle: '' };
  const handle = verifyOwnerEditorHandle({
    token: grant.issuedOperationHandle,
    session,
    secret: SECRET,
    now: NOW,
  });
  if (handle.kind !== 'verified') throw new Error('Expected a verified form handle');
  const scope = handle.scope;
  const operation: OwnerEditorOperationRecord = {
    id: ownerEditorOperationId(scope),
    ownerId: owner,
    epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(scope.privacyGeneration),
    operationId: scope.operationId,
    requestHash: 'a'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(scope),
    command: scope.command,
    protocolVersion: 1,
    formIssuedAt: new Date(scope.issuedAt),
    formExpiresAt: new Date(scope.expiresAt),
    claimToken: '50000000-0000-4000-8000-000000000005',
    claimExpiresAt: new Date(NOW - 1),
    status: 'preparing',
    statusVersion: 7,
    result: null,
    createdAt: new Date(scope.issuedAt),
    updatedAt: new Date(NOW - 1),
  };
  const current: OwnerEditorRecoveryCurrentState = {
    ownerId: owner,
    epoch,
    privacyGeneration: scope.privacyGeneration,
    ready: options.ready ?? true,
  };
  const maintenance: OwnerEditorRecoveryMaintenanceState = {
    driver: 'postgres',
    releaseWritesPaused: false,
    restoreRehearsal: false,
    postgresSourceWritesFenced: false,
    ...options.maintenance,
  };
  let snapshot: OwnerEditorRecoveryFreshSnapshot = {
    current,
    maintenance,
    operation,
  };
  let casResult: unknown;
  let customCasResult = false;
  let testNow = NOW;
  let beforeCas: (() => void) | null = null;
  let casWrites = 0;
  let transactionCalls = 0;
  let authenticatedSession = session;
  let preflightMaintenance: OwnerEditorRecoveryMaintenanceState = maintenance;
  const readFresh = vi.fn(async (): Promise<OwnerEditorRecoveryFreshSnapshot> => snapshot);
  const abandonExpiredOriginal = vi.fn(
    async (expected: OwnerEditorExpiredClaimExpectation): Promise<unknown | null> => {
      beforeCas?.();
      const latest = snapshot;
      const operationNow = testNow;
      if (
        !latest.current.ready ||
        latest.current.ownerId !== expected.scope.ownerId ||
        latest.current.epoch !== expected.scope.epoch ||
        latest.current.privacyGeneration !== expected.scope.privacyGeneration ||
        latest.maintenance.releaseWritesPaused ||
        latest.maintenance.restoreRehearsal ||
        (latest.maintenance.driver === 'postgres' &&
          latest.maintenance.postgresSourceWritesFenced) ||
        operationNow >= expected.proofExpiresAt.getTime() ||
        operationNow >= expected.replayExpiresAt.getTime() ||
        operationNow < expected.claimExpiresAt.getTime()
      )
        return null;
      const currentOperation = latest.operation as OwnerEditorOperationRecord;
      if (
        currentOperation.id !== ownerEditorOperationId(expected.scope) ||
        currentOperation.ownerId !== expected.scope.ownerId ||
        currentOperation.epoch !== expected.scope.epoch ||
        currentOperation.privacyGenerationDigest !==
          ownerEditorPrivacyDigest(expected.scope.privacyGeneration) ||
        currentOperation.operationId !== expected.scope.operationId ||
        currentOperation.command !== expected.scope.command ||
        currentOperation.scopeDigest !== ownerEditorScopeDigest(expected.scope) ||
        currentOperation.formIssuedAt.getTime() !== expected.scope.issuedAt ||
        currentOperation.formExpiresAt.getTime() !== expected.scope.expiresAt ||
        currentOperation.status !== 'preparing' ||
        currentOperation.requestHash !== expected.requestHash ||
        currentOperation.claimToken !== expected.claimToken ||
        currentOperation.claimExpiresAt?.getTime() !== expected.claimExpiresAt.getTime() ||
        currentOperation.statusVersion !== expected.statusVersion
      )
        return null;
      if (customCasResult) return casResult;
      casWrites += 1;
      const result: OwnerEditorOperationRecord = {
        ...currentOperation,
        claimToken: null,
        claimExpiresAt: null,
        status: 'abandoned',
        statusVersion: currentOperation.statusVersion + 1,
        result: { outcome: 'not_applied', reason: 'claim_abandoned' },
        updatedAt: new Date(operationNow),
      };
      snapshot = { ...latest, operation: result };
      return result;
    },
  );
  const withRecoveryTransaction: OwnerEditorRecoveryServicePorts['withRecoveryTransaction'] =
    async <T>(
      _scope: OwnerEditorScope,
      run: (transaction: OwnerEditorRecoveryTransaction) => Promise<T>,
    ) => {
      transactionCalls += 1;
      return run({ readFresh, abandonExpiredOriginal });
    };
  const authenticate = vi.fn(async (_request: Request) => authenticatedSession);
  const readMaintenance = vi.fn(async () => preflightMaintenance);
  const ports: OwnerEditorRecoveryServicePorts = {
    authenticate,
    readMaintenance,
    origin: ORIGIN,
    secret: SECRET,
    now: () => testNow,
    withRecoveryTransaction,
  };
  const headers = () => ({
    'x-owner-editor-protocol': '2',
    'x-editor-session-scope': authenticatedSession.formSessionScope,
    'x-editor-form-scope': grant.issuedOperationHandle,
  });
  function mergedHeaders(overrides: Record<string, string | undefined> = {}) {
    const result = new Headers(headers());
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) result.delete(name);
      else result.set(name, value);
    }
    return result;
  }
  function post(
    path: 'authorize' | 'reconcile',
    body: unknown,
    headersOverride: Record<string, string | undefined> = {},
  ) {
    return new Request(`${ORIGIN}${PATH}/${path}`, {
      method: 'POST',
      headers: mergedHeaders({
        origin: ORIGIN,
        'content-type': 'application/json',
        ...headersOverride,
      }),
      body: JSON.stringify(body),
    });
  }
  function get(headersOverride: Record<string, string | undefined> = {}, urlSuffix = '') {
    return new Request(`${ORIGIN}${PATH}/receipt${urlSuffix}`, {
      method: 'GET',
      headers: mergedHeaders(headersOverride),
    });
  }
  function terminal(
    status: 'abandoned' | 'committed' = 'abandoned',
    changes: Partial<OwnerEditorOperationRecord> = {},
  ): OwnerEditorOperationRecord {
    return {
      ...operation,
      claimToken: null,
      claimExpiresAt: null,
      status,
      statusVersion: operation.statusVersion + 1,
      result:
        status === 'abandoned'
          ? { outcome: 'not_applied', reason: 'claim_abandoned' }
          : {
              outcome: 'saved',
              ids: { memoryId: '60000000-0000-4000-8000-000000000006' },
              revision: 'b'.repeat(64),
            },
      updatedAt: new Date(NOW),
      ...changes,
    };
  }
  async function authorize() {
    const response = await handleOwnerEditorRecoveryRequest(
      post('authorize', { version: 2, intent: 'authorize_original_reconcile' }),
      ports,
    );
    const value = (await response.json()) as Record<string, unknown>;
    return { response, value };
  }
  return {
    session,
    scope,
    operation,
    grant,
    current,
    maintenance,
    ports,
    readFresh,
    abandonExpiredOriginal,
    withRecoveryTransaction,
    authenticate,
    readMaintenance,
    headers,
    post,
    get,
    terminal,
    authorize,
    setSnapshot(value: typeof snapshot) {
      snapshot = value;
    },
    setCasResult(value: unknown) {
      casResult = value;
      customCasResult = true;
    },
    setNow(value: number) {
      testNow = value;
    },
    setBeforeCas(callback: (() => void) | null) {
      beforeCas = callback;
    },
    getCasWrites() {
      return casWrites;
    },
    getTransactionCalls() {
      return transactionCalls;
    },
    setAuthenticatedSession(value: OwnerEditorSessionView) {
      authenticatedSession = value;
    },
    setPreflightMaintenance(value: unknown) {
      preflightMaintenance = value as OwnerEditorRecoveryMaintenanceState;
    },
  };
}

function signFormScope(scope: OwnerEditorScope): string {
  const body = Buffer.from(JSON.stringify(scope)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`oe1.${body}`).digest('base64url');
  return `oe1.${body}.${signature}`;
}

describe('owner-editor recovery service', () => {
  it('uses the exact V2 GET namespace for read-only lookup and never accepts URL handles', async () => {
    const f = fixture();
    f.setSnapshot({ ...f, operation: f.terminal() });
    const response = await handleOwnerEditorRecoveryRequest(f.get(), f.ports);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authority: 'operation_receipt',
      command: f.scope.command,
      operationId: f.scope.operationId,
      outcome: 'not_applied',
    });
    expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();

    const urlOnly = await handleOwnerEditorRecoveryRequest(
      f.get(
        { 'x-editor-form-scope': undefined },
        `?operation=${encodeURIComponent(f.grant.issuedOperationHandle)}`,
      ),
      f.ports,
    );
    expect(urlOnly.status).toBe(400);
    expect(f.getTransactionCalls()).toBe(1);
  });

  it('keeps GET available under the PostgreSQL source fence but holds it during release or restore', async () => {
    const fenced = fixture({ maintenance: { postgresSourceWritesFenced: true } });
    fenced.setSnapshot({ ...fenced, operation: fenced.terminal() });
    const allowed = await handleOwnerEditorRecoveryRequest(fenced.get(), fenced.ports);
    expect(allowed.status).toBe(200);
    expect(fenced.abandonExpiredOriginal).not.toHaveBeenCalled();

    for (const maintenance of [{ releaseWritesPaused: true }, { restoreRehearsal: true }]) {
      const held = fixture({ maintenance });
      held.setSnapshot({ ...held, operation: held.terminal() });
      expect((await handleOwnerEditorRecoveryRequest(held.get(), held.ports)).status).toBe(503);
      expect(held.getTransactionCalls()).toBe(0);
    }
  });

  it('returns only terminal receipts when readiness is false and never issues or applies recovery', async () => {
    const terminal = fixture({ ready: false });
    terminal.setSnapshot({ ...terminal, operation: terminal.terminal() });
    expect((await handleOwnerEditorRecoveryRequest(terminal.get(), terminal.ports)).status).toBe(
      200,
    );
    const authorize = await terminal.authorize();
    expect(authorize.response.status).toBe(200);
    expect(authorize.value.authority).toBe('operation_receipt');
    expect(terminal.abandonExpiredOriginal).not.toHaveBeenCalled();

    const preparing = fixture({ ready: false });
    const result = await preparing.authorize();
    expect(result.response.status).toBe(202);
    expect(result.value).toMatchObject({ outcome: 'outcome_unknown', reason: 'preparing' });
    expect(result.value.authorization).toBeUndefined();
    expect(preparing.abandonExpiredOriginal).not.toHaveBeenCalled();
  });

  it('requires V2 protocol, authenticated current session, origin and the original handle header', async () => {
    const cases = [
      [
        'protocol missing',
        (f: ReturnType<typeof fixture>) =>
          f.post(
            'authorize',
            { version: 2, intent: 'authorize_original_reconcile' },
            { 'x-owner-editor-protocol': undefined },
          ),
        400,
      ],
      [
        'unknown protocol header',
        (f: ReturnType<typeof fixture>) =>
          f.post(
            'authorize',
            { version: 2, intent: 'authorize_original_reconcile' },
            { 'x-owner-editor-protocol': '3' },
          ),
        400,
      ],
      [
        'origin mismatch',
        (f: ReturnType<typeof fixture>) =>
          f.post(
            'authorize',
            { version: 2, intent: 'authorize_original_reconcile' },
            { origin: 'https://other.example' },
          ),
        403,
      ],
      [
        'session mismatch',
        (f: ReturnType<typeof fixture>) =>
          f.post(
            'authorize',
            { version: 2, intent: 'authorize_original_reconcile' },
            { 'x-editor-session-scope': 'rotated_scope_0123456789' },
          ),
        403,
      ],
      [
        'form header missing',
        (f: ReturnType<typeof fixture>) =>
          f.post(
            'authorize',
            { version: 2, intent: 'authorize_original_reconcile' },
            { 'x-editor-form-scope': undefined },
          ),
        403,
      ],
    ] as const;
    for (const [_name, request, status] of cases) {
      const f = fixture();
      expect((await handleOwnerEditorRecoveryRequest(request(f), f.ports)).status).toBe(status);
      expect(f.getTransactionCalls()).toBe(0);
    }
    const unavailable = fixture();
    unavailable.authenticate.mockRejectedValueOnce(new Error('auth failed'));
    expect(
      (
        await handleOwnerEditorRecoveryRequest(
          unavailable.post('authorize', { version: 2, intent: 'authorize_original_reconcile' }),
          unavailable.ports,
        )
      ).status,
    ).toBe(401);
  });

  it('requires exact endpoint intent and rejects legacy paths and query strings before storage access', async () => {
    const f = fixture();
    const wrongIntent = await handleOwnerEditorRecoveryRequest(
      f.post('authorize', { version: 2, intent: 'reconcile_original', authorization: 'oer2.x.y' }),
      f.ports,
    );
    expect(wrongIntent.status).toBe(422);
    const wrongPath = new Request(`${ORIGIN}/api/profile/knowledge/memory`, {
      method: 'POST',
      headers: { ...f.headers(), origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, intent: 'authorize_original_reconcile' }),
    });
    expect((await handleOwnerEditorRecoveryRequest(wrongPath, f.ports)).status).toBe(404);
    expect(f.getTransactionCalls()).toBe(0);
    const missingVersion = await handleOwnerEditorRecoveryRequest(
      f.post('authorize', { intent: 'authorize_original_reconcile' }),
      f.ports,
    );
    expect(missingVersion.status).toBe(422);
    expect(f.getTransactionCalls()).toBe(0);
  });

  it.each([
    'create_person',
    'update_person_identity',
    'add_family_relationship',
    'correct_owner_family_relationship',
    'correct_owner_memory',
    'create_owner_memory',
  ] as const)('recognizes the retained V2 receipt command %s', async (command) => {
    const f = fixture({ command });
    const response = await handleOwnerEditorRecoveryRequest(f.get(), f.ports);
    expect(response.status).toBe(202);
    expect(f.getTransactionCalls()).toBe(1);
    expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();
    if (command === 'create_owner_memory') {
      const grant = issueOwnerEditorFormGrant({
        context: { ownerId: owner, epoch, privacyGeneration: 'privacy-generation-a' },
        session: f.session,
        command,
        targetId: subject,
        secret: SECRET,
        now: NOW,
      });
      expect(grant.command).toBe(command);
      expect(
        verifyOwnerEditorHandle({
          token: grant.issuedOperationHandle,
          session: f.session,
          secret: SECRET,
          now: NOW,
        }),
      ).toMatchObject({ kind: 'verified', scope: { ownerId: owner, command, targetId: subject } });
    }
  });

  it.each(['remove_person', 'remove_owner_family_relationship'] as const)(
    'rejects removal command %s before opening the recovery transaction',
    async (command) => {
      const f = fixture({ command });
      const response = await handleOwnerEditorRecoveryRequest(f.get(), f.ports);
      expect(response.status).toBe(403);
      expect(f.getTransactionCalls()).toBe(0);
      expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();
    },
  );

  it('issues a fresh proof only for the current expired original claim and makes no CAS call', async () => {
    const f = fixture();
    const { response, value } = await f.authorize();
    expect(response.status).toBe(200);
    expect(value).toMatchObject({ version: 2, intent: 'recovery_authorized' });
    expect(typeof value.authorization).toBe('string');
    expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();
  });

  it('blocks every POST under release, restore, or PostgreSQL write fences', async () => {
    for (const maintenance of [
      { releaseWritesPaused: true },
      { restoreRehearsal: true },
      { postgresSourceWritesFenced: true },
    ]) {
      const f = fixture({ maintenance });
      const { response } = await f.authorize();
      expect(response.status).toBe(503);
      expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();
    }
  });

  it('applies release and restore holds before even retired scope handling', async () => {
    for (const maintenance of [
      { releaseWritesPaused: true },
      { restoreRehearsal: true },
      { postgresSourceWritesFenced: true },
    ]) {
      const f = fixture();
      f.setNow(f.scope.issuedAt + 24 * 60 * 60_000);
      f.setPreflightMaintenance({
        driver: 'postgres',
        releaseWritesPaused: false,
        restoreRehearsal: false,
        postgresSourceWritesFenced: false,
        ...maintenance,
      });
      const getResponse = await handleOwnerEditorRecoveryRequest(f.get(), f.ports);
      const postResponse = await handleOwnerEditorRecoveryRequest(
        f.post('authorize', { version: 2, intent: 'authorize_original_reconcile' }),
        f.ports,
      );
      expect(getResponse.status).toBe(maintenance.postgresSourceWritesFenced ? 409 : 503);
      expect(postResponse.status).toBe(503);
      expect(f.getTransactionCalls()).toBe(0);
    }
    const malformed = fixture();
    malformed.setPreflightMaintenance({ driver: 'unknown' });
    expect(
      (
        await handleOwnerEditorRecoveryRequest(
          malformed.post('authorize', { version: 2, intent: 'authorize_original_reconcile' }),
          malformed.ports,
        )
      ).status,
    ).toBe(503);
    expect(malformed.getTransactionCalls()).toBe(0);
  });

  it('abandons only the exact expired original claim after a valid V2 proof', async () => {
    const f = fixture();
    const { response: authorizedResponse, value } = await f.authorize();
    expect(authorizedResponse.status).toBe(200);
    const response = await handleOwnerEditorRecoveryRequest(
      f.post('reconcile', {
        version: 2,
        intent: 'reconcile_original',
        authorization: value.authorization,
      }),
      f.ports,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authority: 'operation_receipt',
      command: f.scope.command,
      operationId: f.scope.operationId,
      requestHash: f.operation.requestHash,
      outcome: 'not_applied',
      reason: 'claim_abandoned',
    });
    expect(f.abandonExpiredOriginal).toHaveBeenCalledTimes(1);
    expect(f.abandonExpiredOriginal.mock.calls[0]?.[0]).toMatchObject({
      requestHash: f.operation.requestHash,
      claimToken: f.operation.claimToken,
      claimExpiresAt: f.operation.claimExpiresAt,
      statusVersion: f.operation.statusVersion,
      proofExpiresAt: new Date(NOW + 120_000),
      replayExpiresAt: new Date(f.scope.issuedAt + 24 * 60 * 60_000),
    });
    expect(f.getCasWrites()).toBe(1);
  });

  it('rejects invalid proof without CAS, including against a terminal record', async () => {
    const f = fixture();
    const forged = await handleOwnerEditorRecoveryRequest(
      f.post('reconcile', {
        version: 2,
        intent: 'reconcile_original',
        authorization: 'oer2.invalid.signature',
      }),
      f.ports,
    );
    expect(forged.status).toBe(202);
    expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();

    f.setSnapshot({ ...f, operation: f.terminal() });
    const forgedAgainstReceipt = await handleOwnerEditorRecoveryRequest(
      f.post('reconcile', {
        version: 2,
        intent: 'reconcile_original',
        authorization: 'oer2.invalid.signature',
      }),
      f.ports,
    );
    expect(forgedAgainstReceipt.status).toBe(202);
    expect(forgedAgainstReceipt.headers.get('cache-control')).toBe('no-store');
    expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();
  });

  it('returns the same original receipt after a terminal CAS race only with a matching live proof', async () => {
    const f = fixture();
    const { value } = await f.authorize();
    f.setCasResult(f.terminal('committed'));
    const response = await handleOwnerEditorRecoveryRequest(
      f.post('reconcile', {
        version: 2,
        intent: 'reconcile_original',
        authorization: value.authorization,
      }),
      f.ports,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authority: 'operation_receipt',
      command: f.scope.command,
      operationId: f.scope.operationId,
      requestHash: f.operation.requestHash,
      outcome: 'saved',
      ids: { memoryId: '60000000-0000-4000-8000-000000000006' },
    });
  });

  it('does not adopt another request hash or interpret a failed CAS as not applied', async () => {
    const f = fixture();
    const { value } = await f.authorize();
    f.setCasResult(f.terminal('committed', { requestHash: 'b'.repeat(64) }));
    const response = await handleOwnerEditorRecoveryRequest(
      f.post('reconcile', {
        version: 2,
        intent: 'reconcile_original',
        authorization: value.authorization,
      }),
      f.ports,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ outcome: 'outcome_unknown' });

    const failed = fixture();
    const authorized = await failed.authorize();
    // Simulate the adapter's compare-and-set losing a race before it writes.
    failed.setCasResult(null);
    const noRow = await handleOwnerEditorRecoveryRequest(
      failed.post('reconcile', {
        version: 2,
        intent: 'reconcile_original',
        authorization: authorized.value.authorization,
      }),
      failed.ports,
    );
    expect(noRow.status).toBe(202);
    expect(failed.abandonExpiredOriginal).toHaveBeenCalledTimes(1);
    expect(failed.getCasWrites()).toBe(0);
  });

  it.each([
    ['lower', -1, 202, 'unresolved'],
    ['same', 0, 202, 'unresolved'],
    ['newer', 1, 200, 'operation_receipt'],
  ] as const)(
    'validates %s-version abandoned CAS results against the exact preparing version',
    async (_label, increment, status, authority) => {
      const f = fixture();
      const { value } = await f.authorize();
      f.setCasResult(
        f.terminal('abandoned', {
          statusVersion: f.operation.statusVersion + increment,
        }),
      );
      const response = await handleOwnerEditorRecoveryRequest(
        f.post('reconcile', {
          version: 2,
          intent: 'reconcile_original',
          authorization: value.authorization,
        }),
        f.ports,
      );
      expect(response.status).toBe(status);
      const result = await response.json();
      expect(result).toMatchObject({ authority });
      if (increment <= 0) {
        expect(result).toMatchObject({ outcome: 'outcome_unknown', reason: 'proof_changed' });
        expect(result).not.toHaveProperty('requestHash');
      } else {
        expect(result).toMatchObject({
          outcome: 'not_applied',
          reason: 'claim_abandoned',
          requestHash: f.operation.requestHash,
          statusVersion: f.operation.statusVersion + 1,
        });
      }
      expect(f.abandonExpiredOriginal).toHaveBeenCalledTimes(1);
      // These supplied return rows simulate adapter results, not actual writes.
      expect(f.getCasWrites()).toBe(0);
    },
  );

  it('rechecks state, gates, claim identity and proof expiry before any final CAS', async () => {
    const updates: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) =>
        f.setSnapshot({
          current: { ...f.current, ready: false },
          maintenance: f.maintenance,
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: { ...f.current, epoch: '70000000-0000-4000-8000-000000000007' },
          maintenance: f.maintenance,
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: { ...f.current, privacyGeneration: 'privacy-generation-b' },
          maintenance: f.maintenance,
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: { ...f.maintenance, restoreRehearsal: true },
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: { ...f.maintenance, postgresSourceWritesFenced: true },
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: f.maintenance,
          operation: { ...f.operation, claimToken: '70000000-0000-4000-8000-000000000007' },
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: f.maintenance,
          operation: { ...f.operation, claimExpiresAt: new Date(NOW + 1) },
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: f.maintenance,
          operation: { ...f.operation, statusVersion: f.operation.statusVersion + 1 },
        }),
      (f) => f.setNow(NOW + 120_000),
    ];
    for (const updateBeforeCas of updates) {
      const f = fixture();
      const authorized = await f.authorize();
      f.setBeforeCas(() => updateBeforeCas(f));
      const response = await handleOwnerEditorRecoveryRequest(
        f.post('reconcile', {
          version: 2,
          intent: 'reconcile_original',
          authorization: authorized.value.authorization,
        }),
        f.ports,
      );
      expect(response.status).toBe(202);
      expect(f.getCasWrites()).toBe(0);
      expect(await response.json()).toMatchObject({ outcome: 'outcome_unknown' });
    }

    const staleBeforeReconcile: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) =>
        f.setSnapshot({
          current: { ...f.current, ownerId: '70000000-0000-4000-8000-000000000007' },
          maintenance: f.maintenance,
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: { ...f.current, epoch: '70000000-0000-4000-8000-000000000007' },
          maintenance: f.maintenance,
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: { ...f.current, privacyGeneration: 'privacy-generation-b' },
          maintenance: f.maintenance,
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: { ...f.current, ready: false },
          maintenance: f.maintenance,
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: { ...f.maintenance, releaseWritesPaused: true },
          operation: f.operation,
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: f.maintenance,
          operation: { ...f.operation, claimToken: '70000000-0000-4000-8000-000000000007' },
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: f.maintenance,
          operation: { ...f.operation, claimExpiresAt: new Date(NOW + 1) },
        }),
      (f) =>
        f.setSnapshot({
          current: f.current,
          maintenance: f.maintenance,
          operation: { ...f.operation, statusVersion: f.operation.statusVersion + 1 },
        }),
    ];
    for (const stale of staleBeforeReconcile) {
      const f = fixture();
      const authorized = await f.authorize();
      stale(f);
      const response = await handleOwnerEditorRecoveryRequest(
        f.post('reconcile', {
          version: 2,
          intent: 'reconcile_original',
          authorization: authorized.value.authorization,
        }),
        f.ports,
      );
      expect([202, 409, 503]).toContain(response.status);
      expect(f.getCasWrites()).toBe(0);
    }

    const revokedSession = fixture();
    const original = await revokedSession.authorize();
    revokedSession.setAuthenticatedSession({
      ...revokedSession.session,
      formSessionScope: 'rotated_scope_0123456789',
    });
    const revoked = await handleOwnerEditorRecoveryRequest(
      revokedSession.post('reconcile', {
        version: 2,
        intent: 'reconcile_original',
        authorization: original.value.authorization,
      }),
      revokedSession.ports,
    );
    expect([403, 409]).toContain(revoked.status);
    expect(revokedSession.getTransactionCalls()).toBe(1);
    expect(revokedSession.getCasWrites()).toBe(0);
  });

  it('fails closed if current state or maintenance flags become malformed or stale', async () => {
    const cases: Array<{ change: Record<string, unknown>; expectedStatus: number }> = [
      {
        change: { current: { ownerId: 'bad', epoch, privacyGeneration: null, ready: true } },
        expectedStatus: 503,
      },
      {
        change: {
          maintenance: {
            driver: 'unknown',
            releaseWritesPaused: false,
            restoreRehearsal: false,
            postgresSourceWritesFenced: false,
          },
        },
        expectedStatus: 503,
      },
      {
        change: {
          current: {
            ownerId: '70000000-0000-4000-8000-000000000007',
            epoch,
            privacyGeneration: null,
            ready: true,
          },
        },
        expectedStatus: 202,
      },
      {
        change: {
          current: {
            ownerId: owner,
            epoch: '70000000-0000-4000-8000-000000000007',
            privacyGeneration: null,
            ready: true,
          },
        },
        expectedStatus: 409,
      },
    ];
    for (const { change, expectedStatus } of cases) {
      const f = fixture();
      f.setSnapshot({
        ...f,
        ...change,
        operation: f.operation,
      } as unknown as OwnerEditorRecoveryFreshSnapshot);
      const { response } = await f.authorize();
      expect(response.status).toBe(expectedStatus);
      expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();
    }
    const badClock = fixture();
    badClock.setNow(Number.NaN);
    expect((await handleOwnerEditorRecoveryRequest(badClock.get(), badClock.ports)).status).toBe(
      503,
    );
    expect(badClock.getTransactionCalls()).toBe(0);
  });

  it('fails closed on malformed stored receipt rows', async () => {
    const f = fixture();
    f.setSnapshot({
      current: f.current,
      maintenance: f.maintenance,
      operation: { ...f.terminal(), result: null },
    });
    const response = await handleOwnerEditorRecoveryRequest(f.get(), f.ports);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      authority: 'unresolved',
      reason: 'receipt_missing',
    });
    expect(f.abandonExpiredOriginal).not.toHaveBeenCalled();
  });
});
