import { mcpOAuthManagement } from '@/lib/mcp-oauth-http';
import { getMcpOAuthManagementService } from '@/lib/server';

export const dynamic = 'force-dynamic';
const { flow } = mcpOAuthManagement(getMcpOAuthManagementService);

export const GET = flow;
export const DELETE = flow;
