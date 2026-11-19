import { randomUUID } from 'node:crypto';
import { type Db, maintenanceCursors } from '@assistant/db';
import type { InstallationStore } from '@assistant/firestore';
import { eq } from 'drizzle-orm';

const CURSOR_NAME = 'scheduler-watchdog-episode-v1';

type AlertReason = 'sweep' | 'briefing';
export type WatchdogObservation =
  | { kind: 'stale'; reason: AlertReason; sweepCompletedAt?: string }
  | { kind: 'recovered' };

export interface WatchdogEpisode {
  key: string;
  reason: AlertReason;
}

export function watchdogObservation(health: {
  state: string;
  completedAt?: string;
  briefing: { state: string };
}): WatchdogObservation | null {
  if (health.state === 'stale')
    return { kind: 'stale', reason: 'sweep', sweepCompletedAt: health.completedAt };
  if (health.briefing.state === 'stale') return { kind: 'stale', reason: 'briefing' };
  if (
    ['healthy', 'failed'].includes(health.state) &&
    ['delivered', 'quiet', 'disabled', 'missing', 'awaiting_first_run'].includes(
      health.briefing.state,
    )
  )
    return { kind: 'recovered' };
  // A fresh sweep can end the stale window even if a maintenance step failed.
  // A missing schedule has no overdue run. Unavailable reads cannot close an incident.
  return null;
}

function nextEpisode(
  raw: unknown,
  scope: string,
  owner: string,
  observation: WatchdogObservation,
): WatchdogEpisode | null {
  if (observation.kind === 'recovered') return null;
  if (typeof raw === 'string' && raw.length <= 400) {
    const prior = JSON.parse(raw) as {
      scope?: string;
      owner?: string;
      episode?: WatchdogEpisode | null;
    } | null;
    const episode = prior?.episode;
    if (
      prior?.scope === scope &&
      prior.owner === owner &&
      episode &&
      ['briefing', 'sweep'].includes(episode.reason) &&
      /^watchdog-outage:(?:\d{1,16}|briefing:[a-f0-9-]{36})$/.test(episode.key)
    )
      return episode;
  }
  const sweepAnchor = Date.parse(observation.sweepCompletedAt ?? '');
  return {
    reason: observation.reason,
    // Retain the pre-episode ledger key when upgrading mid-sweep-outage.
    key:
      observation.reason === 'sweep' && sweepAnchor >= 0
        ? `watchdog-outage:${sweepAnchor}`
        : `watchdog-outage:briefing:${randomUUID()}`,
  };
}

export async function recordPostgresWatchdogEpisode(
  db: Db,
  owner: string,
  observation: WatchdogObservation,
  observedAt: Date,
) {
  const scope = 'postgres';
  return db.transaction(async (tx) => {
    const initial = nextEpisode(null, scope, owner, observation);
    const [inserted] = await tx
      .insert(maintenanceCursors)
      .values({
        name: CURSOR_NAME,
        cursor: JSON.stringify({ scope, owner, episode: initial }),
        updatedAt: observedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return initial;
    const [previous] = await tx
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, CURSOR_NAME))
      .for('update');
    if (!previous || previous.updatedAt > observedAt) return null;
    const episode = nextEpisode(previous.cursor, scope, owner, observation);
    await tx
      .update(maintenanceCursors)
      .set({ cursor: JSON.stringify({ scope, owner, episode }), updatedAt: observedAt })
      .where(eq(maintenanceCursors.name, CURSOR_NAME));
    return episode;
  });
}

export function recordFirestoreWatchdogEpisode(
  store: InstallationStore,
  owner: string,
  observation: WatchdogObservation,
  observedAt: Date,
) {
  const scope = `firestore:${store.installationId}`;
  const ref = store.doc('maintenanceCursors', CURSOR_NAME);
  return store.db.runTransaction(async (tx) => {
    const [previous, agent, migration] = await tx.getAll(
      ref,
      store.doc('agents', owner),
      store.doc('coordination', 'migration'),
    );
    if (agent?.get('id') !== owner || (migration?.exists && migration.get('status') !== 'active'))
      return null;
    const updatedAt = previous?.get('updatedAt') as { toMillis?: () => number } | undefined;
    if (updatedAt?.toMillis && updatedAt.toMillis() > observedAt.getTime()) return null;
    const episode = nextEpisode(previous?.get('cursor'), scope, owner, observation);
    tx.set(ref, {
      name: CURSOR_NAME,
      cursor: JSON.stringify({ scope, owner, episode }),
      updatedAt: observedAt,
    });
    return episode;
  });
}
