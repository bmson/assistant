import { createMcpOAuthRepository, parseMcpOAuthState } from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, mcpConnections } from './schema.js';

/**
 * Read only a boolean. The row-to-JSON lookup also works before migration 0138,
 * where this key is absent. An installed grant always blocks manual fallback.
 */
export function manualMcpCredentialAvailable() {
  const state = sql`(to_jsonb(${mcpConnections}) -> 'oauth_state')`;
  return sql<boolean>`COALESCE(
    ${state} IS NULL OR ${state} = 'null'::jsonb OR (
      ${state} -> 'version' = '1'::jsonb
      AND ${state} ->> 'ownerId' = ${mcpConnections.agentId}::text
      AND ${state} ->> 'connectionId' = ${mcpConnections.id}::text
      AND ${state} -> 'grant' = 'null'::jsonb
    ), FALSE
  )`;
}

export function createPostgresMcpOAuthRepository(db: Db) {
  return createMcpOAuthRepository({
    update: (key, endpoint, change, options) =>
      db.transaction(async (tx) => {
        const owners = await tx.select({ id: agents.id }).from(agents).limit(2).for('share');
        if (owners.length !== 1 || owners[0]?.id !== key.ownerId) return null;
        const where = and(
          eq(mcpConnections.id, key.connectionId),
          eq(mcpConnections.agentId, key.ownerId),
        );
        const [row] = await tx
          .select({
            endpoint: mcpConnections.endpoint,
            enabled: mcpConnections.enabled,
            oauthState: mcpConnections.oauthState,
          })
          .from(mcpConnections)
          .where(where)
          .for('update');
        if (!row || row.endpoint !== endpoint || (!row.enabled && !options?.allowDisabled))
          return null;
        const before = parseMcpOAuthState(row.oauthState, key, endpoint);
        const { state, result } = change(before);
        if (state !== before) {
          const parsed = parseMcpOAuthState(state, key, endpoint);
          await tx
            .update(mcpConnections)
            .set({
              oauthState: parsed,
            })
            .where(where);
        }
        return result;
      }),
  });
}
