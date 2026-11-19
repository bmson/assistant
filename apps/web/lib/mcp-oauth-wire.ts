/** Owner-facing lifecycle data. Provider secrets and callback parameters stay on the server. */
export type McpOAuthClient = 'web' | 'ios';

export interface McpOAuthStatus {
  connectionId: string;
  /** True only when the server can offer this connection a complete sign-in lifecycle. */
  signInAvailable: boolean;
  grant: 'none' | 'authorized' | 'reauthorization_required';
  grantGeneration?: string | null;
  /** Present only after an explicit provider check. */
  providerAvailable?: boolean;
}

export interface McpOAuthStart {
  connectionId: string;
  flowId: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface McpOAuthFlow {
  connectionId: string;
  flowId: string;
  outcome:
    | 'pending'
    | 'processing'
    | 'authorized'
    | 'denied'
    | 'cancelled'
    | 'expired'
    | 'failed'
    | 'superseded';
}

export const mcpOAuthIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Fixed web return path and native completion route. Only opaque IDs cross the boundary. */
export const mcpOAuthWebReturn = '/settings';
export const mcpOAuthNativeReturn = 'assistant-oauth://mcp/callback';

export interface McpOAuthManagementService {
  status(ownerId: string, connectionId: string): Promise<McpOAuthStatus | null>;
  verifyProvider(ownerId: string, connectionId: string): Promise<McpOAuthStatus | null>;
  start(
    ownerId: string,
    connectionId: string,
    client: McpOAuthClient,
  ): Promise<McpOAuthStart | null>;
  flow(
    ownerId: string,
    connectionId: string,
    flowId: string,
    cancel: boolean,
  ): Promise<McpOAuthFlow | null>;
  disconnect(ownerId: string, connectionId: string): Promise<McpOAuthStatus | null>;
  callback(params: URLSearchParams): Promise<{ client: McpOAuthClient; flowId: string } | null>;
}
