import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe } from 'vitest';
import {
  mcpOAuthStorageScenarios,
  mcpTestEndpoint,
  mcpTestManualBearer,
} from '../../persistence/src/mcp-oauth-test-scenarios.js';
import { createDb, type Db } from './client.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import { createPostgresMcpOAuthRepository } from './mcp-oauth-repository.js';
import { mcpConnections } from './schema.js';

describe('PostgreSQL MCP OAuth storage', () => {
  let db: Db;
  let ownerId: string;
  let connectionId: string;
  beforeEach(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    db = createDb(url);
    ownerId = await assertPostgresInstallationOwner(db);
    connectionId = randomUUID();
    await db.insert(mcpConnections).values({
      id: connectionId,
      agentId: ownerId,
      name: connectionId,
      endpoint: mcpTestEndpoint,
      bearerTokenEncrypted: mcpTestManualBearer,
    });
  });
  afterEach(async () => {
    if (connectionId) await db.delete(mcpConnections).where(eq(mcpConnections.id, connectionId));
    await db?.$client.end();
  });
  mcpOAuthStorageScenarios(() => ({
    key: { ownerId, connectionId },
    repo: createPostgresMcpOAuthRepository(db),
    reopened: createPostgresMcpOAuthRepository(db),
    async setEnabled(enabled) {
      await db.update(mcpConnections).set({ enabled }).where(eq(mcpConnections.id, connectionId));
    },
    async readManualBearer() {
      const [row] = await db
        .select({ bearer: mcpConnections.bearerTokenEncrypted })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, connectionId));
      return row?.bearer;
    },
  }));
});
