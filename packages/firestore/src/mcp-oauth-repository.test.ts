import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mcpOAuthStorageScenarios,
  mcpTestConnected,
  mcpTestEndpoint,
  mcpTestManualBearer,
  mcpTestPending,
} from '../../persistence/src/mcp-oauth-test-scenarios.js';
import {
  FirestoreMcpConnectionMutationRepository,
  FirestoreMcpConnectionReadRepository,
} from './mcp-connections.js';
import { createFirestoreMcpOAuthRepository } from './mcp-oauth-repository.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore MCP OAuth storage', () => {
  let store: InstallationStore;
  let ownerId: string;
  let connectionId: string;
  beforeEach(async () => {
    store = emulatorStore();
    ownerId = randomUUID();
    connectionId = randomUUID();
    await store.doc('agents', ownerId).set({ id: ownerId });
    await store.doc('mcpConnections', connectionId).set({
      id: connectionId,
      agentId: ownerId,
      name: connectionId,
      endpoint: mcpTestEndpoint,
      bearerTokenEncrypted: mcpTestManualBearer,
      enabled: true,
    });
  });
  afterEach(async () => disposeStore(store));
  mcpOAuthStorageScenarios(() => ({
    key: { ownerId, connectionId },
    repo: createFirestoreMcpOAuthRepository(store, ownerId),
    reopened: createFirestoreMcpOAuthRepository(store, ownerId),
    async setEnabled(enabled) {
      await new FirestoreMcpConnectionMutationRepository(store, ownerId).setEnabled(
        connectionId,
        enabled,
      );
    },
    async readManualBearer() {
      return (await store.doc('mcpConnections', connectionId).get()).get('bearerTokenEncrypted');
    },
  }));
  it('blocks manual discovery reads and stale saves while exposing OAuth state only to private readers', async () => {
    const mutations = new FirestoreMcpConnectionMutationRepository(store, ownerId);
    const reads = new FirestoreMcpConnectionReadRepository(store, ownerId);
    const repo = createFirestoreMcpOAuthRepository(store, ownerId);
    const flow = mcpTestPending();
    const now = new Date(Date.parse(flow.expiresAt) - 1);
    const key = { ownerId, connectionId };
    expect(await repo.begin(key, flow, now)).toBe(true);
    const pending = await mutations.beginDiscovery(connectionId);
    if (!pending) throw new Error('Expected manual discovery before the grant');
    await repo.consume(key, mcpTestEndpoint, flow.id, flow.stateHash, now);
    expect(await repo.finish(key, mcpTestEndpoint, flow.id, mcpTestConnected, now)).toBe(true);
    expect(await mutations.beginDiscovery(connectionId)).toBeNull();
    expect(
      await mutations.saveDiscovery(connectionId, pending.attemptId, {
        status: 'error',
        serverName: null,
        serverVersion: null,
        instructions: null,
        tools: [],
        error: 'stale',
      }),
    ).toBe(false);
    expect(await reads.getForTools(ownerId, connectionId)).toHaveProperty(
      'oauthState.grant.generation',
      flow.id,
    );
    expect((await reads.list(ownerId))[0]).not.toHaveProperty('oauthState');
    expect(await repo.disconnect(key, mcpTestEndpoint)).toBe(true);
    expect(await mutations.beginDiscovery(connectionId)).toMatchObject({
      endpoint: mcpTestEndpoint,
    });
  });
});
