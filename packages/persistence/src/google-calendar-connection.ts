import { z } from 'zod';

export const GOOGLE_CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const GOOGLE_CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const googleCalendarFlowOutcome = z.enum([
  'pending',
  'processing',
  'connected',
  'denied',
  'cancelled',
  'expired',
  'invalid_grant',
  'invalid_identity',
  'missing_scope',
  'provider_unavailable',
  'superseded',
]);
export type GoogleCalendarFlowOutcome = z.infer<typeof googleCalendarFlowOutcome>;
const instant = z.string().datetime({ offset: true });
const account = z.object({ subject: z.string().min(1), email: z.string().email() }).strict();
export const googleCalendarConnectionSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    adopted: z.boolean(),
    ownerId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    connection: z
      .object({
        id: z.string().uuid(),
        credentialVersion: z.number().int().nonnegative(),
        accessTokenEncrypted: z.string().nullable(),
        accessTokenExpiresAt: instant.nullable(),
        refreshLease: z.object({ id: z.string().uuid(), expiresAt: instant }).strict().nullable(),
        account,
        refreshTokenEncrypted: z.string().min(1),
        scopes: z.array(z.string()),
        status: z.enum(['connected', 'reconnect_required', 'provider_unavailable']),
        connectedAt: instant,
      })
      .strict()
      .nullable(),
    flow: z
      .object({
        id: z.string().uuid(),
        stateHash: z.string().regex(/^[a-f0-9]{64}$/),
        verifierEncrypted: z.string().nullable(),
        nonce: z.string().min(1),
        expiresAt: instant,
        outcome: googleCalendarFlowOutcome,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.connection?.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE) && state.version !== 2)
      ctx.addIssue({
        code: 'custom',
        message: 'Calendar event-write credentials require connection contract version 2',
      });
  });
export type GoogleCalendarConnectionState = z.infer<typeof googleCalendarConnectionSchema>;
export type GoogleCalendarPendingFlow = NonNullable<GoogleCalendarConnectionState['flow']>;
export type GoogleCalendarCredential = NonNullable<GoogleCalendarConnectionState['connection']>;
export interface GoogleCalendarConnectionStorage {
  read(ownerId: string): Promise<GoogleCalendarConnectionState | null>;
  /** Serializes all changes, including creation, for this owner. */
  update<T>(
    ownerId: string,
    change: (state: GoogleCalendarConnectionState) => {
      state: GoogleCalendarConnectionState;
      result: T;
    },
  ): Promise<T>;
}
export type GoogleCalendarRefreshClaim =
  | { kind: 'ready'; credential: GoogleCalendarCredential }
  | { kind: 'claimed'; credential: GoogleCalendarCredential }
  | { kind: 'wait' }
  | { kind: 'disconnected' };
