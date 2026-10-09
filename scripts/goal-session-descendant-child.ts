import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [marker] = process.argv.slice(2);
if (!marker) throw new Error('Owned process-group marker is required');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: false,
  stdio: 'ignore',
});
await new Promise<void>((resolve, reject) => {
  descendant.once('spawn', resolve);
  descendant.once('error', reject);
});
await writeFile(marker, 'spawned\n', { encoding: 'utf8', mode: 0o600 });
// Exit with a live child in the same process group to exercise owned-group cleanup.
process.exit(0);
