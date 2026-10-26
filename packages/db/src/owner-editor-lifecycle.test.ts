import { randomUUID } from 'node:crypto';
import {
  ownerEditorMaintenanceTargetEpochDigest,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { rotateExistingPostgresEditorForErasure } from './owner-editor-lifecycle.js';

function transaction(cursor: unknown) {
  let updated: Record<string, unknown> | null = null;
  const query = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    for() {
      return this;
    },
    limit: async () => [{ cursor: JSON.stringify(cursor) }],
  };
  const tx = {
    select: () => query,
    update: () => ({
      set(values: Record<string, unknown>) {
        updated = values;
        return {
          where: async () => [],
        };
      },
    }),
  };
  return { tx, updated: () => updated };
}

describe('PostgreSQL editor epoch privacy rotations', () => {
  it('rotates the epoch and removes maintenance evidence atomically', async () => {
    const ownerId = randomUUID();
    const oldEpoch = randomUUID();
    const cursor = {
      ownerId,
      epoch: oldEpoch,
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      maintenanceBinder: {
        version: 1,
        operationId: randomUUID(),
        requestDigest: 'a'.repeat(64),
        action: 'enable',
        targetEpochDigest: ownerEditorMaintenanceTargetEpochDigest(oldEpoch),
      },
    };
    const f = transaction(cursor);
    await rotateExistingPostgresEditorForErasure(f.tx as never, ownerId, 'privacy-generation');
    const written = f.updated();
    if (!written) throw new Error('Expected a cursor update');
    const next = JSON.parse(String(written.cursor));
    expect(next.epoch).not.toBe(oldEpoch);
    expect(next.ready).toBe(true);
    expect(next.privacyGenerationDigest).toBe(ownerEditorPrivacyDigest('privacy-generation'));
    expect(next.maintenanceBinder).toBeUndefined();
  });
});
