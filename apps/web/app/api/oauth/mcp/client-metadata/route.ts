import { loadConfig } from '@assistant/config';
import { mcpOAuthClientMetadata } from '@/lib/mcp-oauth-client-metadata';

export const dynamic = 'force-dynamic';

export function GET() {
  const metadata = mcpOAuthClientMetadata(loadConfig().AUTH_URL);
  return metadata
    ? Response.json(metadata)
    : Response.json({ error: 'Client metadata unavailable.' }, { status: 404 });
}
