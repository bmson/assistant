import { describe, expect, it } from 'vitest';
import { mcpOAuthClientMetadata } from './mcp-oauth-client-metadata';

describe('hosted MCP OAuth public client', () => {
  it('binds the client identifier and sole callback to the configured installation', () => {
    expect(mcpOAuthClientMetadata('https://assistant.example:444/')).toMatchObject({
      client_id: 'https://assistant.example:444/api/oauth/mcp/client-metadata',
      redirect_uris: ['https://assistant.example:444/api/oauth/mcp/callback'],
      token_endpoint_auth_method: 'none',
    });
  });
  it.each(['http://localhost', 'https://user@example.org', 'https://example.org/other', 'invalid'])(
    'declines unsuitable installation URL %s',
    (url) => expect(mcpOAuthClientMetadata(url)).toBeNull(),
  );
});
