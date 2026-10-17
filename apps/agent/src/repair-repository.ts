import type { RepairRepositoryReader } from '@assistant/core/workflow/self-repair';
import { mcpConnections } from '@assistant/db';
import { FirestoreMcpConnectionReadRepository } from '@assistant/firestore';
import { repairPathBlocked } from '@assistant/persistence';
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
    let rows: McpToolConnectionRecord[];
    if (deps.firestoreStore) {
      const repository = new FirestoreMcpConnectionReadRepository(
        deps.firestoreStore,
        deps.config.FIRESTORE_AGENT_ID,
      );
      const summaries = await repository.list(agentId);
      rows = (
        await Promise.all(
          summaries
            .filter(
              (r) =>
                r.enabled &&
                r.status === 'ready' &&
                r.endpoint === 'https://api.githubcopilot.com/mcp/',
            )
            .map((r) => repository.getForTools(agentId, r.id)),
        )
      ).filter((row): row is NonNullable<typeof row> => row !== null);
    } else {
      rows = await deps.db
        .select()
        .from(mcpConnections)
        .where(
          and(
            eq(mcpConnections.agentId, agentId),
            eq(mcpConnections.enabled, true),
            eq(mcpConnections.status, 'ready'),
          ),
        );
    }
    const connection = rows.find(
      (r) =>
        r.enabled &&
        r.status === 'ready' &&
        r.endpoint === 'https://api.githubcopilot.com/mcp/' &&
        Array.isArray(r.tools) &&
        r.tools.some((t: { name?: string }) => t.name === 'get_file_contents'),
    );
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
        const result = await invoke(
          connection.endpoint,
          'get_file_contents',
          { owner, repo, path },
          connection.bearerTokenEncrypted,
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
