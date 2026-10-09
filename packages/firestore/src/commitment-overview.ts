import type { OwnerCommitment } from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 200;
const MAX_ACTIVE_SCAN = 10_000;
const OVERVIEW_LIMIT = 30;

export type FirestoreCommitmentOverviewRow = Pick<
  OwnerCommitment,
  'id' | 'kind' | 'title' | 'details' | 'nextAction' | 'dueAt' | 'status'
>;

async function assertConfiguredOwner(store: InstallationStore, agentId: string): Promise<void> {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('Commitment overview requires exactly one configured agent');
}

/** Strict owner-facing read: malformed active rows may never disappear from the list. */
export async function getFirestoreCommitmentOverview(
  store: InstallationStore,
  configuredAgentId: string,
  now: Date,
): Promise<FirestoreCommitmentOverviewRow[]> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const active: OwnerCommitment[] = [];
  let scanned = 0;
  for (const status of ['open', 'snoozed'] as const) {
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query: Query = store
        .collection('commitments')
        .where('agentId', '==', configuredAgentId)
        .where('status', '==', status)
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        scanned += 1;
        if (scanned > MAX_ACTIVE_SCAN)
          throw new Error('Commitment overview active scan exceeds its limit');
        const row = decodeRecord<OwnerCommitment>(doc.data());
        if (
          row.id === undefined ||
          documentKey(row.id) !== doc.id ||
          row.agentId !== configuredAgentId ||
          row.status !== status ||
          !['decision', 'question', 'promise', 'waiting_on'].includes(row.kind) ||
          typeof row.title !== 'string' ||
          typeof row.details !== 'string' ||
          typeof row.nextAction !== 'string' ||
          (row.dueAt !== null &&
            (!(row.dueAt instanceof Date) || !Number.isFinite(row.dueAt.getTime()))) ||
          !(row.updatedAt instanceof Date) ||
          !Number.isFinite(row.updatedAt.getTime()) ||
          (status === 'snoozed' &&
            (!(row.snoozedUntil instanceof Date) || !Number.isFinite(row.snoozedUntil.getTime())))
        )
          throw new Error('Commitment overview contains a malformed active row');
        if (status === 'open' || (row.snoozedUntil as Date) < now) active.push(row);
      }
      if (page.size < PAGE_SIZE) break;
      cursor = page.docs.at(-1);
    }
  }
  active.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id));
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return active
    .slice(0, OVERVIEW_LIMIT)
    .map(({ id, kind, title, details, nextAction, dueAt, status }) => ({
      id,
      kind,
      title,
      details,
      nextAction,
      dueAt,
      status,
    }));
}

export async function getFirestoreClosedCommitmentOverview(
  store: InstallationStore,
  configuredAgentId: string,
  limit = 12,
): Promise<
  Array<
    Pick<
      OwnerCommitment,
      'id' | 'kind' | 'title' | 'details' | 'nextAction' | 'dueAt' | 'status' | 'updatedAt'
    >
  >
> {
  const boundedLimit = Math.min(Math.max(limit, 1), 30);
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const rows: OwnerCommitment[] = [];
  for (const status of ['resolved', 'dismissed'] as const) {
    const page = await store
      .collection('commitments')
      .where('agentId', '==', configuredAgentId)
      .where('status', '==', status)
      .orderBy('updatedAt', 'desc')
      .limit(boundedLimit)
      .get();
    for (const doc of page.docs) {
      const row = decodeRecord<OwnerCommitment>(doc.data());
      if (
        row.id !== undefined &&
        documentKey(row.id) === doc.id &&
        row.agentId === configuredAgentId &&
        row.status === status &&
        row.resolvedAt instanceof Date &&
        row.updatedAt instanceof Date &&
        ['decision', 'question', 'promise', 'waiting_on'].includes(row.kind) &&
        typeof row.title === 'string' &&
        typeof row.details === 'string' &&
        typeof row.nextAction === 'string'
      )
        rows.push(row);
    }
  }
  const parentIds = rows.map((row) => row.id);
  const alreadyReopened = new Set<string>();
  for (let offset = 0; offset < parentIds.length; offset += 30) {
    const ids = parentIds.slice(offset, offset + 30);
    if (!ids.length) continue;
    const children = await store
      .collection('commitments')
      .where('agentId', '==', configuredAgentId)
      .where('reopenedFromId', 'in', ids)
      .limit(30)
      .get();
    for (const doc of children.docs) {
      const parentId = doc.get('reopenedFromId');
      if (typeof parentId === 'string') alreadyReopened.add(parentId);
    }
  }
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return rows
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .filter((row) => !alreadyReopened.has(row.id))
    .slice(0, boundedLimit)
    .map(({ id, kind, title, details, nextAction, dueAt, status, updatedAt }) => ({
      id,
      kind,
      title,
      details,
      nextAction,
      dueAt,
      status,
      updatedAt,
    }));
}
