import { resumeAdmittedChatTask } from '@assistant/application';
import { executeTask } from '@assistant/core';
import {
  createPostgresApplicationChatPersistence,
  createPostgresLocationPingRepository,
  createPostgresTaskRepository,
} from '@assistant/db';
import {
  FirestoreApplicationChatPersistence,
  FirestoreLocationPingRepository,
} from '@assistant/firestore';
import { chatAdmissionPayload } from '@assistant/persistence';
import { type AgentDeps, agentServices } from './deps.js';
import { executorDeps } from './executor-deps.js';

/** Route deterministic internal workflows before the general model executor. */
export async function executeAgentTask(deps: AgentDeps, taskId: string, generation?: number) {
  const taskRepository = deps.persistence?.tasks ?? createPostgresTaskRepository(deps.db);
  const task = await taskRepository.getTask(taskId);
  if (
    deps.config.PERSISTENCE_DRIVER === 'firestore' &&
    (!task || task.agentId !== deps.config.FIRESTORE_AGENT_ID)
  ) {
    throw new Error('Task is missing or outside the configured Firestore agent');
  }
  const trigger = task?.trigger as { payload?: Record<string, unknown> } | undefined;
  const kind = typeof trigger?.payload?.kind === 'string' ? trigger.payload.kind : undefined;
  let arrivalObservationCheck:
    | ((agentId: string, observationId: string) => Promise<boolean>)
    | undefined;
  if (task && kind === 'arrival') {
    const observationId = trigger?.payload?.arrivalObservationId;
    let active = false;
    try {
      const locations =
        deps.config.PERSISTENCE_DRIVER === 'firestore'
          ? deps.firestoreStore
            ? new FirestoreLocationPingRepository(deps.firestoreStore)
            : undefined
          : createPostgresLocationPingRepository(deps.db);
      if (locations) {
        arrivalObservationCheck = (ownerId, id) =>
          locations.isArrivalObservationActive(ownerId, id, new Date());
      }
      active = Boolean(
        typeof observationId === 'string' &&
          locations &&
          (await arrivalObservationCheck?.(task.agentId, observationId)),
      );
    } catch {
      // Location is optional and private. An unreadable or stale reference
      // must not be passed to the model or treated as a usable observation.
      active = false;
    }
    if (!active) {
      const lease = await taskRepository.claim(taskId, generation);
      if (!lease) return { outcome: 'not_claimable' as const };
      await taskRepository.completeTask(lease, {
        status: 'cancelled',
        progress: 'arrival observation expired or unavailable; no location details used',
      });
      return { outcome: 'cancelled' as const, detail: 'arrival observation expired' };
    }
  }
  const admission = task ? chatAdmissionPayload(task) : null;
  if (task && admission && admission.phase !== 'queued') {
    const lease = await taskRepository.claim(taskId, generation);
    if (!lease) return { outcome: 'not_claimable' as const };
    const chat =
      deps.config.PERSISTENCE_DRIVER === 'firestore'
        ? (() => {
            if (!deps.firestoreStore) throw new Error('Firestore store is not configured');
            return new FirestoreApplicationChatPersistence(
              deps.firestoreStore,
              deps.config.FIRESTORE_AGENT_ID,
            );
          })()
        : createPostgresApplicationChatPersistence(deps.db);
    const status = await resumeAdmittedChatTask(lease, {
      config: deps.config,
      router: deps.router,
      chat,
      ...(deps.config.PERSISTENCE_DRIVER === 'postgres' ? { db: deps.db } : {}),
      persistence: deps.persistence,
    });
    return { outcome: 'admission_recovered' as const, status };
  }
  // Module-declared deterministic handlers claim their trigger kinds.
  const handler = kind ? deps.modules.taskHandlerFor(kind) : undefined;
  if (handler) return handler.run(agentServices(deps), taskId, generation);
  // A deterministic kind whose owning module was removed must NOT fall through
  // to the general model executor — it would run an internal-trust task with a
  // payload it does not understand. Complete it benignly instead, mirroring
  // jobUnavailable. (Other internal-source kinds, e.g. known-sender-reply, have
  // no module owner and correctly go to the model executor below.)
  const unavailable = kind ? deps.modules.taskKindUnavailable(kind) : null;
  if (unavailable) {
    const lease = await taskRepository.claim(taskId, generation);
    if (!lease) return { outcome: 'not_claimable' as const };
    await taskRepository.completeTask(lease, { status: 'cancelled', progress: unavailable });
    return { outcome: 'cancelled' as const, detail: unavailable };
  }
  return executeTask(
    {
      ...executorDeps(deps),
      ...(arrivalObservationCheck ? { isArrivalObservationActive: arrivalObservationCheck } : {}),
    },
    taskId,
    generation,
  );
}