export interface GoogleCalendarConnectionRepository {
  get(ownerId: string): Promise<GoogleCalendarConnectionState | null>;
  begin(
    ownerId: string,
    flow: GoogleCalendarPendingFlow,
    expectedConnectionId?: string,
  ): Promise<void>;
  consume(
    ownerId: string,
    flowId: string,
    stateHash: string,
    now: Date,
  ): Promise<{ flow: GoogleCalendarPendingFlow; revision: number } | null>;
  finish(
    ownerId: string,
    flowId: string,
    revision: number,
    outcome: GoogleCalendarFlowOutcome,
    credential: GoogleCalendarCredential | null,
    now: Date,
    expectedConnectionId?: string,
  ): Promise<boolean>;
  disconnect(ownerId: string): Promise<void>;
  cancel(ownerId: string, flowId: string): Promise<boolean>;
  acquireRefresh(
    ownerId: string,
    generation: string,
    leaseId: string,
    now: Date,
    force: boolean,
    rejectedAccessTokenEncrypted?: string,
  ): Promise<GoogleCalendarRefreshClaim>;
  completeRefresh(
    ownerId: string,
    generation: string,
    leaseId: string,
    credentialVersion: number,
    credential: GoogleCalendarCredential,
  ): Promise<boolean>;
  /** Same connection/version only; rejects active refresh leases and advances credentialVersion. */
  updateCredential(
    ownerId: string,
    revision: number,
    credential: GoogleCalendarCredential,
  ): Promise<boolean>;
}
export function emptyGoogleCalendarConnection(ownerId: string): GoogleCalendarConnectionState {
  return { version: 1, adopted: false, ownerId, revision: 0, connection: null, flow: null };
}
export function parseGoogleCalendarConnection(
  value: unknown,
  ownerId: string,
): GoogleCalendarConnectionState {
  const row = googleCalendarConnectionSchema.parse(value);
  if (row.ownerId !== ownerId) throw new Error('Google Calendar owner mismatch');
  return row;
}
/** Shared transactional rules keep both stores' expiry/replay/revision behavior identical. */
export function createGoogleCalendarConnectionRepository(
  storage: GoogleCalendarConnectionStorage,
): GoogleCalendarConnectionRepository {
  return {
    get: (ownerId) => storage.read(ownerId),
    begin: (ownerId, flow, expectedConnectionId) =>
      storage.update(ownerId, (s) => {
        if (
          expectedConnectionId !== undefined &&
          (s.connection?.id !== expectedConnectionId || s.connection.status !== 'connected')
        )
          throw new Error('Calendar connection changed before access upgrade');
        return { state: { ...s, revision: s.revision + 1, flow }, result: undefined };
      }),
    consume: (ownerId, flowId, stateHash, now) =>
      storage.update(ownerId, (s) => {
        const f = s.flow;
        if (!f || f.id !== flowId || f.stateHash !== stateHash || f.outcome !== 'pending')
          return { state: s, result: null };
        if (Date.parse(f.expiresAt) <= now.getTime())
          return {
            state: { ...s, flow: { ...f, verifierEncrypted: null, outcome: 'expired' } },
            result: null,
          };
        return {
          state: { ...s, flow: { ...f, verifierEncrypted: null, outcome: 'processing' } },
          result: { flow: f, revision: s.revision },
        };
      }),
    finish: (ownerId, flowId, revision, outcome, credential, now, expectedConnectionId) =>
      storage.update(ownerId, (s) => {
        if (s.revision !== revision || s.flow?.id !== flowId || s.flow.outcome !== 'processing')
          return { state: s, result: false };
        if (
          credential &&
          s.connection &&
          credential.account.subject !== s.connection.account.subject
        )
          return { state: s, result: false };
        if (
          credential &&
          expectedConnectionId !== undefined &&
          (!s.connection ||
            s.connection.id !== expectedConnectionId ||
            credential.id !== s.connection.id ||
            !credential.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE))
        )
          return { state: s, result: false };
        const expired = Date.parse(s.flow.expiresAt) <= now.getTime();
        return {
          state: {
            ...s,
            revision: s.revision + 1,
            adopted: s.adopted || (!expired && credential !== null),
            version:
              !expired && credential?.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE) ? 2 : s.version,
            connection:
              !expired && credential
                ? {
                    ...credential,
                    refreshLease: null,
                    credentialVersion:
                      s.connection?.id === credential.id
                        ? s.connection.credentialVersion + 1
                        : credential.credentialVersion,
                  }
                : s.connection,
            flow: { ...s.flow, verifierEncrypted: null, outcome: expired ? 'expired' : outcome },
          },
          result: !expired,
        };
      }),
    disconnect: (ownerId) =>
      storage.update(ownerId, (s) => ({
        state: {
          ...s,
          revision: s.revision + 1,
          connection: null,
          flow: s.flow ? { ...s.flow, verifierEncrypted: null, outcome: 'superseded' } : null,
        },
        result: undefined,
      })),
    cancel: (ownerId, flowId) =>
      storage.update(ownerId, (s) => {
        if (s.flow?.id !== flowId || !['pending', 'processing'].includes(s.flow.outcome))
          return { state: s, result: false };
        return {
          state: {
            ...s,
            revision: s.revision + 1,
            flow: { ...s.flow, verifierEncrypted: null, outcome: 'cancelled' },
          },
          result: true,
        };
      }),
    acquireRefresh: (ownerId, generation, leaseId, now, force, rejectedAccessTokenEncrypted) =>
      storage.update<GoogleCalendarRefreshClaim>(ownerId, (s) => {
        const c = s.connection;
        if (!c || c.id !== generation || c.status === 'reconnect_required')
          return { state: s, result: { kind: 'disconnected' as const } };
        const cached =
          c.accessTokenEncrypted &&
          c.accessTokenExpiresAt &&
          Date.parse(c.accessTokenExpiresAt) > now.getTime() + 60_000;
        if (
          cached &&
          (!force ||
            (rejectedAccessTokenEncrypted !== undefined &&
              rejectedAccessTokenEncrypted !== c.accessTokenEncrypted))
        )
          return { state: s, result: { kind: 'ready' as const, credential: c } };
        if (c.refreshLease && Date.parse(c.refreshLease.expiresAt) > now.getTime())
          return { state: s, result: { kind: 'wait' as const } };
        const credential = {
          ...c,
          refreshLease: { id: leaseId, expiresAt: new Date(now.getTime() + 60_000).toISOString() },
        };
        return {
          state: { ...s, connection: credential },
          result: { kind: 'claimed' as const, credential },
        };
      }),
    completeRefresh: (ownerId, generation, leaseId, credentialVersion, credential) =>
      storage.update(ownerId, (s) => {
        const c = s.connection;
        if (
          !c ||
          c.id !== generation ||
          c.refreshLease?.id !== leaseId ||
          c.credentialVersion !== credentialVersion
        )
          return { state: s, result: false };
        return {
          state: {
            ...s,
            connection: {
              ...credential,
              refreshLease: null,
              credentialVersion: c.credentialVersion + 1,
            },
          },
          result: true,
        };
      }),
    updateCredential: (ownerId, revision, credential) =>
      storage.update(ownerId, (s) => {
        if (
          s.revision !== revision ||
          !s.connection ||
          s.connection.refreshLease !== null ||
          s.connection.id !== credential.id ||
          s.connection.credentialVersion !== credential.credentialVersion ||
          s.connection.account.subject !== credential.account.subject
        )
          return { state: s, result: false };
        return {
          state: {
            ...s,
            connection: { ...credential, credentialVersion: s.connection.credentialVersion + 1 },
          },
          result: true,
        };
      }),
  };
}

/** Portable consent/refresh credentials survive; callback and token execution state does not. */
export function googleCalendarConnectionAfterMigration(
  value: unknown,
  ownerId: string,
): GoogleCalendarConnectionState {
  const state = parseGoogleCalendarConnection(value, ownerId);
  return {
    ...state,
    revision: state.revision + 1,
    connection: state.connection
      ? {
          ...state.connection,
          credentialVersion: state.connection.credentialVersion + 1,
          accessTokenEncrypted: null,
          accessTokenExpiresAt: null,
          refreshLease: null,
        }
      : null,
    flow: state.flow
      ? {
          ...state.flow,
          verifierEncrypted: null,
          outcome: ['pending', 'processing'].includes(state.flow.outcome)
            ? 'superseded'
            : state.flow.outcome,
        }
      : null,
  };
}
