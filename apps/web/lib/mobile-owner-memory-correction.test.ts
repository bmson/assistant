import { randomUUID } from 'node:crypto';
import { applyOwnerEditorCommand } from '@assistant/application/owner-editor';
import { ownerEditorCanonicalApply } from '@assistant/application/owner-editor-wire';
import {
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorReceipt,
  ownerEditorScopeDigest,
  ownerEditorSnapshotRevision,
  ownerEditorUnknown,
} from '@assistant/persistence';
import type {
  OwnerEditorApply,
  OwnerEditorClaim,
  OwnerEditorOperationRecord,
  OwnerEditorOperationRepository,
  OwnerEditorReceiptProof,
  OwnerEditorReply,
  OwnerEditorScope,
} from '@assistant/persistence/owner-editor';
import type { OwnerMemoryEditorSnapshot } from '@assistant/persistence/owner-memory-correction';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMobileOwnerMemoryCorrectionHandlers,
  type MobileOwnerMemoryCorrectionBackend,
  type MobileOwnerMemoryCorrectionPorts,
} from './mobile-owner-memory-correction';
import {
  issueMobileOwnerMemoryCorrectionAuthorization,
  verifyMobileOwnerMemoryCorrectionAuthorization,
} from './mobile-owner-memory-correction-proof';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const deviceId = '44444444-4444-4444-8444-444444444444';
const secret = 'unit-test-secret-with-sufficient-entropy';
const hashA = 'a'.repeat(64);
const revisionA = 'b'.repeat(64);
const initialNow = 1_800_000_000_000;
const configuredPrincipal = { kind: 'configured_installation_bearer' } as const;

function snapshot(overrides: Partial<OwnerMemoryEditorSnapshot> = {}): OwnerMemoryEditorSnapshot {
  return {
    memoryId,
    ownerId,
    content: 'Old saved note',
    contentHash: hashA,
    revision: revisionA,
    ownerCorrection: null,
    sourceLabel: 'Conversation',
    eligible: true,
    ...overrides,
  };
}

