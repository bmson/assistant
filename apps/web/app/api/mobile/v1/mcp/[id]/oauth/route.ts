import { mcpOAuthManagement } from '@/lib/mcp-oauth-http';
import { getMcpOAuthManagementService } from '@/lib/server';

export const dynamic = 'force-dynamic';
const { connection } = mcpOAuthManagement(getMcpOAuthManagementService);

export const GET = connection;
export const POST = connection;
export const DELETE = connection;
