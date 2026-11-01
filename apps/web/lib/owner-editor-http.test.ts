import { createHmac } from 'node:crypto';
import {
  type OwnerEditorApply,
  type OwnerEditorCommand,
  type OwnerEditorOperationRecord,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorRetired,
  ownerEditorScopeDigest,
  ownerEditorUnknown,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOwnerEditorPendingMarker,
  decodeOwnerEditorReply,
  readOwnerEditorPendingMarker,
  writeOwnerEditorPendingMarker,
} from './owner-editor-client';
import {
  createOwnerEditorHttpHandlers,
  type OwnerEditorHttpBackend,
  type OwnerEditorHttpPorts,
} from './owner-editor-http';
import {
  issueOwnerEditorFormGrant,
  verifyOwnerEditorHandle,
  verifyOwnerEditorReceiptProof,
} from './owner-editor-scope';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const origin = 'https://editor.example.test';
const secret = 'offline-http-fixture-secret-no-live-configuration';
const owner = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const third = '55555555-5555-4555-8555-555555555555';
const epoch = '44444444-4444-4444-8444-444444444444';
const hash = 'a'.repeat(64);
const session = { ownerId: owner, formSessionScope: 'offline_http_form_session' };
const paths = {
  people: '/api/people/editor',
  family: '/api/profile/knowledge/family',
  memory: '/api/profile/knowledge/memory',
} as const;
function fixture(command: OwnerEditorCommand = 'create_person') {
  let clock = NOW;
  const path =
    command === 'create_person' ||
    command === 'update_person_identity' ||
    command === 'remove_person'
      ? paths.people
      : command === 'correct_owner_memory'
        ? paths.memory
        : paths.family;
  const grantCommand: OwnerEditorCommand =
    command === 'remove_person'
      ? 'update_person_identity'
      : command === 'remove_owner_family_relationship'
        ? 'correct_owner_family_relationship'
        : command;
  const issuedGrant = issueOwnerEditorFormGrant({
    context: { ownerId: owner, epoch, privacyGeneration: 'fixture-generation' },
    session,
    command: grantCommand,
    targetId: grantCommand === 'create_person' ? null : target,
    secret,
    now: NOW,
  });
  let grant = issuedGrant;
  if (grantCommand !== command) {
    const parts = issuedGrant.issuedOperationHandle.split('.');
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload.command = command;
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(`oe1.${data}`).digest('base64url');
    grant = {
      ...issuedGrant,
      command,
      issuedOperationHandle: `oe1.${data}.${signature}`,
    };
  }
  const checked = verifyOwnerEditorHandle({
    token: grant.issuedOperationHandle,
    session,
    secret,
    now: NOW,
  });
  if (checked.kind !== 'verified') throw Error('Actual signed fixture did not verify');
  const scope = checked.scope;
  const saved = {
    version: 1 as const,
    authority: 'operation_receipt' as const,
    outcome: 'saved' as const,
    command,
    operationId: scope.operationId,
    requestHash: hash,
    statusVersion: 2,
    ids:
      command === 'create_person' ||
      command === 'update_person_identity' ||
      command === 'remove_person'
        ? { contactId: target }
        : command === 'correct_owner_memory'
          ? { memoryId: target }
          : { relationId: target, memoryId: other, assertionId: third },
    revision: 'b'.repeat(64),
  };
  const lookup = vi
    .fn<OwnerEditorHttpBackend['operations']['lookup']>()
    .mockResolvedValue({ reply: ownerEditorUnknown(scope, 'receipt_missing'), operation: null });
  const reconcile = vi
    .fn<OwnerEditorHttpBackend['operations']['reconcile']>()
    .mockResolvedValue(saved);
  const reserve = vi.fn<OwnerEditorHttpBackend['operations']['reserve']>();
  const failPreparation = vi.fn<OwnerEditorHttpBackend['operations']['failPreparation']>();
  const apply = vi.fn<OwnerEditorHttpBackend['apply']>().mockResolvedValue(saved);
  const backend: OwnerEditorHttpBackend = {
    operations: {
      kind: 'owner-editor-operation-repository',
      lookup,
      reconcile,
      reserve,
      failPreparation,
    },
    apply,
  };
  const authenticate = vi
    .fn<OwnerEditorHttpPorts['authenticate']>()
    .mockResolvedValue({ formSessionScope: session.formSessionScope });
  const resolveOwnerId = vi.fn<OwnerEditorHttpPorts['resolveOwnerId']>().mockResolvedValue(owner);
  const withBackend = vi
    .fn<OwnerEditorHttpPorts['withBackend']>()
    .mockImplementation(async (_scope, run) => run(backend));
  const ports = { authenticate, resolveOwnerId, withBackend, origin, secret, now: () => clock };
  const handlers = () => createOwnerEditorHttpHandlers(path, ports);
  const fields = {
    subjectContactId: target,
    objectContactId: other,
    expectedSubjectRevision: hash,
    expectedObjectRevision: hash,
    predicate: 'parent_of',
    timing: 'unspecified' as const,
    validity: { validFrom: null, validUntil: null },
    note: '',
    expectedCanonicalState: { kind: 'absent' as const },
  };
  const envelope = {
    version: 1 as const,
    intent: 'apply' as const,
    command,
    operationId: scope.operationId,
  };
  const body: OwnerEditorApply =
    command === 'create_person'
      ? { ...envelope, command, name: 'Sam', aliases: [] }
      : command === 'update_person_identity'
        ? {
            ...envelope,
            command,
            name: 'Sam',
            aliases: [],
            contactId: target,
            expectedContactRevision: hash,
          }
        : command === 'remove_person'
          ? {
              ...envelope,
              command,
              contactId: target,
              expectedContactRevision: hash,
              expectedImpactRevision: hash,
            }
          : command === 'remove_owner_family_relationship'
            ? { ...envelope, command, targetRelationId: target, expectedTargetRevision: hash }
            : command === 'correct_owner_memory'
              ? {
                  ...envelope,
                  command,
                  memoryId: target,
                  expectedContentHash: hash,
                  expectedMemoryRevision: 'd'.repeat(64),
                  content: 'A corrected saved note',
                }
              : command === 'add_family_relationship'
                ? { ...envelope, command, ...fields }
                : {
                    ...envelope,
                    command,
                    targetRelationId: target,
                    expectedTargetRevision: hash,
                    replacement: fields,
                  };
  function request(
    method: string,
    options: {
      body?: unknown;
      raw?: string | ReadableStream<Uint8Array>;
      headers?: Record<string, string | null>;
      query?: string;
      pathname?: string;
    } = {},
  ) {
    const headers = new Headers({
      origin,
      'content-type': 'application/json',
      'x-editor-session-scope': session.formSessionScope,
      'x-editor-form-scope': grant.issuedOperationHandle,
    });
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value === null) headers.delete(key);
      else headers.set(key, value);
    }
    const query =
      options.query ??
      (method === 'GET' ? `?operation=${encodeURIComponent(grant.issuedOperationHandle)}` : '');
    const payload = options.raw ?? JSON.stringify(options.body ?? body);
    return new Request(origin + (options.pathname ?? path) + query, {
      method,
      headers,
      ...(!['GET', 'HEAD'].includes(method)
        ? { body: payload, ...(payload instanceof ReadableStream ? { duplex: 'half' } : {}) }
        : {}),
    } as RequestInit);
  }
  const record = (): OwnerEditorOperationRecord => ({
    id: ownerEditorOperationId(scope),
    ownerId: owner,
    epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(scope.privacyGeneration),
    operationId: scope.operationId,
    scopeDigest: ownerEditorScopeDigest(scope),
    requestHash: hash,
    command,
    protocolVersion: 1,
    formIssuedAt: new Date(scope.issuedAt),
    formExpiresAt: new Date(scope.expiresAt),
    claimToken: third,
    claimExpiresAt: new Date(NOW + 60_000),
    status: 'preparing',
    statusVersion: 1,
    result: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });
  return {
    path,
    scope,
    body,
    grant,
    saved,
    fields,
    ports,
    handlers,
    request,
    record,
    lookup,
    reconcile,
    reserve,
    failPreparation,
    apply,
    backend,
    setClock: (value: number) => {
      clock = value;
    },
  };
}
const assertNoDomain = (f: ReturnType<typeof fixture>) => {
  expect(f.ports.withBackend).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.lookup).not.toHaveBeenCalled();
  expect(f.reconcile).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
};
async function rejection(response: Response, code: number) {
  expect(response.status).toBe(code);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    version: 1,
    authority: 'request_rejection',
    originalOperationTerminal: false,
  });
}
afterEach(() => vi.useRealTimers());

