import {
  parseSignal,
  planSignalWrite,
  prepareBillSignal,
  type SignalRepository,
  signalQueryTimes,
  signalsValidAt,
} from '@assistant/persistence';
import { and, arrayContains, eq, gte, lt } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  lockPostgresPrivacyObservationFence,
  withPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { emailIngest, signals } from './schema.js';

async function getSignal(db: Pick<Db, 'select'>, agentId: string, id: string) {
  const [row] = await db
    .select({ record: signals.record })
    .from(signals)
    .where(and(eq(signals.agentId, agentId), eq(signals.id, id)));
  return row ? parseSignal(row.record) : null;
}

export function createPostgresSignalRepository(db: Db): SignalRepository {
  return {
    record: (input) =>
      db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, input.agentId);
        const [source] = await tx
          .select()
          .from(emailIngest)
          .where(
            and(eq(emailIngest.agentId, input.agentId), eq(emailIngest.id, input.emailIngestId)),
          );
        const signal = prepareBillSignal(input, source);
        const existing = await getSignal(tx, input.agentId, signal.id);
        const prior = input.replaces ? await getSignal(tx, input.agentId, input.replaces) : null;
        const write = planSignalWrite(input, signal, existing, prior);
        if (write.insert) {
          await tx.insert(signals).values({ ...signal, record: signal });
        }
        if (write.close) {
          await tx
            .update(signals)
            .set({ record: write.close })
            .where(and(eq(signals.agentId, input.agentId), eq(signals.id, write.close.id)));
        }
        return write.signal;
      }),
    get: (agentId, id) =>
      withPostgresPrivacyObservationFence(db, agentId, (tx) => getSignal(tx, agentId, id)),
    list: (query) =>
      withPostgresPrivacyObservationFence(db, query.agentId, async (tx) => {
        const { from, to, asOf } = signalQueryTimes(query);
        const rows = await tx
          .select({ record: signals.record })
          .from(signals)
          .where(
            and(
              eq(signals.agentId, query.agentId),
              query.kind === undefined ? undefined : eq(signals.kind, query.kind),
              query.personId === undefined
                ? undefined
                : arrayContains(signals.subjectPersonIds, [query.personId]),
              from === undefined ? undefined : gte(signals.at, from),
              to === undefined ? undefined : lt(signals.at, to),
            ),
          );
        return signalsValidAt(
          rows.map(({ record }) => parseSignal(record)),
          asOf,
        );
      }),
  };
}
