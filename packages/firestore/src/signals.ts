import {
  planSignalWrite,
  prepareBillSignal,
  type Records,
  type Signal,
  type SignalRepository,
  signalQueryTimes,
  signalsValidAt,
} from '@assistant/persistence';
import type { DocumentSnapshot } from '@google-cloud/firestore';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function readSignal(snapshot: DocumentSnapshot, agentId: string): Signal | null {
  if (!snapshot.exists) return null;
  const record = decodeRecord<Signal>(snapshot.data());
  if (record.agentId !== agentId) return null;
  if (documentKey(record.id) !== snapshot.id) throw new Error('Signal identity mismatch');
  return record;
}

export function createFirestoreSignalRepository(store: InstallationStore): SignalRepository {
  return {
    record: (input) =>
      store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, store, input.agentId);
        const snapshot = await tx.get(store.doc('emailIngest', input.emailIngestId));
        const source = decodeRecord<Records['emailIngest'] | undefined>(snapshot.data());
        const signal = prepareBillSignal(input, source);
        const ref = store.doc('signals', signal.id);
        const existing = readSignal(await tx.get(ref), input.agentId);
        const prior = input.replaces
          ? readSignal(await tx.get(store.doc('signals', input.replaces)), input.agentId)
          : null;
        const write = planSignalWrite(input, signal, existing, prior);
        if (write.insert) tx.create(ref, encodeRecord(signal));
        if (write.close)
          tx.update(
            store.doc('signals', write.close.id),
            encodeRecord({
              validTo: write.close.validTo,
              supersededBy: write.close.supersededBy,
            }),
          );
        return write.signal;
      }),
    async get(agentId, id) {
      const fence = await readPrivacyErasureFence(store, agentId);
      const row = readSignal(await store.doc('signals', id).get(), agentId);
      await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
      return row;
    },
    async list(query) {
      const { from, to, asOf } = signalQueryTimes(query);
      const fence = await readPrivacyErasureFence(store, query.agentId);
      const rows = await store
        .collection('signals')
        .where('agentId', '==', query.agentId)
        .where('kind', '==', query.kind)
        .where('subjectPersonIds', 'array-contains', query.personId)
        .where('at', '>=', from)
        .where('at', '<', to)
        .get();
      await assertPrivacyErasureFenceUnchanged(store, query.agentId, fence);
      return signalsValidAt(
        rows.docs.flatMap((doc) => readSignal(doc, query.agentId) ?? []),
        asOf,
      );
    },
  };
}
