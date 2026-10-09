import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  config: {
    PERSISTENCE_DRIVER: 'firestore',
    RESTORE_REHEARSAL: false,
    GCP_PROJECT: '',
    MOBILE_API_TOKEN_SECRET_NAME: 'fixture-mobile-token-secret',
    MOBILE_API_TOKEN: 'safe-fixture-mobile-token',
    OWNER_AUTH_MODE: 'google',
    AUTH_URL: 'https://assistant.example.test',
    PUBLIC_URL: 'https://assistant.example.test',
  },
  ownerSession: vi.fn(),
  secretLookup: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
}));

// Keep the production mobile-auth predicate and token comparison real. These
// mocks supply only the configured owner session, installation config, safe
// token lookup, and application port below the actual route boundary.
vi.mock('@assistant/config', () => ({ loadConfig: () => authState.config }));
vi.mock('./auth', () => ({ isAuthed: authState.ownerSession }));
vi.mock('./lib/mobile-access-token', () => ({ getMobileAccessToken: authState.secretLookup }));
vi.mock('@/lib/server', () => ({
  getChatApplication: () => ({
    submitCardForm: authState.submit,
    cancelChatTurn: authState.cancel,
  }),
}));

import { POST as CANCEL_POST } from './app/api/mobile/v1/chat/cancel/route';
import { POST } from './app/api/mobile/v1/chat/forms/route';
import { proxy } from './proxy';

const submission = {
  protocol: 'card-form-v1',
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  cardId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expectedRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  formId: 'trip_plan',
  operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  values: { destination: 'Portland', confirmed: false },
  ownerMessageText: 'Plan a weekend in Portland.',
} as const;

const receipt = {
  ok: true,
  created: true,
  taskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  messageId: '11111111-1111-4111-8111-111111111111',
  messageCursor: '2026-10-08T12:00:00.000Z|11111111-1111-4111-8111-111111111111',
  taskStatus: 'pending',
  queueGeneration: 1,
  dispatch: 'outbox',
};

