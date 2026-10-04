import type { GoalReadRepository, Records } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

async function assertConfiguredOwner(store: InstallationStore, agentId: string) {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.id !== documentKey(agentId) ||
    owner.get('id') !== agentId
  )
    throw new Error('Goals require exactly one configured agent');
}

const MAX_STANDING_GOALS = 200;
const STATUS_RANK: Record<string, number> = { active: 0, paused: 1, done: 2 };

function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 3;
}

/** SQL-free, installation-owner-scoped reads for mobile Goals. */
export class FirestoreGoalReadRepository implements GoalReadRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async list(agentId: string) {
    if (agentId !== this.configuredAgentId)
      throw new Error('Goal read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const [goals, conversations, schedules] = await Promise.all([
      this.store.collection('goals').where('agentId', '==', agentId).get(),
      this.store
        .collection('conversations')
        .where('agentId', '==', agentId)
        .where('channel', '==', 'chat')
        .select('id', 'agentId', 'updatedAt', 'metadata')
        .get(),
      this.store
        .collection('schedules')
        .where('agentId', '==', agentId)
        .select('id', 'agentId', 'name', 'enabled', 'nextRunAt')
        .get(),
    ]);
    const owned = <T extends { id: string; agentId: string }>(
      docs: FirebaseFirestore.QuerySnapshot,
    ) =>
      docs.docs.flatMap((doc) => {
        const row = decodeRecord<T>(doc.data());
        return row.agentId === agentId && documentKey(row.id) === doc.id ? [row] : [];
      });
    const goalRows = owned<Records['goals']>(goals);
    // The dashboard only reads the sessions bound to a goal, and only four
    // fields of each. This used to load every task the assistant had ever
    // created, in full (15,000+ documents in production) and filter them in
    // memory, which made the goals dashboard — and with it every refresh of the
    // app — take seconds. `agentId + goalId` is served by the existing indexes.
    const taskSnapshots = await Promise.all(
      goalRows.map((goal) =>
        this.store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('goalId', '==', goal.id)
          .select('id', 'agentId', 'goalId', 'status', 'updatedAt')
          .get(),
      ),
    );
    const result = {
      goals: goalRows,
      conversations: owned<Records['conversations']>(conversations),
      tasks: taskSnapshots.flatMap((snapshot) => owned<Records['tasks']>(snapshot)),
      schedules: owned<Records['schedules']>(schedules),
    };
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }

  /** The goals.list view: unarchived goals, active first, then by priority. */
  async listStanding(agentId: string): Promise<Records['goals'][]> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Goal read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('goals')
      .where('agentId', '==', agentId)
      .where('archivedAt', '==', null)
      .limit(MAX_STANDING_GOALS + 1)
      .get();
    if (snapshot.size > MAX_STANDING_GOALS)
      throw new Error('Too many goals to list safely; archive finished goals first');
    const goals = snapshot.docs.map((doc) => {
      const row = decodeRecord<Records['goals']>(doc.data());
      if (row.agentId !== agentId || documentKey(row.id) !== doc.id)
        throw new Error('Goal record identity mismatch');
      return row;
    });
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return goals.sort(
      (left, right) =>
        statusRank(left.status) - statusRank(right.status) ||
        left.priority - right.priority ||
        left.id.localeCompare(right.id),
    );
  }

  async get(agentId: string, id: string): Promise<Records['goals'] | null> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Goal read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const doc = await this.store.doc('goals', id).get();
    const row = doc.exists ? decodeRecord<Records['goals']>(doc.data()) : null;
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return row && documentKey(row.id) === doc.id && row.agentId === agentId ? row : null;
  }
}