function applyBody(operationId: string, content = 'New saved note') {
  return {
    version: 1,
    intent: 'apply',
    operationId,
    command: 'correct_owner_memory',
    memoryId,
    expectedContentHash: hashA,
    expectedMemoryRevision: revisionA,
    content,
  };
}

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(new URL(url, 'https://assistant.test'), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function terminalReply(scope: OwnerEditorScope, requestHash: string): OwnerEditorReply {
  return {
    version: 1,
    authority: 'operation_receipt',
    command: scope.command,
    operationId: scope.operationId,
    requestHash,
    statusVersion: 2,
    outcome: 'saved',
    ids: { memoryId },
    revision: 'c'.repeat(64),
  };
}

function makePorts(
  input: {
    principal?: typeof configuredPrincipal | { kind: 'owner_device_bearer'; deviceId: string };
    currentSnapshot?: OwnerMemoryEditorSnapshot;
    currentOwnerId?: string;
    now?: number;
    commitThrows?: boolean;
    operationRequestHash?: string;
  } = {},
) {
  let now = input.now ?? initialNow;
  let operation: OwnerEditorOperationRecord | null = null;
  let terminal: OwnerEditorReply | null = null;
  const prepare = vi.fn(async () => ({ ok: true as const, prepared: { prepared: true } }));
  const commit = vi.fn(async (claim: OwnerEditorClaim) => {
    if (input.commitThrows) throw new Error('simulated response loss after commit admission');
    const receipt = terminalReply(claim.scope, claim.requestHash);
    terminal = receipt;
    if (operation) {
      operation = {
        ...operation,
        status: 'committed',
        result: {
          outcome: 'saved',
          ids: { memoryId },
          revision: 'revision' in receipt ? receipt.revision : 'c'.repeat(64),
        },
        claimToken: null,
        claimExpiresAt: null,
        statusVersion: 2,
      };
    }
    return receipt;
  });
  const operations = {
    reserve: vi.fn(async (scope: OwnerEditorScope, requestHash: string, at: Date) => {
      if (operation) {
        if (operation.requestHash !== requestHash)
          return {
            kind: 'reply' as const,
            reply: {
              version: 1 as const,
              authority: 'request_rejection' as const,
              outcome: 'conflict' as const,
              originalOperationTerminal: false as const,
              command: scope.command,
              operationId: scope.operationId,
              reason: 'request_binding_mismatch',
            },
          };
        return {
          kind: 'reply' as const,
          reply: terminal ?? ownerEditorUnknown(scope, 'preparing'),
        };
      }
      const claim: OwnerEditorClaim = {
        scope,
        requestHash,
        claimToken: randomUUID(),
        claimExpiresAt: new Date(at.getTime() + 60_000),
        statusVersion: 1,
      };
      operation = {
        id: ownerEditorOperationId(scope),
        ownerId: scope.ownerId,
        epoch: scope.epoch,
        privacyGenerationDigest: ownerEditorPrivacyDigest(scope.privacyGeneration),
        operationId: scope.operationId,
        requestHash: input.operationRequestHash ?? requestHash,
        scopeDigest: ownerEditorScopeDigest(scope),
        command: scope.command,
        protocolVersion: 1,
        formIssuedAt: new Date(scope.issuedAt),
        formExpiresAt: new Date(scope.expiresAt),
        claimToken: claim.claimToken,
        claimExpiresAt: claim.claimExpiresAt,
        status: 'preparing',
        statusVersion: 1,
        result: null,
        createdAt: at,
        updatedAt: at,
      };
      return { kind: 'claimed' as const, claim };
    }),
    lookup: vi.fn(async (scope: OwnerEditorScope, at: Date) => {
      if (!operation)
        return { reply: ownerEditorUnknown(scope, 'receipt_missing'), operation: null };
      if (
        operation.status === 'preparing' &&
        operation.claimExpiresAt &&
        operation.claimExpiresAt <= at
      ) {
        // Keep the status unresolved until reconcile proves the original claim expired.
        return { reply: ownerEditorUnknown(scope, 'preparing'), operation };
      }
      return {
        reply:
          operation.status === 'preparing'
            ? ownerEditorUnknown(scope, 'preparing')
            : ownerEditorReceipt(operation),
        operation,
      };
    }),
    reconcile: vi.fn(async (proof: OwnerEditorReceiptProof, at: Date) => {
      if (!operation || proof.expiresAt <= at.getTime())
        return ownerEditorUnknown(proof.scope, 'proof_changed');
      if (
        proof.requestHash !== operation.requestHash ||
        proof.statusVersion !== operation.statusVersion ||
        proof.claimIdentityDigest !==
          ownerEditorSnapshotRevision({
            token: operation.claimToken,
            expiresAt: operation.claimExpiresAt?.toISOString() ?? null,
          })
      )
        return ownerEditorUnknown(proof.scope, 'proof_changed');
      if (!operation.claimExpiresAt || operation.claimExpiresAt > at)
        return ownerEditorUnknown(proof.scope, 'preparing');
      operation = {
        ...operation,
        status: 'abandoned',
        result: { outcome: 'not_applied', reason: 'claim_abandoned' },
        claimToken: null,
        claimExpiresAt: null,
        statusVersion: operation.statusVersion + 1,
      };
      return ownerEditorReceipt(operation);
    }),
    failPreparation: vi.fn(async (_claim: OwnerEditorClaim) =>
      ownerEditorUnknown(_claim.scope, 'preparing'),
    ),
  } as unknown as OwnerEditorOperationRepository & {
    reserve: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
  };

  const backend: MobileOwnerMemoryCorrectionBackend = {
    operations,
    apply: (request, scope) =>
      applyOwnerEditorCommand({
        request,
        scope,
        operations,
        domain: { prepare, commit },
        now: () => new Date(now),
      }),
  };
  const withBackend = vi.fn(
    async <T>(
      _scope: OwnerEditorScope,
      run: (backend: MobileOwnerMemoryCorrectionBackend) => Promise<T>,
    ): Promise<T> => run(backend),
  );
  const ports: MobileOwnerMemoryCorrectionPorts = {
    authenticate: vi.fn(async () => input.principal ?? configuredPrincipal),
    resolveOwner: vi.fn(async () => ({
      ok: true as const,
      ownerId: input.currentOwnerId ?? ownerId,
    })),
    readAuthorizationState: vi.fn(async () => ({
      snapshot: input.currentSnapshot ?? snapshot(),
      context: { ownerId, epoch, privacyGeneration: null },
    })),
    secret: () => secret,
    now: () => now,
    canReconcile: () => true,
    withBackend: withBackend as unknown as MobileOwnerMemoryCorrectionPorts['withBackend'],
  };
  const handlers = createMobileOwnerMemoryCorrectionHandlers(ports);
  return {
    handlers,
    ports,
    operations,
    prepare,
    commit,
    withBackend,
    setNow(value: number) {
      now = value;
    },
    getOperation() {
      return operation;
    },
    getClaimIdentity() {
      return operation?.claimToken && operation.claimExpiresAt
        ? ownerEditorSnapshotRevision({
            token: operation.claimToken,
            expiresAt: operation.claimExpiresAt.toISOString(),
          })
        : null;
    },
  };
}

async function authorize(
  f: ReturnType<typeof makePorts>,
  body: Record<string, unknown> = {
    version: 1,
    intent: 'authorize',
    expectedContentHash: hashA,
    expectedMemoryRevision: revisionA,
    content: '  New saved note  ',
  },
) {
  const response = await f.handlers.authorize(
    jsonRequest(`/api/mobile/v1/memory/${memoryId}/correction/authorize`, 'POST', body),
    memoryId,
  );
  return { response, value: (await response.json()) as Record<string, unknown> };
}

function applyRequest(authorization: string, operationId: string, content = 'New saved note') {
  return jsonRequest(
    `/api/mobile/v1/memory/${memoryId}/correction/${operationId}/apply`,
    'POST',
    applyBody(operationId, content),
    { 'x-owner-memory-correction-authorization': authorization },
  );
}

function statusRequest(authorization: string, operationId: string) {
  return new Request(
    `https://assistant.test/api/mobile/v1/memory/${memoryId}/correction/${operationId}/status`,
    { headers: { 'x-owner-memory-correction-authorization': authorization } },
  );
}

describe('native owner-memory correction protocol', () => {
  afterEach(() => vi.restoreAllMocks());

  it('authorizes the exact eligible snapshot and draft without reserving an operation or invoking a writer', async () => {
    const f = makePorts();
    const { response, value } = await authorize(f);

    expect(response.status).toBe(200);
    expect(value).toMatchObject({
      version: 1,
      intent: 'authorized',
      command: 'correct_owner_memory',
      memoryId,
    });
    expect(value.operationId).toEqual(expect.any(String));
    expect(value.authorization).toEqual(expect.stringMatching(/^omc1\./));
    expect(value.expiresAt).toBe(new Date(initialNow + 600_000).toISOString());
    expect(value).not.toHaveProperty('content');
    expect(f.withBackend).not.toHaveBeenCalled();
  });

  it('rejects stale and ineligible snapshots and strict-body extras without issuing a handle', async () => {
    const stale = makePorts({ currentSnapshot: snapshot({ revision: 'd'.repeat(64) }) });
    expect((await authorize(stale)).response.status).toBe(409);
    expect(stale.withBackend).not.toHaveBeenCalled();

    const ineligible = makePorts({
      currentSnapshot: snapshot({ eligible: false, readOnlyReason: 'shared_source' }),
    });
    expect((await authorize(ineligible)).response.status).toBe(409);

    const extra = makePorts();
    const response = await authorize(extra, {
      version: 1,
      intent: 'authorize',
      expectedContentHash: hashA,
      expectedMemoryRevision: revisionA,
      content: 'New saved note',
      ownerId,
    });
    expect(response.response.status).toBe(422);
    expect(response.value).not.toHaveProperty('authorization');
  });

  it('binds apply to the normalized canonical body and does not prepare twice on exact replay', async () => {
    const f = makePorts();
    const issued = await authorize(f);
    const token = String(issued.value.authorization);
    const operationId = String(issued.value.operationId);

    const first = await f.handlers.apply(applyRequest(token, operationId), memoryId, operationId);
    const firstReply = await first.json();
    expect(first.status).toBe(200);
    expect(firstReply).toMatchObject({ outcome: 'saved', authority: 'operation_receipt' });
    expect(f.prepare).toHaveBeenCalledTimes(1);

    const replay = await f.handlers.apply(applyRequest(token, operationId), memoryId, operationId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: 'saved', authority: 'operation_receipt' });
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed body without backend lookup, reservation, or preparation', async () => {
    const f = makePorts();
    const issued = await authorize(f);
    const response = await f.handlers.apply(
      applyRequest(
        String(issued.value.authorization),
        String(issued.value.operationId),
        'Changed draft',
      ),
      memoryId,
      String(issued.value.operationId),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      authority: 'request_rejection',
      originalOperationTerminal: false,
      reason: 'request_binding_mismatch',
    });
    expect(f.withBackend).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('allows expired apply only to return an existing same-hash operation and never reserve new work', async () => {
    const f = makePorts();
    const issued = await authorize(f);
    const token = String(issued.value.authorization);
    const operationId = String(issued.value.operationId);
    await f.handlers.apply(applyRequest(token, operationId), memoryId, operationId);
    const reserveCount = f.operations.reserve.mock.calls.length;
    f.setNow(initialNow + 600_001);

    const replay = await f.handlers.apply(applyRequest(token, operationId), memoryId, operationId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ authority: 'operation_receipt', outcome: 'saved' });
    expect(f.operations.reserve).toHaveBeenCalledTimes(reserveCount);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it('keeps expired apply unknown when the operation lookup fails', async () => {
    const f = makePorts();
    const issued = await authorize(f);
    const token = String(issued.value.authorization);
    const operationId = String(issued.value.operationId);
    f.setNow(initialNow + 600_001);
    f.operations.lookup.mockRejectedValue(new Error('simulated operation store outage'));

    const response = await f.handlers.apply(
      applyRequest(token, operationId),
      memoryId,
      operationId,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ authority: 'unresolved' });
    expect(f.operations.lookup).toHaveBeenCalledTimes(1);
    expect(f.operations.reserve).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('keeps apply response loss pending, then reconciles only the expired original claim with fresh bounded proof', async () => {
    const f = makePorts({ commitThrows: true });
    const issued = await authorize(f);
    const token = String(issued.value.authorization);
    const operationId = String(issued.value.operationId);
    const apply = await f.handlers.apply(applyRequest(token, operationId), memoryId, operationId);
    expect(apply.status).toBe(202);

    f.setNow(initialNow + 10_000);
    const liveStatus = await f.handlers.status(
      statusRequest(token, operationId),
      memoryId,
      operationId,
    );
    expect(liveStatus.status).toBe(202);
    expect(f.operations.reconcile).not.toHaveBeenCalled();

    f.setNow(initialNow + 61_000);
    const claimIdentity = f.getClaimIdentity();
    const resolved = await f.handlers.status(
      statusRequest(token, operationId),
      memoryId,
      operationId,
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      outcome: 'not_applied',
      reason: 'claim_abandoned',
    });
    const proof = f.operations.reconcile.mock.calls[0]?.[0] as OwnerEditorReceiptProof;
    expect(proof).toMatchObject({
      requestHash: f.getOperation()?.requestHash,
      statusVersion: 1,
      issuedAt: initialNow + 61_000,
      expiresAt: initialNow + 61_000 + 120_000,
    });
    expect(proof.claimIdentityDigest).toBe(claimIdentity);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it('caps reconciliation proof at the signed replay deadline', async () => {
    const f = makePorts({ commitThrows: true });
    const issued = await authorize(f);
    const token = String(issued.value.authorization);
    const operationId = String(issued.value.operationId);
    await f.handlers.apply(applyRequest(token, operationId), memoryId, operationId);

    const replayDeadline = initialNow + 24 * 60 * 60_000;
    f.setNow(replayDeadline - 30_000);
    const response = await f.handlers.status(
      statusRequest(token, operationId),
      memoryId,
      operationId,
    );
    expect(response.status).toBe(200);
    const proof = f.operations.reconcile.mock.calls[0]?.[0] as OwnerEditorReceiptProof;
    expect(proof.issuedAt).toBe(replayDeadline - 30_000);
    expect(proof.expiresAt).toBe(replayDeadline);
  });

  it('rejects a tampered authorization before opening the operation backend', async () => {
    const f = makePorts();
    const issued = await authorize(f);
    const token = String(issued.value.authorization);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const operationId = String(issued.value.operationId);

    const response = await f.handlers.status(
      statusRequest(tampered, operationId),
      memoryId,
      operationId,
    );
    expect(response.status).toBe(403);
    expect(f.withBackend).not.toHaveBeenCalled();
  });

  it('does not disclose a fetched receipt when its stored request hash differs from the signed handle', async () => {
    const f = makePorts({ operationRequestHash: 'e'.repeat(64) });
    const issued = await authorize(f);
    const token = String(issued.value.authorization);
    const operationId = String(issued.value.operationId);
    await f.handlers.apply(applyRequest(token, operationId), memoryId, operationId);

    const status = await f.handlers.status(
      statusRequest(token, operationId),
      memoryId,
      operationId,
    );
    const body = await status.json();
    expect(status.status).toBe(409);
    expect(body).toMatchObject({
      authority: 'request_rejection',
      originalOperationTerminal: false,
      reason: 'request_binding_mismatch',
    });
    expect(body).not.toHaveProperty('ids');
    expect(body).not.toHaveProperty('requestHash');
    expect(f.operations.reconcile).not.toHaveBeenCalled();
  });

  it('requires the current exact principal, while configured bearer rotation does not invent a credential generation', async () => {
    const f = makePorts({ principal: configuredPrincipal });
    const issued = await authorize(f);
    const operationId = String(issued.value.operationId);
    const token = String(issued.value.authorization);
    const secondCurrentConfiguredBearer = await f.handlers.status(
      statusRequest(token, operationId),
      memoryId,
      operationId,
    );
    expect(secondCurrentConfiguredBearer.status).toBe(202);

    const device = issueMobileOwnerMemoryCorrectionAuthorization({
      principal: { kind: 'owner_device_bearer', deviceId },
      ownerId,
      epoch,
      privacyGeneration: null,
      memoryId,
      operationId: randomUUID(),
      expectedContentHash: hashA,
      expectedMemoryRevision: revisionA,
      requestHash: 'f'.repeat(64),
      secret,
      now: initialNow,
    });
    const checked = verifyMobileOwnerMemoryCorrectionAuthorization({
      authorization: device.authorization,
      secret,
      now: initialNow + 1,
      principal: { kind: 'owner_device_bearer', deviceId: randomUUID() },
      ownerId,
      memoryId,
      operationId: device.operationId,
    });
    expect(checked.kind).toBe('principal_mismatch');
  });

  it('rejects invalid bearer without Auth.js cookie fallback', async () => {
    const f = makePorts();
    vi.mocked(f.ports.authenticate).mockResolvedValue(null);
    const response = await f.handlers.authorize(
      jsonRequest(
        `/api/mobile/v1/memory/${memoryId}/correction/authorize`,
        'POST',
        {
          version: 1,
          intent: 'authorize',
          expectedContentHash: hashA,
          expectedMemoryRevision: revisionA,
          content: 'New saved note',
        },
        { cookie: 'authjs.session-token=not-authority' },
      ),
      memoryId,
    );
    expect(response.status).toBe(401);
    expect(f.ports.readAuthorizationState).not.toHaveBeenCalled();
  });

  it('matches the existing owner-editor canonical request hash', () => {
    const value = applyBody('55555555-5555-4555-8555-555555555555') as unknown as OwnerEditorApply;
    const canonical = ownerEditorCanonicalApply(value);
    expect(canonical).toContain('New saved note');
    expect(canonical).toContain('expectedMemoryRevision');
  });
});
