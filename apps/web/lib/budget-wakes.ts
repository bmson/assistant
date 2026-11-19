import { dispatchBudgetWakes as dispatch } from '@assistant/application/costs';
import { FirestoreOutbox, type InstallationStore, wakeIntentId } from '@assistant/firestore';
import type { TaskWake } from '@assistant/persistence';

export function dispatchBudgetWakes(
  queueDriver: string,
  wakes: readonly TaskWake[],
  store?: InstallationStore,
): Promise<void> {
  return dispatch(
    queueDriver,
    wakes,
    store
      ? {
          outbox: new FirestoreOutbox(store),
          ids: wakes.map(({ id, queueGeneration }) => wakeIntentId(id, queueGeneration)),
        }
      : {},
  );
}
