import { rename, writeFile } from 'node:fs/promises';
import type { Db } from '@assistant/db';
import { createDb } from '@assistant/db';
import {
  assertGoalSessionDatabaseOwnership,
  reconcileGoalSessionRun,
  tryAcquireGoalSessionLock,
} from './goal-session-reconciliation.js';

const [runId, evidenceDirectory, markerPath, stopAfter] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!runId || !evidenceDirectory || !markerPath || !stopAfter || !databaseUrl || !token)
  throw new Error('Allocated target and cleanup cutpoint identities are required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
const db = createDb(databaseUrl, { max: 2 });
const pauseAt = async (stage: string) => {
  if (stage !== stopAfter) return;
  const marker = `${markerPath}.step`;
  const pendingMarker = `${marker}.${process.pid}.pending`;
  await writeFile(pendingMarker, `${stage}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pendingMarker, marker);
  await new Promise<never>(() => {});
};
await assertGoalSessionDatabaseOwnership(db, { databaseName, token });
const lock = await tryAcquireGoalSessionLock(db, runId);
if (!lock) throw new Error('Could not acquire cleanup rehearsal lock');
const realTransaction = db.transaction.bind(db);
const wrappedDb = new Proxy(db, {
  get(target, property) {
    if (property === 'transaction') {
      return async (callback: (tx: never) => Promise<unknown>) => {
        await pauseAt('before_cleanup_transaction');
        const result = await realTransaction(async (tx) => {
          const callbackResult = await callback(tx as never);
          await pauseAt('after_cleanup_mutations_before_commit');
          return callbackResult;
        });
        await pauseAt('after_cleanup_commit_before_complete');
        return result;
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as Db;
try {
  const result = await reconcileGoalSessionRun({
    db: wrappedDb,
    directory: evidenceDirectory,
    runId,
    target: { databaseName, token },
    lockAlreadyHeld: true,
  });
  if (result !== 'cleaned' && result !== 'already-clean')
    throw new Error(`Cleanup cutpoint fixture unexpectedly returned ${result}`);
} finally {
  await lock.release();
  await db.$client.end({ timeout: 5 });
}
throw new Error(`Requested cleanup cutpoint ${stopAfter} was not reached`);
