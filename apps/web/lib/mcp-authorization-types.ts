/** Browser-safe wire DTO. All checks are transient and never establish a grant. */
export type McpAuthorizationStatus = 'supported' | 'unsupported' | 'discovery_failed';
export interface McpAuthorizationServerDiagnostic {
  issuer: string;
  pkceS256: true;
  authorizationResponseIssuerRequired: boolean;
  registration: {
    preRegistration: 'not_checked';
    clientIdMetadataDocument: boolean;
    dynamicClientRegistration: boolean;
  };
}
export interface McpAuthorizationDiagnostic {
  status: McpAuthorizationStatus;
  authenticated: false;
  oauthConnectionSupported: false;
  transportProtocolVersion: '2025-11-25';
  resource: string | null;
  authorizationServers: McpAuthorizationServerDiagnostic[];
  reason: string | null;
}
