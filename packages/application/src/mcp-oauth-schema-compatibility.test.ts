import { createDb, type Db, mcpConnections } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import {
  createMcpConnection,
  getMcpConnection,
  listMcpConnections,
  saveMcpDiscovery,
  setMcpConnectionEnabled,
} from './mcp.js';

it('keeps legacy MCP operations usable without the optional OAuth storage column', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const rollback = new Error('Roll back the schema compatibility fixture');
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DROP TRIGGER mcp_connections_fence_oauth ON mcp_connections`);
      await tx.execute(sql`ALTER TABLE mcp_connections DROP COLUMN oauth_state`);
      // The legacy operations use only the transaction's inherited query methods.
      const legacy = tx as unknown as Db;
      const endpoint = 'https://mcp.example.invalid/mcp';
      const { connectionId } = await createMcpConnection(legacy, {
        name: 'Legacy MCP fixture',
        endpoint,
      });
      if (!connectionId) throw new Error('Legacy connection was not created');
      const bearer = 'preexisting-manual-ciphertext';
      await tx
        .update(mcpConnections)
        .set({ bearerTokenEncrypted: bearer })
        .where(eq(mcpConnections.id, connectionId));
      expect(await saveMcpDiscovery(legacy, connectionId, { status: 'ready', tools: [] })).toBe(
        true,
      );
      expect(await listMcpConnections(legacy)).toContainEqual(
        expect.objectContaining({ id: connectionId, status: 'ready', hasBearerToken: true }),
      );
      expect(await setMcpConnectionEnabled(legacy, connectionId, false)).toBe(true);
      expect(await getMcpConnection(legacy, connectionId)).toEqual({
        id: connectionId,
        endpoint,
        bearerTokenEncrypted: bearer,
      });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await db.$client.end();
  }
});