function post(options: { origin?: string; authorization?: string; cookie?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.origin !== undefined) headers.set('origin', options.origin);
  if (options.authorization) headers.set('authorization', options.authorization);
  if (options.cookie) headers.set('cookie', options.cookie);
  const request = new NextRequest('https://assistant.example.test/api/mobile/v1/chat/forms', {
    method: 'POST',
    headers,
    body: JSON.stringify(submission),
  });
  const gate = proxy(request);
  expect(gate.status).toBe(200);
  return { request, response: POST(request) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.config.RESTORE_REHEARSAL = false;
  vi.stubEnv('K_SERVICE', '');
  authState.ownerSession.mockResolvedValue({ user: { email: 'owner@example.test' } });
  authState.secretLookup.mockResolvedValue('safe-fixture-mobile-token');
  authState.submit.mockResolvedValue(receipt);
  authState.cancel.mockResolvedValue({
    kind: 'cancelled_before_admission',
    task: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    status: 'cancelled',
    transitioned: true,
    effectStatus: 'not_started',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('real mobile-auth predicate composed with mobile form admission route', () => {
  it.each([
    { label: 'hostile same-site origin', origin: 'https://sibling.example.test' },
    { label: 'cross-site origin', origin: 'https://attacker.test' },
    { label: 'missing origin', origin: undefined },
    { label: 'opaque null origin', origin: 'null' },
  ])(
    'rejects cookie mutation from $label before reading the body or admitting',
    async ({ origin }) => {
      const { request, response } = post({
        origin,
        cookie: 'assistant_session=fixture-owner-cookie',
      });

      expect((await response).status).toBe(401);
      expect(request.bodyUsed).toBe(false);
      expect(authState.ownerSession).not.toHaveBeenCalled();
      expect(authState.secretLookup).not.toHaveBeenCalled();
      expect(authState.submit).not.toHaveBeenCalled();
    },
  );

  it('rejects an exact-origin cookie when no owner session is authenticated', async () => {
    authState.ownerSession.mockResolvedValue(null);
    const { request, response } = post({
      origin: 'https://assistant.example.test',
      cookie: 'assistant_session=fixture-unverified-cookie',
    });

    expect((await response).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(authState.ownerSession).toHaveBeenCalledOnce();
    expect(authState.secretLookup).not.toHaveBeenCalled();
    expect(authState.submit).not.toHaveBeenCalled();
  });

  it('accepts a verified owner cookie from the configured exact origin', async () => {
    const { request, response } = post({
      origin: 'https://assistant.example.test',
      cookie: 'assistant_session=fixture-owner-cookie',
    });

    const result = await response;
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(receipt);
    expect(request.bodyUsed).toBe(true);
    expect(authState.ownerSession).toHaveBeenCalledOnce();
    expect(authState.submit).toHaveBeenCalledWith(submission);
    expect(authState.secretLookup).not.toHaveBeenCalled();
  });

  it('accepts a valid fixture bearer without Origin and does not consult the cookie session', async () => {
    const { request, response } = post({
      authorization: 'Bearer safe-fixture-mobile-token',
    });

    const result = await response;
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(receipt);
    expect(request.bodyUsed).toBe(true);
    expect(authState.secretLookup).toHaveBeenCalledOnce();
    expect(authState.ownerSession).not.toHaveBeenCalled();
    expect(authState.submit).toHaveBeenCalledWith(submission);
  });

  it('does not let an invalid bearer bypass hostile-origin cookie protection', async () => {
    const { request, response } = post({
      origin: 'https://evil.example.test',
      authorization: 'Bearer invalid-fixture-token',
      cookie: 'assistant_session=fixture-owner-cookie',
    });

    expect((await response).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(authState.secretLookup).toHaveBeenCalledOnce();
    expect(authState.ownerSession).not.toHaveBeenCalled();
    expect(authState.submit).not.toHaveBeenCalled();
  });
});

describe('mobile form route gate in Firestore mode', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE'])(
    'rejects unsupported %s before route execution',
    (method) => {
      const request = new NextRequest('https://assistant.example.test/api/mobile/v1/chat/forms', {
        method,
      });
      expect(proxy(request).status).toBe(503);
      expect(authState.submit).not.toHaveBeenCalled();
    },
  );

  it('keeps form mutations unavailable during restore rehearsal', () => {
    authState.config.RESTORE_REHEARSAL = true;
    const request = new NextRequest('https://assistant.example.test/api/mobile/v1/chat/forms', {
      method: 'POST',
    });
    expect(proxy(request).status).toBe(503);
    expect(authState.submit).not.toHaveBeenCalled();
  });
});

describe('real mobile auth composed with proxy and operation cancellation route', () => {
  function cancelPost(options: { origin?: string; authorization?: string; cookie?: string } = {}) {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (options.origin !== undefined) headers.set('origin', options.origin);
    if (options.authorization) headers.set('authorization', options.authorization);
    if (options.cookie) headers.set('cookie', options.cookie);
    const identity = {
      conversationId: submission.conversationId,
      clientOperationId: submission.operationId,
    };
    const request = new NextRequest('https://assistant.example.test/api/mobile/v1/chat/cancel', {
      method: 'POST',
      headers,
      body: JSON.stringify(identity),
    });
    expect(proxy(request).status).toBe(200);
    return { request, identity, response: CANCEL_POST(request) };
  }

  it.each(['https://sibling.example.test', 'https://attacker.test', undefined, 'null'])(
    'rejects untrusted cookie Origin %s before body or cancellation access',
    async (origin) => {
      const { request, response } = cancelPost({
        origin,
        cookie: 'assistant_session=fixture-owner-cookie',
      });
      expect((await response).status).toBe(401);
      expect(request.bodyUsed).toBe(false);
      expect(authState.ownerSession).not.toHaveBeenCalled();
      expect(authState.secretLookup).not.toHaveBeenCalled();
      expect(authState.cancel).not.toHaveBeenCalled();
    },
  );
  it('still requires a verified owner at the exact origin', async () => {
    authState.ownerSession.mockResolvedValue(null);
    const { request, response } = cancelPost({
      origin: 'https://assistant.example.test',
      cookie: 'assistant_session=fixture-unverified-cookie',
    });
    expect((await response).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(authState.cancel).not.toHaveBeenCalled();
  });
  it('accepts a verified owner cookie without exposing the marker task', async () => {
    const { identity, response } = cancelPost({
      origin: 'https://assistant.example.test',
      cookie: 'assistant_session=fixture-owner-cookie',
    });
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      ok: true,
      ...identity,
      taskId: null,
      outcome: 'cancelled_before_admission',
      effectStatus: 'not_started',
    });
    expect(authState.cancel).toHaveBeenCalledWith(identity);
    expect(authState.secretLookup).not.toHaveBeenCalled();
  });
  it('accepts a valid bearer without an Origin or cookie lookup', async () => {
    const { identity, response } = cancelPost({
      authorization: 'Bearer safe-fixture-mobile-token',
    });
    expect((await response).status).toBe(200);
    expect(authState.cancel).toHaveBeenCalledWith(identity);
    expect(authState.secretLookup).toHaveBeenCalledOnce();
    expect(authState.ownerSession).not.toHaveBeenCalled();
  });
  it('does not let an invalid bearer bypass hostile-origin protection', async () => {
    const { request, response } = cancelPost({
      origin: 'https://attacker.test',
      authorization: 'Bearer invalid-fixture-token',
      cookie: 'assistant_session=fixture-owner-cookie',
    });
    expect((await response).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(authState.cancel).not.toHaveBeenCalled();
    expect(authState.ownerSession).not.toHaveBeenCalled();
  });
});
