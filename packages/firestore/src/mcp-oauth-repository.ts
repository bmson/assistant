import { createMcpOAuthRepository, parseMcpOAuthState, type Records } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

export function createFirestoreMcpOAuthRepository(
  store: InstallationStore,
  configuredOwnerId: string,
) {
  return createMcpOAuthRepository({
    async update(key, endpoint, change, options) {
      if (!configuredOwnerId || key.ownerId !== configuredOwnerId) return null;
      return store.db.runTransaction(async (tx) => {
        const owners = await tx.get(store.collection('agents').limit(2));
        const owner = owners.docs[0];
        if (
          owners.size !== 1 ||
          owner?.id !== documentKey(key.ownerId) ||
          owner.get('id') !== key.ownerId
        )
          return null;
        const erasure = await tx.get(store.doc('privacyErasureJobs', key.ownerId));
        if (
          erasure.exists &&
          (erasure.get('agentId') !== key.ownerId || privacyErasureIsActive(erasure.get('status')))
        )
          throw new Error('Privacy erasure is in progress');
        const ref = store.doc('mcpConnections', key.connectionId);
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return null;
        const row = decodeRecord<Records['mcpConnections']>(snapshot.data());
        if (
          row.id !== key.connectionId ||
          row.agentId !== key.ownerId ||
          (row.enabled !== true && !options?.allowDisabled) ||
          row.endpoint !== endpoint
        )
          return null;
        const before = parseMcpOAuthState(row.oauthState, key, endpoint);
        const { state, result } = change(before);
        if (state !== before) {
          const parsed = parseMcpOAuthState(state, key, endpoint);
          tx.update(ref, encodeRecord({ oauthState: parsed }));
        }
        return result;
      });
    },
  });
}
