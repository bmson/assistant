import { directOwnerCallRequestBinding, type Records } from '@assistant/persistence';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

function read<T>(
  snapshot: { id: string; exists: boolean; data(): unknown },
  expectedLogicalId?: string,
): T | null {
  if (!snapshot.exists) return null;
  const value = decodeRecord<T>(snapshot.data());
  const logicalId = value && typeof value === 'object' ? (value as { id?: unknown }).id : null;
  if (
    typeof logicalId !== 'string' ||
    (expectedLogicalId !== undefined && logicalId !== expectedLogicalId)
  )
    return null;
  try {
    return documentKey(logicalId) === snapshot.id ? value : null;
  } catch {
    return null;
  }
}

export async function readFirestoreOwnerCallRequest(
  store: InstallationStore,
  agentId: string,
  taskId: string,
  lifecycle: 'running' | 'waiting_approval',
  tx?: import('@google-cloud/firestore').Transaction,
) {
  const taskRef = store.doc('tasks', taskId);
  const taskSnapshot = tx ? await tx.get(taskRef) : await taskRef.get();
  const task = read<Records['tasks']>(taskSnapshot, taskId);
  if (!task?.conversationId || task.agentId !== agentId) return null;
  const conversationRef = store.doc('conversations', task.conversationId);
  const conversationSnapshot = tx ? await tx.get(conversationRef) : await conversationRef.get();
  const conversation = read<Records['conversations']>(conversationSnapshot, task.conversationId);
  // Query by task only so this needs no new composite index. The safety bound fails closed.
  const query = store.collection('messages').where('taskId', '==', taskId).limit(201);
  const snapshots = tx ? await tx.get(query) : await query.get();
  if (snapshots.size > 200) return null;
  const decodedMessages = snapshots.docs.map((snapshot) => read<Records['messages']>(snapshot));
  // An invalid physical/logical binding must not fall back to an older message.
  if (decodedMessages.some((message) => message === null)) return null;
  const messages = decodedMessages.filter((message): message is Records['messages'] =>
    Boolean(
      message &&
        message.role === 'user' &&
        message.origin === 'owner' &&
        message.conversationId === task.conversationId,
    ),
  );
  if (
    messages.some(
      (message) =>
        !(message.createdAt instanceof Date) || !Number.isFinite(message.createdAt.getTime()),
    )
  )
    return null;
  messages.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  );
  return directOwnerCallRequestBinding(task, conversation, messages[0] ?? null, lifecycle);
}
