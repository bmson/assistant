import {
  type BriefingRunOutcome,
  briefingCursorName,
  briefingMessageKey,
  createBriefingWatchdogRecord,
  DAILY_BRIEFING,
  evaluateBriefingWatchdog,
  type Records,
  readBriefingWatchdogRecord,
  savedBriefingMatches,
  shouldReplaceBriefingWatchdog,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { assertFirestoreInstallationOwner } from './installation-owner.js';
import { FirestoreScheduleRepository } from './schedules.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

export async function prepareFirestoreBriefingWatchdog(
  tx: Transaction,
  store: InstallationStore,
  task: Records['tasks'],
  outcome: BriefingRunOutcome,
  now: Date,
) {
  const next = createBriefingWatchdogRecord(
    `firestore:${store.installationId}`,
    task,
    outcome,
    now,
  );
  if (!next) return null;
  const name = briefingCursorName(next.agentId, next.scheduleId);
  const ref = store.doc('maintenanceCursors', name);
  const [current, migration] = await tx.getAll(ref, store.doc('coordination', 'migration'));
  if (
    !current ||
    (migration?.exists && migration.get('status') !== 'active') ||
    !shouldReplaceBriefingWatchdog(readBriefingWatchdogRecord(current.get('cursor')), next)
  )
    return null;
  return { ref, data: { name, cursor: JSON.stringify(next), updatedAt: now } };
}

export async function readFirestoreSavedBriefing(
  store: InstallationStore,
  agentId: string,
  taskId: string,
  expectedMessageId?: string,
  tx?: Transaction,
): Promise<{ messageId: string; conversationId: string; createdAt: Date } | null> {
  const ref = store.doc('messages', expectedMessageId ?? briefingMessageKey(taskId));
  const snapshot = await (tx ? tx.get(ref) : ref.get());
  let message = decodeRecord<Records['messages'] | undefined>(snapshot.data());
  if (message && (typeof message.id !== 'string' || documentKey(message.id) !== snapshot.id))
    return null;
  if (!snapshot.exists && !expectedMessageId) {
    // A retry across an upgrade can have a previous randomly keyed copy.
    const query = store.collection('messages').where('taskId', '==', taskId).limit(51);
    const legacy = await (tx ? tx.get(query) : query.get());
    if (legacy.size > 50) throw new Error('Too many messages to verify one briefing publication');
    const matching = legacy.docs.flatMap((doc) => {
      const row = decodeRecord<Records['messages']>(doc.data());
      return typeof row.id === 'string' &&
        documentKey(row.id) === doc.id &&
        savedBriefingMatches(row, taskId)
        ? [row]
        : [];
    });
    if (matching.length > 1) throw new Error('Multiple saved messages for one briefing task');
    message = matching[0];
  }
  if (
    !message ||
    typeof message.id !== 'string' ||
    (expectedMessageId && message.id !== expectedMessageId) ||
    typeof message.conversationId !== 'string' ||
    !(message.createdAt instanceof Date) ||
    !savedBriefingMatches(message, taskId)
  )
    return null;
  const conversationRef = store.doc('conversations', message.conversationId);
  const conversation = await (tx ? tx.get(conversationRef) : conversationRef.get());
  if (conversation.get('agentId') !== agentId || conversation.get('id') !== message.conversationId)
    return null;
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    createdAt: message.createdAt,
  };
}

export async function readFirestoreBriefingHealth(
  store: InstallationStore,
  agentId: string,
  clock = store.now(),
) {
  await assertFirestoreInstallationOwner(store, agentId);
  const migration = await store.doc('coordination', 'migration').get();
  if (migration.exists && migration.get('status') !== 'active')
    return { ok: false, state: 'inactive' } as const;
  const schedule = await new FirestoreScheduleRepository(store).getByName(agentId, DAILY_BRIEFING);
  return evaluateBriefingWatchdog({
    scope: `firestore:${store.installationId}`,
    owner: agentId,
    schedule,
    clock,
    async cursor(name) {
      const row = await store.doc('maintenanceCursors', name).get();
      return row.get('cursor');
    },
    async task(id) {
      const row = await store.doc('tasks', id).get();
      return row.exists ? decodeRecord<Records['tasks']>(row.data()) : null;
    },
    saved: (taskId, messageId) => readFirestoreSavedBriefing(store, agentId, taskId, messageId),
  });
}
