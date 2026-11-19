import { describe, expect, it } from 'vitest';
import type { McpOAuthServer } from './mcp-oauth.js';
import {
  type McpOAuthRegistration,
  parseMcpOAuthRegistrations,
  resolveMcpOAuthClient,
} from './mcp-oauth-registration.js';

const hostedClientId = 'https://assistant.example/.well-known/mcp-oauth-client';
const redirectUri = 'https://assistant.example/api/oauth/mcp/callback';
const server: McpOAuthServer = {
  issuer: 'https://issuer.example/tenant',
  resource: 'https://mcp.example/mcp',
  authorizationEndpoint: 'https://issuer.example/oauth/authorize',
  tokenEndpoint: 'https://issuer.example/oauth/token',
  authorizationResponseIssuerRequired: true,
  clientIdMetadataDocument: true,
  tokenEndpointAuthMethods: ['none', 'client_secret_basic'],
};
const registration: McpOAuthRegistration = {
  issuer: server.issuer,
  resource: server.resource,
  authorizationEndpoint: server.authorizationEndpoint,
  tokenEndpoint: server.tokenEndpoint,
  redirectUri,
  clientId: 'registered-client',
  tokenEndpointAuthMethod: 'client_secret_basic',
  clientSecret: 'synthetic-secret',
};

describe('trusted MCP OAuth client registrations', () => {
  it('defaults to the installation’s hosted public client', () => {
    expect(parseMcpOAuthRegistrations('')).toEqual([]);
    expect(resolveMcpOAuthClient(server, { hostedClientId, redirectUri })).toEqual({
      clientId: hostedClientId,
      tokenEndpointAuthMethod: 'none',
    });
    expect(
      resolveMcpOAuthClient(
        { ...server, clientIdMetadataDocument: false },
        { hostedClientId, redirectUri },
      ),
    ).toBeNull();
  });

  it('uses the explicit confidential registration when discovery and redirect match', () => {
    const registrations = parseMcpOAuthRegistrations(JSON.stringify([registration]));
    expect(
      resolveMcpOAuthClient(
        { ...server, clientIdMetadataDocument: false },
        { hostedClientId, redirectUri, registrations },
      ),
    ).toEqual({
      clientId: registration.clientId,
      tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
      clientSecret: registration.clientSecret,
    });
  });

  it.each([
    { issuer: 'https://other-issuer.example' },
    { authorizationEndpoint: 'https://issuer.example/changed-authorize' },
    { tokenEndpoint: 'https://untrusted.example/token' },
    { authorizationResponseIssuerRequired: false },
    { tokenEndpointAuthMethods: ['none'] },
  ])('blocks returning the secret or switching to the hosted client after drift (%j)', (drift) => {
    expect(
      resolveMcpOAuthClient(
        { ...server, ...drift },
        { hostedClientId, redirectUri, registrations: [registration] },
      ),
    ).toBeNull();
  });

  it('rejects a different redirect URI for an explicitly registered resource', () => {
    expect(
      resolveMcpOAuthClient(server, {
        hostedClientId,
        redirectUri: `${redirectUri}/other`,
        registrations: [registration],
      }),
    ).toBeNull();
  });

  it('does not substitute clients during code exchange or refresh', () => {
    expect(
      resolveMcpOAuthClient(server, {
        hostedClientId,
        redirectUri,
        expectedClientId: registration.clientId,
        expectedTokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
      }),
    ).toBeNull();
    expect(
      resolveMcpOAuthClient(server, {
        hostedClientId,
        redirectUri,
        registrations: [registration],
        expectedClientId: hostedClientId,
        expectedTokenEndpointAuthMethod: 'none',
      }),
    ).toBeNull();
    expect(
      resolveMcpOAuthClient(server, {
        hostedClientId,
        redirectUri,
        registrations: [registration],
        expectedClientId: registration.clientId,
        expectedTokenEndpointAuthMethod: 'client_secret_post',
      }),
    ).toBeNull();
  });

  it('allows the hosted client for a different resource without sharing a registered secret', () => {
    expect(
      resolveMcpOAuthClient(
        { ...server, resource: 'https://other-mcp.example/mcp' },
        { hostedClientId, redirectUri, registrations: [registration] },
      ),
    ).toEqual({ clientId: hostedClientId, tokenEndpointAuthMethod: 'none' });
  });

  it.each([
    [registration, registration],
    [{ ...registration, tokenEndpoint: 'https://issuer.example/token?private=value' }],
    [{ ...registration, tokenEndpointAuthMethod: 'none' }],
    [{ ...registration, clientSecret: undefined }],
  ])('rejects malformed and ambiguous configuration with a fixed error', (...entries) => {
    expect(() => parseMcpOAuthRegistrations(JSON.stringify(entries))).toThrow(
      /^MCP authorization failed: unsupported_client\.$/,
    );
  });

  it('rejects registrations that reuse the hosted client ID', () => {
    expect(() =>
      resolveMcpOAuthClient(server, {
        hostedClientId,
        redirectUri,
        registrations: [{ ...registration, clientId: hostedClientId }],
      }),
    ).toThrow(/^MCP authorization failed: unsupported_client\.$/);
  });
});
