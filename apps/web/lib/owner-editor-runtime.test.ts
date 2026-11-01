import type {
  OwnerEditorClaim,
  OwnerEditorOperationRepository,
  OwnerEditorReply,
  OwnerEditorScope,
} from '@assistant/persistence/owner-editor';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  authed: vi.fn(),
  getDb: vi.fn(),
  assertOwner: vi.fn(),
  pgRepository: vi.fn(),
  getStore: vi.fn(),
  getRouter: vi.fn(),
  validateFirestore: vi.fn(),
  parseEmbeddingSpace: vi.fn(),
  createFirestoreStorage: vi.fn(),
  createFirestoreRepository: vi.fn(),
  createPostgresDomain: vi.fn(),
  createFirestoreDomain: vi.fn(),
  reserve: vi.fn(),
  lookup: vi.fn(),
  reconcile: vi.fn(),
  failPreparation: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  events: [] as string[],
}));

vi.mock('@assistant/config', () => ({
  loadConfig: () => mocks.config,
  validateAgentPersistenceConfig: mocks.validateFirestore,
  parseFirestoreEmbeddingSpace: mocks.parseEmbeddingSpace,
}));
vi.mock('@/auth', () => ({ isAuthed: mocks.authed }));
vi.mock('@/lib/server', () => ({
  assertPostgresInstallationOwner: mocks.assertOwner,
  createPostgresOwnerEditorOperationRepository: mocks.pgRepository,
  getDb: mocks.getDb,
  getFirestoreInstallationStore: mocks.getStore,
  getRouter: mocks.getRouter,
}));
vi.mock('@assistant/firestore', () => ({
  createFirestoreOwnerEditorDomainStorage: mocks.createFirestoreStorage,
  createFirestoreOwnerEditorOperationRepository: mocks.createFirestoreRepository,
}));
vi.mock('@assistant/application/owner-editor-domain', () => ({
  createOwnerEditorDomain: mocks.createFirestoreDomain,
  createPostgresOwnerEditorDomain: mocks.createPostgresDomain,
}));

import { ownerEditorUnknown } from '@assistant/persistence';
import { handleOwnerEditorRequest } from './owner-editor-runtime';
import { issueOwnerEditorFormGrant } from './owner-editor-scope';

const ownerId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const secret = 'offline-runtime-test-secret';
const origin = 'https://owner.example.test';
const session = { ownerId, formSessionScope: 'offline_runtime_form_session' };
const now = Date.now();
const route = '/api/people/editor' as const;

function postgresConfig(overrides: Record<string, unknown> = {}) {
  return {
    ASSISTANT_RELEASE_WRITES_PAUSED: false,
    RESTORE_REHEARSAL: false,
    AUTH_URL: origin,
    AUTH_SECRET: secret,
    PERSISTENCE_DRIVER: 'postgres',
    FIRESTORE_AGENT_ID: 'fixture-agent',
    FIRESTORE_EMBEDDING_SPACE: 'default',
    ...overrides,
  };
}

function grant(command: 'create_person' | 'update_person_identity' = 'create_person') {
  return issueOwnerEditorFormGrant({
    context: { ownerId, epoch, privacyGeneration: 'runtime-fixture-generation' },
    session,
    command,
    targetId: command === 'create_person' ? null : targetId,
    secret,
    now,
  });
}

function createBody(operationId: string) {
  return {
    version: 1,
    intent: 'apply',
    command: 'create_person',
    operationId,
    name: 'Sam Example',
    aliases: [],
  };
}

function postRequest(
  handle: string,
  operationId: string,
  overrides: { origin?: string; sessionScope?: string } = {},
) {
  return new Request(`${origin}${route}`, {
    method: 'POST',
    headers: {
      origin: overrides.origin ?? origin,
      'content-type': 'application/json',
      'x-editor-session-scope': overrides.sessionScope ?? session.formSessionScope,
      'x-editor-form-scope': handle,
    },
    body: JSON.stringify(createBody(operationId)),
  });
}

