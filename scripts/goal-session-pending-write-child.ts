import type { FileHandle } from 'node:fs/promises';
import { rename, writeFile } from 'node:fs/promises';
import { GoalSessionEvidence } from './goal-session-safety.js';

const [runId, evidencePathOrParent, markerPath, mode] = process.argv.slice(2);
if (!runId || !evidencePathOrParent || !markerPath)
  throw new Error('Interrupted evidence-write fixture identity is required');
const signal = async () => {
  const marker = `${markerPath}.step`;
  const pendingMarker = `${marker}.${process.pid}.pending`;
  await writeFile(pendingMarker, 'pending_record_partially_written\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(pendingMarker, marker);
  await new Promise<never>(() => {});
};
const writer = async (handle: FileHandle, contents: string) => {
  await handle.writeFile(contents.slice(0, 48), 'utf8');
  await handle.sync();
  await signal();
};
const evidence =
  mode === 'first'
    ? await GoalSessionEvidence.create(evidencePathOrParent, runId, undefined, writer)
    : await GoalSessionEvidence.open(evidencePathOrParent, runId, undefined, writer);
await evidence.record({ event: 'rehearsal_result', runId, fixture: true });
