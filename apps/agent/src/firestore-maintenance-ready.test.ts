import { documentKey } from '@assistant/firestore';
import { describe, expect, it } from 'vitest';
import { firestoreMaintenanceReady } from './firestore-maintenance-ready.js';

function storeWith(
  owner: Record<string, unknown> | null,
  migration: Record<string, unknown> | null,
  otherOwner?: Record<string, unknown>,
) {
  const owners = [owner, otherOwner].filter((row): row is Record<string, unknown> => Boolean(row));
  return {
    collection: () => ({
      limit: () => ({
        get: async () => ({
          size: owners.length,
          empty: owners.length === 0,
          docs: owners.map((row) => ({
            id: documentKey(String(row.id)),
            get: (field: string) => row[field],
          })),
        }),
      }),
    }),
    doc: (collection: string) => ({
      get: async () => {
        const data = collection === 'agents' ? owner : migration;
        return {
          exists: data !== null,
          get: (field: string) => data?.[field],
        };
      },
    }),
  } as never;
}

describe('firestoreMaintenanceReady', () => {
  it('allows a matching owner on a fresh installation with no migration marker', async () => {
    await expect(
      firestoreMaintenanceReady(storeWith({ id: 'agent-1' }, null), 'agent-1'),
    ).resolves.toBe(true);
  });

  it('blocks a missing or mismatched owner', async () => {
    await expect(firestoreMaintenanceReady(storeWith(null, null), 'agent-1')).resolves.toBe(false);
    await expect(
      firestoreMaintenanceReady(storeWith({ id: 'other-agent' }, null), 'agent-1'),
    ).resolves.toBe(false);
  });

  it('blocks maintenance when a configured ID hides a second owner', async () => {
    await expect(
      firestoreMaintenanceReady(
        storeWith({ id: 'agent-1' }, { status: 'active' }, { id: 'agent-2' }),
        'agent-1',
      ),
    ).resolves.toBe(false);
  });

  it('blocks an imported workspace until its migration marker is active', async () => {
    await expect(
      firestoreMaintenanceReady(
        storeWith({ id: 'agent-1' }, { status: 'pending_activation' }),
        'agent-1',
      ),
    ).resolves.toBe(false);
    await expect(
      firestoreMaintenanceReady(storeWith({ id: 'agent-1' }, { status: 'active' }), 'agent-1'),
    ).resolves.toBe(true);
  });
});