function getRequest(handle: string) {
  return new Request(`${origin}${route}?operation=${encodeURIComponent(handle)}`, {
    method: 'GET',
    headers: {
      'x-editor-session-scope': session.formSessionScope,
      'x-editor-form-scope': handle,
    },
  });
}

function operationRepository() {
  const repository: OwnerEditorOperationRepository = {
    kind: 'owner-editor-operation-repository',
    reserve: mocks.reserve,
    lookup: mocks.lookup,
    reconcile: mocks.reconcile,
    failPreparation: mocks.failPreparation,
  };
  return repository;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.config = postgresConfig();
  mocks.authed.mockResolvedValue({ formSessionScope: session.formSessionScope });
  mocks.getDb.mockImplementation(() => {
    mocks.events.push('getDb');
    return { kind: 'offline-db-fixture' };
  });
  mocks.assertOwner.mockImplementation(() => {
    mocks.events.push('assertOwner');
    return ownerId;
  });
  mocks.getRouter.mockImplementation(() => {
    mocks.events.push('getRouter');
    return { route: 'offline-router-fixture' };
  });
  mocks.pgRepository.mockImplementation(() => {
    mocks.events.push('createRepository');
    return operationRepository();
  });
  mocks.reserve.mockImplementation(async (scope: OwnerEditorScope) => {
    mocks.events.push('reserve');
    return {
      kind: 'reply' as const,
      reply: ownerEditorUnknown(scope, 'preparing'),
    };
  });
  mocks.lookup.mockImplementation(async (scope: OwnerEditorScope) => ({
    reply: ownerEditorUnknown(scope, 'receipt_missing'),
    operation: null,
  }));
  mocks.reconcile.mockResolvedValue({});
  mocks.failPreparation.mockResolvedValue({});
  mocks.prepare.mockImplementation(async () => {
    mocks.events.push('prepare');
    return { ok: true, prepared: { prepared: true } };
  });
  mocks.commit.mockImplementation(async () => {
    mocks.events.push('commit');
    return {
      version: 1,
      authority: 'operation_receipt',
      outcome: 'saved',
      command: 'create_person',
      operationId: '44444444-4444-4444-8444-444444444444',
      requestHash: 'a'.repeat(64),
      statusVersion: 2,
      ids: { contactId: targetId },
      revision: 'b'.repeat(64),
    } satisfies OwnerEditorReply;
  });
  mocks.createPostgresDomain.mockImplementation(() => ({
    prepare: mocks.prepare,
    commit: mocks.commit,
  }));
  mocks.validateFirestore.mockReturnValue([]);
  mocks.getStore.mockReturnValue({ kind: 'offline-firestore-fixture' });
  mocks.createFirestoreRepository.mockImplementation(() => operationRepository());
  mocks.parseEmbeddingSpace.mockReturnValue({ kind: 'offline-embedding-space' });
  mocks.createFirestoreStorage.mockReturnValue({});
  mocks.createFirestoreDomain.mockImplementation(() => ({
    prepare: mocks.prepare,
    commit: mocks.commit,
  }));
});

