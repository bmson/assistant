/** The installation URL is configured by the owner. Request headers never select a callback. */
export function mcpOAuthClientMetadata(authUrl: string) {
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    return null;
  }
  return {
    client_id: new URL('/api/oauth/mcp/client-metadata', url).href,
    client_name: 'Assistant',
    redirect_uris: [new URL('/api/oauth/mcp/callback', url).href],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
