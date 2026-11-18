import { z } from 'zod';
import { MCP_AUTHORIZATION_LIMITS } from './mcp-authorization.js';
import { type McpOAuthClient, McpOAuthError, type McpOAuthServer } from './mcp-oauth.js';

function exactHttpsUrl(value: string): boolean {
  if (!/^https:\/\//i.test(value) || /[^\x21-\x7e]|\\/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(value);
  } catch {
    return false;
  }
}

const httpsUrl = z.string().max(MCP_AUTHORIZATION_LIMITS.maxUrlLength).refine(exactHttpsUrl);
const registrationSchema = z
  .strictObject({
    issuer: httpsUrl,
    resource: httpsUrl,
    authorizationEndpoint: httpsUrl,
    tokenEndpoint: httpsUrl,
    redirectUri: httpsUrl,
    clientId: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[\x20-\x7e]+$/),
    tokenEndpointAuthMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post']),
    clientSecret: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x20-\x7e]+$/)
      .optional(),
  })
  .refine(
    (registration) =>
      (registration.tokenEndpointAuthMethod === 'none') ===
      (registration.clientSecret === undefined),
  );
const registrationsSchema = z.array(registrationSchema).max(64);

export type McpOAuthRegistration = Readonly<z.infer<typeof registrationSchema>>;

/** Read trusted installation config. Do not include source values or schema errors in logs. */
export function parseMcpOAuthRegistrations(value?: string): readonly McpOAuthRegistration[] {
  if (!value) return [];
  if (value.length > 65_536) throw new McpOAuthError('unsupported_client');
  try {
    const parsed = registrationsSchema.safeParse(JSON.parse(value));
    if (parsed.success) {
      const keys = new Set(
        parsed.data.map(({ issuer, resource, redirectUri }) =>
          JSON.stringify([issuer, resource, redirectUri]),
        ),
      );
      if (keys.size === parsed.data.length) return parsed.data;
    }
  } catch {
    // Report a fixed error without any environment values or parsing details.
  }
  throw new McpOAuthError('unsupported_client');
}

export function resolveMcpOAuthClient(
  server: McpOAuthServer,
  options: {
    hostedClientId: string;
    redirectUri: string;
    registrations?: readonly McpOAuthRegistration[];
    expectedClientId?: string;
    expectedTokenEndpointAuthMethod?: McpOAuthClient['tokenEndpointAuthMethod'];
  },
): McpOAuthClient | null {
  const registrations = options.registrations ?? [];
  if (registrations.some((entry) => entry.clientId === options.hostedClientId))
    throw new McpOAuthError('unsupported_client');
  // A configured resource uses its trusted registrations exclusively. Drift
  // in the issuer, endpoints, or redirect URI cannot activate a public fallback.
  const forResource = registrations.filter((entry) => entry.resource === server.resource);
  const matching = forResource.filter(
    (entry) =>
      entry.issuer === server.issuer &&
      entry.authorizationEndpoint === server.authorizationEndpoint &&
      entry.tokenEndpoint === server.tokenEndpoint &&
      entry.redirectUri === options.redirectUri,
  );
  if (matching.length > 1) throw new McpOAuthError('unsupported_client');
  if (!server.authorizationResponseIssuerRequired) return null;

  let client: McpOAuthClient;
  const registration = matching[0];
  if (registration) {
    const { clientId, clientSecret, tokenEndpointAuthMethod } = registration;
    client = { clientId, tokenEndpointAuthMethod };
    if (clientSecret !== undefined) client.clientSecret = clientSecret;
  } else {
    if (forResource.length || !server.clientIdMetadataDocument) return null;
    client = { clientId: options.hostedClientId, tokenEndpointAuthMethod: 'none' };
  }

  if (
    !server.tokenEndpointAuthMethods.includes(client.tokenEndpointAuthMethod) ||
    (options.expectedClientId !== undefined && client.clientId !== options.expectedClientId) ||
    (options.expectedTokenEndpointAuthMethod !== undefined &&
      client.tokenEndpointAuthMethod !== options.expectedTokenEndpointAuthMethod)
  )
    return null;
  return client;
}
