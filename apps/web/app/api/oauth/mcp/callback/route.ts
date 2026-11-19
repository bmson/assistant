import { mcpOAuthCallback } from '@/lib/mcp-oauth-http';
import { getMcpOAuthManagementService } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const GET = mcpOAuthCallback(getMcpOAuthManagementService);
