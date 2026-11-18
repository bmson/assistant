import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe } from 'vitest';
import {
  mcpOAuthStorageScenarios,
  mcpTestEndpoint,
  mcpTestManualBearer,
} from '../../persistence/src/mcp-oauth-test-scenarios.js';
import { FirestoreMcpConnectionMutationRepository } from './mcp-connections.js';
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
});
