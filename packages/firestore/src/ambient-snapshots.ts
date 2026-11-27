import { randomUUID } from 'node:crypto';
import {
  type AmbientSnapshotRepository,
  type OwnerAmbientSnapshot,
  readHomeWeatherSettings,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { encodeRecord, type InstallationStore } from './store.js';

/**
 * The owner's single ambient snapshot, stored at `ambientSnapshots/{agentId}`,
 * the key `FirestoreOwnerContextRepository.getAmbientSnapshot` reads. A
 * PostgreSQL import keys the same rows by their legacy row ID, where the
 * reader never looks; each write removes those so one snapshot remains.
 */
export class FirestoreAmbientSnapshotRepository implements AmbientSnapshotRepository {
  readonly kind = 'ambient-snapshot-repository' as const;

  constructor(readonly store: InstallationStore) {}

  private async legacy(tx: Transaction, agentId: string) {
    const rows = await tx.get(
      this.store.collection('ambientSnapshots').where('agentId', '==', agentId).limit(20),
    );
    const own = this.store.doc('ambientSnapshots', agentId);
    return rows.docs.filter((doc) => doc.ref.path !== own.path);
  }

  async save(snapshot: OwnerAmbientSnapshot): Promise<void> {
    if (!snapshot.agentId) throw new Error('Ambient snapshot requires an agent');
    const ref = this.store.doc('ambientSnapshots', snapshot.agentId);
    await this.store.db.runTransaction(async (tx) => {
      // Location-derived owner context must not reappear during an erasure.
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, snapshot.agentId);
      const home = (snapshot.sources as { home?: { revision: string } } | null)?.home;
      if (home) {
        const owner = await tx.get(this.store.doc('agents', snapshot.agentId));
        const settings = readHomeWeatherSettings(owner.get('homeWeather'));
        if (
          owner.get('id') !== snapshot.agentId ||
          !settings?.enabled ||
          settings.revision !== home.revision
        )
          throw new Error('Home weather settings changed during refresh');
      }
      const [current, legacy] = await Promise.all([tx.get(ref), this.legacy(tx, snapshot.agentId)]);
      const id =
        (current.exists && typeof current.get('id') === 'string' && current.get('id')) ||
        randomUUID();
      tx.set(
        ref,
        encodeRecord({
          id,
          agentId: snapshot.agentId,
          block: snapshot.block,
          flags: snapshot.flags,
          sources: snapshot.sources,
          computedAt: snapshot.computedAt,
        }),
      );
      for (const doc of legacy) tx.delete(doc.ref);
    });
  }

  async clear(agentId: string): Promise<void> {
    if (!agentId) throw new Error('Ambient snapshot requires an agent');
    const ref = this.store.doc('ambientSnapshots', agentId);
    await this.store.db.runTransaction(async (tx) => {
      const legacy = await this.legacy(tx, agentId);
      tx.delete(ref);
      for (const doc of legacy) tx.delete(doc.ref);
    });
  }
}