describe('actual two HTTP factories, actual crypto/parser/body guards, offline backend ports', () => {
  it.each([
    'create_person',
    'update_person_identity',
    'add_family_relationship',
    'correct_owner_family_relationship',
    'correct_owner_memory',
  ] as const)(
    'dispatches exactly %s with verified owner scope on its declared route',
    async (command) => {
      const f = fixture(command);
      const response = await f.handlers().POST(f.request('POST'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(f.saved);
      expect(f.ports.authenticate).toHaveBeenCalledTimes(1);
      expect(f.ports.resolveOwnerId).toHaveBeenCalledTimes(1);
      expect(f.ports.withBackend).toHaveBeenCalledWith(f.scope, expect.any(Function));
      expect(f.apply).toHaveBeenCalledExactlyOnceWith(f.body, f.scope);
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.lookup).not.toHaveBeenCalled();
    },
  );
  it.each(['remove_person', 'remove_owner_family_relationship'] as const)(
    'rejects a correctly signed %s scope before GET or POST reaches the backend',
    async (command) => {
      const f = fixture(command);
      await rejection(await f.handlers().POST(f.request('POST')), 403);
      assertNoDomain(f);

      await rejection(await f.handlers().GET(f.request('GET')), 403);
      assertNoDomain(f);
    },
  );
  it('strict request parsing rejects a removal command under an otherwise allowed handle before backend access', async () => {
    const f = fixture('update_person_identity');
    const response = await f.handlers().POST(
      f.request('POST', {
        body: {
          version: 1,
          intent: 'apply',
          command: 'remove_person',
          operationId: f.scope.operationId,
          contactId: target,
          expectedContactRevision: hash,
          expectedImpactRevision: hash,
        },
      }),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      authority: 'request_rejection',
      reason: 'invalid_command',
    });
    assertNoDomain(f);
  });
  it.each([null, 'https://hostile.example.test', 'null', `${origin}:444`])(
    'rejects missing/foreign POST Origin %s before owner resolution',
    async (value) => {
      const f = fixture();
      await rejection(
        await f.handlers().POST(f.request('POST', { headers: { origin: value } })),
        403,
      );
      expect(f.ports.resolveOwnerId).not.toHaveBeenCalled();
      assertNoDomain(f);
    },
  );
  it('cookie owner is required even with a real signed form', async () => {
    const f = fixture();
    f.ports.authenticate.mockResolvedValue(null);
    await rejection(await f.handlers().POST(f.request('POST')), 401);
    expect(f.ports.resolveOwnerId).not.toHaveBeenCalled();
    assertNoDomain(f);
  });
  it('authentication throw fails closed without body/backend access', async () => {
    const f = fixture();
    f.ports.authenticate.mockRejectedValue(Error('auth unavailable'));
    await rejection(await f.handlers().GET(f.request('GET')), 401);
    expect(f.ports.resolveOwnerId).not.toHaveBeenCalled();
    assertNoDomain(f);
  });
  it.each([null, 'wrong_valid_session_scope'])(
    'session header %s fails before configured owner resolver',
    async (value) => {
      const f = fixture();
      await rejection(
        await f
          .handlers()
          .POST(f.request('POST', { headers: { 'x-editor-session-scope': value } })),
        403,
      );
      expect(f.ports.resolveOwnerId).not.toHaveBeenCalled();
      assertNoDomain(f);
    },
  );
  it('legacy empty authenticated form session is unavailable even if headers match', async () => {
    const f = fixture();
    f.ports.authenticate.mockResolvedValue({ formSessionScope: '' });
    await rejection(
      await f.handlers().POST(f.request('POST', { headers: { 'x-editor-session-scope': '' } })),
      403,
    );
    expect(f.ports.resolveOwnerId).not.toHaveBeenCalled();
    assertNoDomain(f);
  });
  it.each(['missing-form', 'bad-secret', 'bad-origin-config'] as const)(
    '%s fails before resolver',
    async (mode) => {
      const f = fixture();
      if (mode === 'bad-secret') f.ports.secret = '';
      if (mode === 'bad-origin-config') f.ports.origin = 'not a URL';
      await rejection(
        await f.handlers().POST(
          f.request('POST', {
            headers: mode === 'missing-form' ? { 'x-editor-form-scope': null } : {},
          }),
        ),
        mode === 'missing-form' ? 403 : 503,
      );
      expect(f.ports.resolveOwnerId).not.toHaveBeenCalled();
      assertNoDomain(f);
    },
  );
  it('invalid signature/wrong owner cannot produce scope retirement', async () => {
    const f = fixture();
    f.ports.resolveOwnerId.mockResolvedValue(other);
    await rejection(await f.handlers().POST(f.request('POST')), 403);
    assertNoDomain(f);
    f.ports.resolveOwnerId.mockResolvedValue(owner);
    await rejection(
      await f.handlers().POST(
        f.request('POST', {
          headers: { 'x-editor-form-scope': `${f.grant.issuedOperationHandle}x` },
        }),
      ),
      403,
    );
    assertNoDomain(f);
  });
  it('valid signed old session retires before backend without historical nonapplication claim', async () => {
    const f = fixture();
    const current = 'different_current_session_scope';
    f.ports.authenticate.mockResolvedValue({ formSessionScope: current });
    const response = await f
      .handlers()
      .GET(f.request('GET', { headers: { 'x-editor-session-scope': current } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      authority: 'scope_retirement',
      outcome: 'voided',
    });
    assertNoDomain(f);
  });
  it('24-hour replay retirement is returned before body/domain processing without no-write wording', async () => {
    const f = fixture();
    f.setClock(NOW + 24 * 60 * 60_000);
    const response = await f.handlers().POST(f.request('POST', { raw: 'not-json' }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ authority: 'scope_retirement', outcome: 'voided' });
    expect(body).not.toHaveProperty('ids');
    expect(body).not.toHaveProperty('requestHash');
    expect(body.outcome).not.toBe('not_applied');
    assertNoDomain(f);
  });
  it('backend epoch/privacy retirement fence wins before any apply/lookup (port-boundary proof only)', async () => {
    const f = fixture();
    f.ports.withBackend.mockImplementation(async (scope) => ownerEditorRetired(scope));
    const response = await f.handlers().POST(f.request('POST'));
    expect(await response.json()).toMatchObject({
      authority: 'scope_retirement',
      outcome: 'voided',
    });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it.each(['text/plain', null])(
    'requires JSON content type %s with no domain call',
    async (value) => {
      const f = fixture();
      await rejection(
        await f.handlers().POST(f.request('POST', { headers: { 'content-type': value } })),
        415,
      );
      assertNoDomain(f);
    },
  );
  it.each(['{', '', 'null', '[]'])(
    'actual malformed/nonobject JSON %j rejects without partial success',
    async (raw) => {
      const f = fixture();
      await rejection(
        await f.handlers().POST(f.request('POST', { raw })),
        raw === 'null' || raw === '[]' ? 422 : 400,
      );
      assertNoDomain(f);
    },
  );
  it.each(['declared', 'streamed'] as const)(
    'actual %s oversize body is bounded at16KiB before domain',
    async (mode) => {
      const f = fixture();
      const options =
        mode === 'declared'
          ? { raw: '{}', headers: { 'content-length': '16385' } }
          : {
              raw: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(16_385));
                  controller.close();
                },
              }),
            };
      await rejection(await f.handlers().POST(f.request('POST', options)), 413);
      assertNoDomain(f);
    },
  );
  it('actual body reader five-second deadline returns request rejection, never known save failure', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const running = f.handlers().POST(
      f.request('POST', {
        raw: new ReadableStream<Uint8Array>({
          pull() {
            return new Promise(() => {});
          },
        }),
      }),
    );
    await vi.advanceTimersByTimeAsync(5_001);
    await rejection(await running, 408);
    assertNoDomain(f);
  });
  it.each(['ownerId', 'nameOverride', 'actionId'])(
    'strict shared wire rejects unknown %s authority/body field',
    async (field) => {
      const f = fixture();
      await rejection(
        await f.handlers().POST(f.request('POST', { body: { ...f.body, [field]: owner } })),
        422,
      );
      assertNoDomain(f);
    },
  );
  it('command/op/target mismatches have no apply and no receipt reservation', async () => {
    const f = fixture('update_person_identity');
    for (const body of [
      { ...f.body, operationId: other },
      {
        version: 1,
        intent: 'apply',
        command: 'create_person',
        operationId: f.scope.operationId,
        name: 'Sam',
        aliases: [],
      },
      { ...f.body, contactId: other },
    ]) {
      await rejection(await f.handlers().POST(f.request('POST', { body })), 409);
      assertNoDomain(f);
    }
    const family = fixture('add_family_relationship');
    await rejection(
      await family.handlers().POST(
        family.request('POST', {
          body: { ...family.body, subjectContactId: other, objectContactId: third },
        }),
      ),
      409,
    );
    assertNoDomain(family);
  });
  it('valid but wrong command route is rejected by actual wire mapping', async () => {
    const f = fixture();
    const handlers = createOwnerEditorHttpHandlers(paths.family, f.ports);
    await rejection(await handlers.POST(f.request('POST', { pathname: paths.family })), 409);
    assertNoDomain(f);
    const memory = fixture('correct_owner_memory');
    const memoryOnFamily = createOwnerEditorHttpHandlers(paths.family, memory.ports);
    await rejection(
      await memoryOnFamily.POST(memory.request('POST', { pathname: paths.family })),
      409,
    );
    assertNoDomain(memory);
  });
  it.each(['HEAD', 'PUT', 'DELETE'])(
    'unsupported %s method rejects before auth/resolution',
    async (method) => {
      const f = fixture();
      await rejection(await f.handlers().GET(f.request(method)), 405);
      expect(f.ports.authenticate).not.toHaveBeenCalled();
      expect(f.ports.resolveOwnerId).not.toHaveBeenCalled();
      assertNoDomain(f);
    },
  );
  it('wrong URL path rejects before auth rather than dispatch by supplied action', async () => {
    const f = fixture();
    await rejection(
      await f.handlers().POST(f.request('POST', { pathname: '/api/people/editor/extra' })),
      404,
    );
    expect(f.ports.authenticate).not.toHaveBeenCalled();
    assertNoDomain(f);
  });
  it.each(['', '?operation=wrong', '?operation=x&operation=y', '?operation=x&extra=y'])(
    'GET strict lookup shape %s cannot call backend',
    async (query) => {
      const f = fixture();
      await rejection(await f.handlers().GET(f.request('GET', { query })), 400);
      assertNoDomain(f);
    },
  );
  it.each([
    ['add_family_relationship', paths.memory],
    ['correct_owner_memory', paths.family],
  ] as const)(
    'GET rejects a valid signed handle on the wrong command route: %s',
    async (command, wrongPath) => {
      const f = fixture(command);
      const handlers = createOwnerEditorHttpHandlers(wrongPath, f.ports);
      await rejection(await handlers.GET(f.request('GET', { pathname: wrongPath })), 409);
      expect(f.ports.withBackend).not.toHaveBeenCalled();
      expect(f.lookup).not.toHaveBeenCalled();
    },
  );
  it('GET permits a valid memory correction handle on its originally issued route', async () => {
    const f = fixture('correct_owner_memory');
    const response = await f.handlers().GET(f.request('GET'));
    expect(response.status).toBe(202);
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith(f.scope, new Date(NOW));
  });
  it('POST query parameters are rejected rather than selecting another operation', async () => {
    const f = fixture();
    await rejection(await f.handlers().POST(f.request('POST', { query: '?operation=other' })), 400);
    assertNoDomain(f);
  });
});

