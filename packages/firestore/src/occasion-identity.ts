import { createHash } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import type { DocumentReference, DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { documentKey, type InstallationStore } from './store.js';

type Occasion = Records['occasions'];
export type OccasionIdentity = Pick<Occasion, 'contactId' | 'kind' | 'month' | 'day'>;

export function occasionDateKeyId(agentId: string, identity: OccasionIdentity): string {
  return createHash('sha256')
    .update(
      [agentId, identity.contactId, identity.kind, identity.month, identity.day].join('\u0000'),
    )
    .digest('hex');
}

export function occasionDateKeyRef(
  store: InstallationStore,
  agentId: string,
  identity: OccasionIdentity,
): DocumentReference {
  return store.doc('occasionDateKeys', occasionDateKeyId(agentId, identity));
}

export function occasionDateKey(agentId: string, identity: OccasionIdentity, occasionId: string) {
  return {
    agentId,
    ...identity,
    id: occasionDateKeyId(agentId, identity),
    occasionId,
  };
}

/** A corrected-away tuple remains fenced so stale imports cannot recreate it. */
export function supersededOccasionDateKey(
  agentId: string,
  identity: OccasionIdentity,
  occasionId: string,
) {
  return { ...occasionDateKey(agentId, identity, occasionId), superseded: true };
}

/** Resolve the unique tuple while supporting pre-marker legacy occasions. */
export async function resolveOccasionIdentity(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
  identity: OccasionIdentity,
): Promise<{
  snapshot: DocumentSnapshot | null;
  markerRef: DocumentReference;
  markerExists: boolean;
  ambiguous: boolean;
  superseded: boolean;
  supersededOccasionId?: string;
}> {
  const markerRef = occasionDateKeyRef(store, agentId, identity);
  const query = store
    .collection('occasions')
    .where('agentId', '==', agentId)
    .where('contactId', '==', identity.contactId)
    .where('kind', '==', identity.kind)
    .where('month', '==', identity.month)
    .where('day', '==', identity.day)
    .limit(2);
  const [marker, matches] = await Promise.all([tx.get(markerRef), tx.get(query)]);
  if (matches.size > 1 && !marker.exists)
    return { snapshot: null, markerRef, markerExists: false, ambiguous: true, superseded: false };
  const match = matches.docs[0] ?? null;
  if (marker.exists) {
    const data = marker.data() ?? {};
    if (
      data.agentId !== agentId ||
      data.id !== occasionDateKeyId(agentId, identity) ||
      documentKey(String(data.id ?? '')) !== markerRef.id ||
      data.contactId !== identity.contactId ||
      data.kind !== identity.kind ||
      data.month !== identity.month ||
      data.day !== identity.day ||
      typeof data.occasionId !== 'string'
    )
      throw new Error(
        `Occasion date marker is malformed: ${JSON.stringify({ data, agentId, identity, refId: markerRef.id, expectedId: occasionDateKeyId(agentId, identity) })}`,
      );
    if (data.superseded === true) {
      return {
        snapshot: null,
        markerRef,
        markerExists: true,
        ambiguous: false,
        superseded: true,
        supersededOccasionId: data.occasionId,
      };
    }
    const linked = await tx.get(store.doc('occasions', data.occasionId));
    if (!linked.exists) throw new Error('Occasion date marker points to a missing record');
    const row = linked.data() ?? {};
    if (
      row.id !== data.occasionId ||
      row.agentId !== agentId ||
      row.contactId !== identity.contactId ||
      row.kind !== identity.kind ||
      row.month !== identity.month ||
      row.day !== identity.day ||
      (matches.size === 1 && match && match.id !== linked.id)
    )
      throw new Error('Occasion date marker conflicts with its record');
    return {
      snapshot: matches.size > 1 ? null : linked,
      markerRef,
      markerExists: true,
      ambiguous: matches.size > 1,
      superseded: false,
    };
  }
  return { snapshot: match, markerRef, markerExists: false, ambiguous: false, superseded: false };
}
