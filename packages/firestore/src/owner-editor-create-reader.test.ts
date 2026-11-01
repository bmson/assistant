import { randomUUID } from 'node:crypto';
import {
  OWNER_EDITOR_COMMANDS,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';

describe('retained receipt recovery through real Firestore repository with fake transactions', () => {
  it.each(OWNER_EDITOR_COMMANDS)(
    'reads and reconciles the original %s without writing',
    async (command) => {
      const f = ownerEditorTestStore();
      const now = new Date();
      const ownerId = randomUUID();
      const scope: OwnerEditorScope = {
        ownerId,
        epoch: randomUUID(),
        command,
        operationId: randomUUID(),
        targetId: command === 'create_person' ? null : randomUUID(),
        privacyGeneration: null,
        sessionDigest: 'a'.repeat(64),
        nonce: randomUUID(),
        issuedAt: now.getTime(),
        expiresAt: now.getTime() + 600_000,
      };
      const ids = command.includes('memory')
        ? { memoryId: randomUUID() }
        : command.includes('family')
          ? { relationId: randomUUID(), memoryId: randomUUID(), assertionId: randomUUID() }
          : { contactId: randomUUID() };
      const result = { outcome: 'saved', ids, revision: 'c'.repeat(64) };
      f.seed('agents', ownerId, { id: ownerId });
      f.seed('maintenanceCursors', `owner-editor-epoch:${ownerId}`, {
        name: `owner-editor-epoch:${ownerId}`,
        cursor: JSON.stringify({
          ownerId,
          epoch: scope.epoch,
          ready: true,
          privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        }),
      });
      f.seed('ownerEditorOperations', ownerEditorOperationId(scope), {
        id: ownerEditorOperationId(scope),
        ownerId,
        epoch: scope.epoch,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        operationId: scope.operationId,
        requestHash: 'b'.repeat(64),
        scopeDigest: ownerEditorScopeDigest(scope),
        command,
        protocolVersion: 1,
        formIssuedAt: now,
        formExpiresAt: new Date(scope.expiresAt),
        status: 'committed',
        statusVersion: 2,
        claimToken: null,
        claimExpiresAt: null,
        result,
        createdAt: now,
        updatedAt: now,
      });
      const repository = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
      const expected = {
        version: 1,
        authority: 'operation_receipt',
        command,
        operationId: scope.operationId,
        requestHash: 'b'.repeat(64),
        statusVersion: 2,
        ...result,
      };
      expect((await repository.lookup(scope, now)).reply).toEqual(expected);
      expect(
        await repository.reconcile(
          {
            scope,
            requestHash: 'b'.repeat(64),
            claimIdentityDigest: 'd'.repeat(64),
            statusVersion: 2,
            issuedAt: now.getTime(),
            expiresAt: now.getTime() + 120_000,
          },
          now,
        ),
      ).toEqual(expected);
      expect(f.stats.writes).toEqual([]);
    },
  );
});