describe('actual receipt GET/proof/reconcile lifecycle with offline operation port', () => {
  async function getProof(f: ReturnType<typeof fixture>) {
    f.lookup.mockResolvedValue({
      reply: ownerEditorUnknown(f.scope, 'preparing'),
      operation: f.record(),
    });
    const response = await f.handlers().GET(f.request('GET', { headers: { origin: null } }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(typeof body.receiptBindingToken).toBe('string');
    return body.receiptBindingToken as string;
  }
  it.each(['create_person', 'add_family_relationship'] as const)(
    'GET %s is readonly and proof binds only original preparing record',
    async (command) => {
      const f = fixture(command);
      const token = await getProof(f);
      expect(
        verifyOwnerEditorReceiptProof({ token, scope: f.scope, secret, now: NOW }),
      ).toMatchObject({ requestHash: hash, statusVersion: 1 });
      expect(f.lookup).toHaveBeenCalledExactlyOnceWith(f.scope, new Date(NOW));
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.reconcile).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.failPreparation).not.toHaveBeenCalled();
    },
  );
  it('missing/nonpreparing/mismatched operation never obtains an invented proof', async () => {
    for (const mode of ['missing', 'committed', 'wrong-scope'] as const) {
      const f = fixture();
      const operation =
        mode === 'missing'
          ? null
          : mode === 'committed'
            ? { ...f.record(), status: 'committed' as const }
            : { ...f.record(), scopeDigest: 'f'.repeat(64) };
      f.lookup.mockResolvedValue({ reply: ownerEditorUnknown(f.scope), operation });
      const body = await (await f.handlers().GET(f.request('GET'))).json();
      expect(body.authority).toBe('unresolved');
      expect(body).not.toHaveProperty('receiptBindingToken');
      expect(f.apply).not.toHaveBeenCalled();
    }
  });
  it('expired10min form denies apply, still permits readonlyGET+explicitproof reconciliation inside24h', async () => {
    const f = fixture();
    f.setClock(NOW + 10 * 60_000);
    await rejection(await f.handlers().POST(f.request('POST')), 409);
    assertNoDomain(f);
    const proof = await getProof(f);
    const response = await f.handlers().POST(
      f.request('POST', {
        body: {
          version: 1,
          intent: 'reconcile',
          command: f.scope.command,
          operationId: f.scope.operationId,
          receiptBindingToken: proof,
        },
      }),
    );
    expect(await response.json()).toEqual(f.saved);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('proof-only reconcile calls existing operation port, never apply/private-body preparation', async () => {
    const f = fixture();
    const proof = await getProof(f);
    const reduced = {
      version: 1,
      intent: 'reconcile',
      command: f.scope.command,
      operationId: f.scope.operationId,
      receiptBindingToken: proof,
    };
    await rejection(
      await f
        .handlers()
        .POST(f.request('POST', { body: { ...reduced, name: 'private replacement' } })),
      422,
    );
    expect(f.reconcile).not.toHaveBeenCalled();
    const response = await f.handlers().POST(f.request('POST', { body: reduced }));
    expect(response.status).toBe(200);
    expect(f.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ requestHash: hash, scope: f.scope }),
      new Date(NOW),
    );
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('stale/tampered proof is UNKNOWN, not serialized not_applied or a new operation', async () => {
    const f = fixture();
    const proof = await getProof(f);
    f.setClock(NOW + 120_000);
    for (const token of [proof, `${proof}x`]) {
      const response = await f.handlers().POST(
        f.request('POST', {
          body: {
            version: 1,
            intent: 'reconcile',
            command: f.scope.command,
            operationId: f.scope.operationId,
            receiptBindingToken: token,
          },
        }),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        authority: 'unresolved',
        outcome: 'outcome_unknown',
        reason: 'proof_changed',
      });
    }
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('epoch retirement modeled by backend fence also blocks a valid proof before reconcile', async () => {
    const f = fixture();
    const proof = await getProof(f);
    f.ports.withBackend.mockImplementation(async (scope) => ownerEditorRetired(scope));
    const response = await f.handlers().POST(
      f.request('POST', {
        body: {
          version: 1,
          intent: 'reconcile',
          command: f.scope.command,
          operationId: f.scope.operationId,
          receiptBindingToken: proof,
        },
      }),
    );
    expect(await response.json()).toMatchObject({
      authority: 'scope_retirement',
      outcome: 'voided',
    });
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });
  it.each(['apply', 'lookup', 'backend'] as const)(
    '%s throwing is UNKNOWN, never known no-write failure',
    async (mode) => {
      const f = fixture();
      if (mode === 'apply') f.apply.mockRejectedValue(Error('commit visibility unknown'));
      if (mode === 'lookup') f.lookup.mockRejectedValue(Error('receipt unavailable'));
      if (mode === 'backend') f.ports.withBackend.mockRejectedValue(Error('driver unavailable'));
      const response =
        mode === 'lookup'
          ? await f.handlers().GET(f.request('GET'))
          : await f.handlers().POST(f.request('POST'));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        authority: 'unresolved',
        outcome: 'outcome_unknown',
      });
    },
  );
  it('actual request rejection cannot clear an original pending marker via actual client helper', async () => {
    const f = fixture();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const marker = { id: f.grant.issuedOperationHandle, command: f.scope.command, targetId: null };
    writeOwnerEditorPendingMarker(storage, owner, session.formSessionScope, marker);
    const reply = decodeOwnerEditorReply(
      await (
        await f.handlers().POST(f.request('POST', { body: { ...f.body, injectedOwner: other } }))
      ).json(),
    );
    expect(reply?.authority).toBe('request_rejection');
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        owner,
        session.formSessionScope,
        marker,
        reply,
        f.scope.operationId,
        hash,
      ),
    ).toBe(false);
    expect(readOwnerEditorPendingMarker(storage, owner, session.formSessionScope)).toEqual(marker);
    assertNoDomain(f);
  });
});
