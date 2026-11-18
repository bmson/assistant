import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const instant = z.string().datetime({ offset: true });
const id = z.string().uuid();
const value = z.string().min(1).max(2048);
// Storage accepts only the authenticated v2 envelope, never raw secrets.
const encrypted = z
  .string()
  .max(131072)
  .regex(/^v2\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
const bindingSchema = z
  .object({
    endpoint: value,
    resource: value,
    issuer: value,
    authorizationEndpoint: value,
    tokenEndpoint: value,
    redirectUri: value,
    clientId: value,
    tokenEndpointAuthMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post']),
    authorizationResponseIssuerRequired: z.boolean(),
  })
  .strict();
const client = z.enum(['web', 'ios']);
const failure = z.enum([
  'denied',
  'expired',
  'cancelled',
  'superseded',
  'invalid_grant',
  'issuer_mismatch',
  'provider_unavailable',
  'failed',
]);
const terminalSchema = z
  .object({
    id,
    client,
    outcome: failure.or(z.literal('connected')),
  })
  .strict();
const flowSchema = z
  .object({
    id,
    client,
    binding: bindingSchema,
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: instant,
    clientSecretEncrypted: encrypted.nullable(),
    phase: z.literal('pending'),
    verifierEncrypted: encrypted,
  })
  .strict();
const processingSchema = flowSchema.omit({ verifierEncrypted: true }).extend({
  phase: z.literal('processing'),
});
const tokensSchema = z
  .object({
    accessTokenEncrypted: encrypted,
    refreshTokenEncrypted: encrypted.nullable(),
    accessTokenExpiresAt: instant,
    scopes: z.array(z.string().min(1).max(512)).max(128),
  })
  .strict();
const discoverySchema = z
  .object({
    serverName: z.string().max(512).nullable(),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(512),
            description: z.string().max(16384).optional(),
            inputSchema: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 131072,
    'Discovery metadata exceeds storage limit',
  );

const grantSchema = z
  .object({
    generation: id,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    binding: bindingSchema,
    clientSecretEncrypted: encrypted.nullable(),
    tokens: tokensSchema,
    discovery: discoverySchema,
    refresh: z.object({ id, expiresAt: instant }).strict().nullable(),
    reconnectRequired: z.boolean(),
  })
  .strict();

const stateSchema = z
  .object({
    version: z.literal(1),
    ownerId: value,
    connectionId: id,
    flow: z.discriminatedUnion('phase', [flowSchema, processingSchema]).nullable(),
    grant: grantSchema.nullable(),
    lastOutcome: terminalSchema.nullable(),
  })
  .strict();

export type McpOAuthBinding = z.infer<typeof bindingSchema>;
export type McpOAuthFlowFailure = z.infer<typeof failure>;
export type McpOAuthFlowOutcome = z.infer<typeof terminalSchema>;
export type McpOAuthFlowCompletion =
  | { outcome: 'connected'; tokens: McpOAuthTokens; discovery: McpOAuthDiscovery }
  | { outcome: McpOAuthFlowFailure };
export type McpOAuthPendingFlow = z.infer<typeof flowSchema>;
export type McpOAuthDiscovery = z.infer<typeof discoverySchema>;
export type McpOAuthTokens = z.infer<typeof tokensSchema>;
export type McpOAuthGrant = z.infer<typeof grantSchema>;
export type McpOAuthState = z.infer<typeof stateSchema>;
export interface McpOAuthConnectionKey {
  ownerId: string;
  connectionId: string;
}
type Change<T> = (state: McpOAuthState) => { state: McpOAuthState; result: T };
export interface McpOAuthStorage {
  /** Verify owner, live connection, and exact endpoint. Serialize application of change. */
  update<T>(
    key: McpOAuthConnectionKey,
    endpoint: string,
    change: Change<T>,
    options?: { allowDisabled: true },
  ): Promise<T | null>;
}

export function parseMcpOAuthState(
  raw: unknown,
  key: McpOAuthConnectionKey,
  endpoint: string,
): McpOAuthState {
  if (raw === null || raw === undefined)
    return { version: 1, ...key, flow: null, grant: null, lastOutcome: null };
  const parsed = stateSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.ownerId !== key.ownerId ||
    parsed.data.connectionId !== key.connectionId ||
    (parsed.data.flow !== null && parsed.data.flow.binding.endpoint !== endpoint) ||
    (parsed.data.grant !== null && parsed.data.grant.binding.endpoint !== endpoint)
  )
    throw new Error('Invalid stored MCP OAuth state');
  return parsed.data;
}

export type McpOAuthRefreshClaim =
  | { kind: 'claimed'; grant: McpOAuthGrant }
  | { kind: 'current' | 'wait' | 'reconnect_required' | 'unavailable' };

const REFRESH_WINDOW_MS = 60_000;
function live(expiresAt: string, now: Date) {
  return Date.parse(expiresAt) > now.getTime();
}
function stateMatches(expected: string, received: string) {
  return (
    /^[a-f0-9]{64}$/.test(received) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
  );
}

function terminal(
  flow: Pick<McpOAuthPendingFlow, 'id' | 'client'>,
  outcome: McpOAuthFlowOutcome['outcome'],
): McpOAuthFlowOutcome {
  return { id: flow.id, client: flow.client, outcome };
}

/** A pause invalidates outstanding work and keeps the installed grant. */
export function pauseMcpOAuthState(state: McpOAuthState): McpOAuthState {
  return {
    ...state,
    flow: null,
    grant: state.grant?.refresh
      ? { ...state.grant, refresh: null, reconnectRequired: true }
      : state.grant,
    lastOutcome: state.flow ? terminal(state.flow, 'superseded') : state.lastOutcome,
  };
}

/** Secret-bearing repository for server composition only. Each method is one transaction. */
export function createMcpOAuthRepository(storage: McpOAuthStorage) {
  return {
    get: (key: McpOAuthConnectionKey, endpoint: string) =>
      storage.update(key, endpoint, (state) => ({ state, result: state })),
    poll: (
      key: McpOAuthConnectionKey,
      endpoint: string,
      flowId: string,
      client: McpOAuthPendingFlow['client'],
      now: Date,
    ) =>
      storage.update(
        key,
        endpoint,
        (state) => {
          const flow = state.flow;
          if (flow?.id === flowId && flow.client === client) {
            if (live(flow.expiresAt, now)) return { state, result: flow.phase };
            return {
              state: { ...state, flow: null, lastOutcome: terminal(flow, 'expired') },
              result: 'expired' as const,
            };
          }
          const last = state.lastOutcome;
          return {
            state,
            result: last?.id === flowId && last.client === client ? last.outcome : null,
          };
        },
        { allowDisabled: true },
      ),
    begin: (key: McpOAuthConnectionKey, flow: McpOAuthPendingFlow, now: Date) =>
      storage.update(key, flow.binding.endpoint, (state) => {
        if (
          !live(flow.expiresAt, now) ||
          state.flow?.id === flow.id ||
          state.grant?.generation === flow.id ||
          state.lastOutcome?.id === flow.id
        )
          return { state, result: false };
        return {
          state: {
            ...state,
            flow,
            lastOutcome: state.flow ? terminal(state.flow, 'superseded') : state.lastOutcome,
          },
          result: true,
        };
      }),
    consume: (
      key: McpOAuthConnectionKey,
      endpoint: string,
      flowId: string,
      stateHash: string,
      now: Date,
    ) =>
      storage.update(key, endpoint, (state) => {
        const flow = state.flow;
        if (
          flow?.phase !== 'pending' ||
          flow.id !== flowId ||
          flow.binding.endpoint !== endpoint ||
          !stateMatches(flow.stateHash, stateHash)
        )
          return { state, result: null };
        if (!live(flow.expiresAt, now))
          return {
            state: { ...state, flow: null, lastOutcome: terminal(flow, 'expired') },
            result: null,
          };
        const { verifierEncrypted: _verifier, ...rest } = flow;
        return { state: { ...state, flow: { ...rest, phase: 'processing' } }, result: flow };
      }),
    finish: (
      key: McpOAuthConnectionKey,
      endpoint: string,
      flowId: string,
      completion: McpOAuthFlowCompletion,
      now: Date,
    ) =>
      storage.update(key, endpoint, (state) => {
        const flow = state.flow;
        if (
          flow?.phase !== 'processing' ||
          flow.id !== flowId ||
          flow.binding.endpoint !== endpoint
        )
          return { state, result: false };
        if (!live(flow.expiresAt, now))
          return {
            state: { ...state, flow: null, lastOutcome: terminal(flow, 'expired') },
            result: false,
          };
        const grant: McpOAuthGrant | null =
          completion.outcome === 'connected'
            ? {
                generation: flowId,
                revision: 0,
                binding: flow.binding,
                clientSecretEncrypted: flow.clientSecretEncrypted,
                tokens: completion.tokens,
                discovery: completion.discovery,
                refresh: null,
                reconnectRequired: false,
              }
            : null;
        return {
          state: {
            ...state,
            flow: null,
            grant: grant ?? state.grant,
            lastOutcome: terminal(flow, completion.outcome),
          },
          result: true,
        };
      }),
    cancel: (key: McpOAuthConnectionKey, endpoint: string, flowId: string) =>
      storage.update(key, endpoint, (state) =>
        state.flow?.id === flowId
          ? {
              state: { ...state, flow: null, lastOutcome: terminal(state.flow, 'cancelled') },
              result: true,
            }
          : { state, result: false },
      ),
    disconnect: (key: McpOAuthConnectionKey, endpoint: string) =>
      storage.update(
        key,
        endpoint,
        (state) => ({
          state:
            state.flow || state.grant
              ? {
                  ...state,
                  flow: null,
                  grant: null,
                  lastOutcome: state.flow
                    ? terminal(state.flow, 'superseded')
                    : state.lastOutcome?.outcome === 'connected'
                      ? terminal(state.lastOutcome, 'superseded')
                      : state.lastOutcome,
                }
              : state,
          result: true,
        }),
        { allowDisabled: true },
      ),
    acquireRefresh: (
      key: McpOAuthConnectionKey,
      endpoint: string,
      generation: string,
      revision: number,
      leaseId: string,
      now: Date,
    ) =>
      storage.update<McpOAuthRefreshClaim>(key, endpoint, (state) => {
        const grant = state.grant;
        if (!grant || grant.generation !== generation || grant.binding.endpoint !== endpoint)
          return { state, result: { kind: 'unavailable' } };
        if (grant.reconnectRequired || !grant.tokens.refreshTokenEncrypted)
          return { state, result: { kind: 'reconnect_required' } };
        if (grant.revision !== revision) return { state, result: { kind: 'current' } };
        if (grant.refresh)
          return {
            state,
            result: { kind: live(grant.refresh.expiresAt, now) ? 'wait' : 'reconnect_required' },
          };
        const claimed = {
          ...grant,
          refresh: {
            id: leaseId,
            expiresAt: new Date(now.getTime() + REFRESH_WINDOW_MS).toISOString(),
          },
        };
        return { state: { ...state, grant: claimed }, result: { kind: 'claimed', grant: claimed } };
      }),
    completeRefresh: (
      key: McpOAuthConnectionKey,
      endpoint: string,
      generation: string,
      revision: number,
      leaseId: string,
      outcome: McpOAuthTokens | 'reconnect_required' | 'not_sent',
      now: Date,
    ) =>
      storage.update(key, endpoint, (state) => {
        const grant = state.grant;
        if (
          !grant ||
          grant.binding.endpoint !== endpoint ||
          grant.generation !== generation ||
          grant.revision !== revision ||
          grant.refresh?.id !== leaseId ||
          !live(grant.refresh.expiresAt, now)
        )
          return { state, result: false };
        const next = { ...grant, revision: revision + 1, refresh: null };
        if (outcome === 'reconnect_required') next.reconnectRequired = true;
        else if (outcome !== 'not_sent')
          next.tokens = {
            ...outcome,
            refreshTokenEncrypted:
              outcome.refreshTokenEncrypted ?? grant.tokens.refreshTokenEncrypted,
          };
        return { state: { ...state, grant: next }, result: true };
      }),
  };
}
export type McpOAuthRepository = ReturnType<typeof createMcpOAuthRepository>;