describe('owner editor runtime composition boundary', () => {
  it.each([
    ['release writes paused', { ASSISTANT_RELEASE_WRITES_PAUSED: true }],
    ['restore rehearsal active', { RESTORE_REHEARSAL: true }],
    ['PostgreSQL source writes fenced', { POSTGRES_SOURCE_WRITES_FENCED: true }],
  ])('%s returns 503 before authentication or backend access', async (_label, config) => {
    mocks.config = postgresConfig(config);
    const issued = grant();

    const response = await handleOwnerEditorRequest(
      postRequest(issued.issuedOperationHandle, issued.operationId),
      route,
    );

    expect(response.status).toBe(503);
    expect(mocks.authed).not.toHaveBeenCalled();
    expect(mocks.assertOwner).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.pgRepository).not.toHaveBeenCalled();
    expect(mocks.getRouter).not.toHaveBeenCalled();
  });

  it.each([
    ['authentication fails', async () => mocks.authed.mockResolvedValueOnce(null), {}],
    ['origin fails', async () => undefined, { origin: 'https://attacker.example.test' }],
    ['session scope fails', async () => undefined, { sessionScope: 'wrong_runtime_session_scope' }],
  ])('%s before database or router access', async (_label, arrange, headers) => {
    await arrange();
    const issued = grant();

    const response = await handleOwnerEditorRequest(
      postRequest(issued.issuedOperationHandle, issued.operationId, headers),
      route,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.assertOwner).not.toHaveBeenCalled();
    expect(mocks.pgRepository).not.toHaveBeenCalled();
    expect(mocks.getRouter).not.toHaveBeenCalled();
  });

  it('does not construct router, domain or embedding dependencies during GET receipt lookup', async () => {
    mocks.config = postgresConfig({
      PERSISTENCE_DRIVER: 'firestore',
      FIRESTORE_AGENT_ID: ownerId,
    });
    const issued = grant();
    mocks.lookup.mockImplementationOnce(async (scope: OwnerEditorScope) => ({
      reply: ownerEditorUnknown(scope, 'receipt_missing'),
      operation: null,
    }));

    const response = await handleOwnerEditorRequest(
      getRequest(issued.issuedOperationHandle),
      route,
    );

    expect(response.status).toBe(202);
    expect(mocks.getStore).toHaveBeenCalledTimes(1);
    expect(mocks.createFirestoreRepository).toHaveBeenCalledTimes(1);
    expect(mocks.getRouter).not.toHaveBeenCalled();
    expect(mocks.createFirestoreDomain).not.toHaveBeenCalled();
    expect(mocks.createPostgresDomain).not.toHaveBeenCalled();
    expect(mocks.createFirestoreStorage).not.toHaveBeenCalled();
    expect(mocks.parseEmbeddingSpace).not.toHaveBeenCalled();
  });

  it('returns a durable reserve reply without constructing the domain or router', async () => {
    const issued = grant();

    const response = await handleOwnerEditorRequest(
      postRequest(issued.issuedOperationHandle, issued.operationId),
      route,
    );
    const reply = (await response.json()) as OwnerEditorReply;

    expect(reply.authority, JSON.stringify(reply)).toBe('unresolved');
    expect(mocks.events).toEqual(['getDb', 'assertOwner', 'getDb', 'createRepository', 'reserve']);
    expect(mocks.getRouter).not.toHaveBeenCalled();
    expect(mocks.createPostgresDomain).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('reserves before router/domain preparation and commits only after preparation', async () => {
    mocks.reserve.mockImplementationOnce(async (scope: OwnerEditorScope) => {
      mocks.events.push('reserve');
      const claim: OwnerEditorClaim = {
        scope,
        requestHash: 'a'.repeat(64),
        claimToken: '55555555-5555-4555-8555-555555555555',
        claimExpiresAt: new Date(now + 60_000),
        statusVersion: 1,
      };
      return { kind: 'claimed' as const, claim };
    });

    const issued = grant();
    const response = await handleOwnerEditorRequest(
      postRequest(issued.issuedOperationHandle, issued.operationId),
      route,
    );
    const reply = (await response.json()) as OwnerEditorReply;

    expect(response.status, JSON.stringify(reply)).toBe(200);
    expect(reply.authority).toBe('operation_receipt');
    expect(mocks.events).toEqual([
      'getDb',
      'assertOwner',
      'getDb',
      'createRepository',
      'reserve',
      'getRouter',
      'prepare',
      'commit',
    ]);
    expect(mocks.createPostgresDomain).toHaveBeenCalledTimes(1);
  });
});
