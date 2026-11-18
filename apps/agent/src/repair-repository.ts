import type { RepairRepositoryReader } from '@assistant/core/workflow/self-repair';
import { manualMcpCredentialAvailable, mcpConnections } from '@assistant/db';
import { FirestoreMcpConnectionReadRepository } from '@assistant/firestore';
import { allowsManualMcpCredential, repairPathBlocked } from '@assistant/persistence';
import { invokeMcpTool, type McpToolConnectionRecord } from '@assistant/tools/mcp';
import { and, eq } from 'drizzle-orm';
import type { AgentDeps } from './deps.js';

/** The enabled repair capability permits these bounded reads of its configured source repository only. */
export function repairRepositoryReader(
  deps: AgentDeps,
  invoke = invokeMcpTool,
): RepairRepositoryReader {
  return async (agentId, paths) => {
    const unavailable = { source: 'unavailable' as const, files: [] };
    if (!deps.config.SELF_REPAIR_ENABLED || !/^[\w.-]+\/[\w.-]+$/.test(deps.config.GITHUB_REPO))
      return unavailable;
    const endpoint = 'https://api.githubcopilot.com/mcp/';
    const isRepairConnection = (row: McpToolConnectionRecord) =>
      row.enabled &&
      row.status === 'ready' &&
      row.endpoint === endpoint &&
      Array.isArray(row.tools) &&
      row.tools.some((tool: { name?: string }) => tool?.name === 'get_file_contents');

    const firestore = deps.firestoreStore
      ? new FirestoreMcpConnectionReadRepository(
          deps.firestoreStore,
          deps.config.FIRESTORE_AGENT_ID,
        )
      : null;
    const firestoreManualConnection = async (connectionId: string) => {
      const row = await firestore?.getForTools(agentId, connectionId);
      return row &&
        allowsManualMcpCredential(row.oauthState, { ownerId: agentId, connectionId }, row.endpoint)
        ? row
        : null;
    };
    const postgresManualConnections = async (connectionId?: string) => {
      const rows = await deps.db
        .select({
          id: mcpConnections.id,
          name: mcpConnections.name,
          serverName: mcpConnections.serverName,
          endpoint: mcpConnections.endpoint,
          enabled: mcpConnections.enabled,
          status: mcpConnections.status,
          tools: mcpConnections.tools,
          bearerTokenEncrypted: mcpConnections.bearerTokenEncrypted,
          manualCredentialAvailable: manualMcpCredentialAvailable(),
        })
        .from(mcpConnections)
        .where(
          and(
            eq(mcpConnections.agentId, agentId),
            eq(mcpConnections.enabled, true),
            eq(mcpConnections.status, 'ready'),
            eq(mcpConnections.endpoint, endpoint),
            connectionId ? eq(mcpConnections.id, connectionId) : undefined,
          ),
        );
      return rows.filter((row) => row.manualCredentialAvailable);
    };

    const rows = firestore
      ? await Promise.all(
          (await firestore.list(agentId))
            .filter((row) => row.enabled && row.status === 'ready' && row.endpoint === endpoint)
            .map((row) => firestoreManualConnection(row.id)),
        )
      : await postgresManualConnections();
    const connection = rows.find((row) => row !== null && isRepairConnection(row));
    if (!connection) return unavailable;
    const [owner, repo] = deps.config.GITHUB_REPO.split('/');
    const selected = [...new Set(paths.length ? paths : ['README.md'])]
      .filter(
        (p) => p === 'README.md' || !repairPathBlocked(p, deps.config.SELF_REPAIR_ALLOW_EXECUTOR),
      )
      .slice(0, 3);
    const files: Array<{ path: string; excerpt: string }> = [];
    for (const path of selected) {
      try {
        // A grant can be installed between files. Read the same connection again
        // before each request and never substitute another credential or connection.
        const current = firestore
          ? await firestoreManualConnection(connection.id)
          : (await postgresManualConnections(connection.id)).find(
              (row) => row.id === connection.id,
            );
        if (
          !current ||
          !isRepairConnection(current) ||
          current.bearerTokenEncrypted !== connection.bearerTokenEncrypted
        )
          break;
        const result = await invoke(
          current.endpoint,
          'get_file_contents',
          { owner, repo, path },
          current.bearerTokenEncrypted,
        );
        if (result.isError) continue;
        // The remote output is untrusted source material, bounded before it is
        // persisted or supplied to coding. No original feedback is sent to MCP.
        files.push({ path, excerpt: JSON.stringify(result).slice(0, 4000) });
      } catch {
        /* Missing/invented triage paths are not evidence of a code defect. */
      }
    }
    return {
      source: files.length ? 'github_mcp' : 'unavailable',
      connectionId: connection.id,
      files,
    };
  };
}
