import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const readerPath = 'scripts/owner-web-tag-artifact.ts';
const priorSource = '9550412e671c20e59e60390c9b6686f1c328e1d2';
const priorBlob = '741015ed5826171f240aa39f81e096f86947525c';
const correctedBlob = '169a0db3db4153cae28aa1fd1411b655942b1729';
const priorRun = 44679671412;
const artifactId = 14604345847;
const artifactName =
  'owner-web-tag-creation-d6954975b72e5cf41357f050d9d6b036ccad7753-44679671412-1';
const expectedDigest = 'sha256:553c517b4a2b233ab5edb076a68cb4616af2166e943a97f878080adbe5d51670';
const expectedSize = 1276;

function git(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 });
}

let workDir;
const written = [];
try {
  if (git(['rev-parse', `${priorSource}:${readerPath}`]).toString().trim() !== priorBlob) {
    throw new Error();
  }
  if (git(['rev-parse', `HEAD:${readerPath}`]).toString().trim() !== correctedBlob) {
    throw new Error();
  }

  workDir = mkdtempSync(join(process.env.RUNNER_TEMP, 'hosted-token-check-'));
  async function loadReader(label, blob) {
    const modulePath = join(workDir, `${label}.mts`);
    writeFileSync(modulePath, git(['cat-file', 'blob', blob]), { flag: 'wx', mode: 0o600 });
    written.push(modulePath);
    return import(pathToFileURL(modulePath).href);
  }

  const prior = await loadReader('prior', priorBlob);
  const corrected = await loadReader('corrected', correctedBlob);
  try {
    prior.readProtectedGitHubTokenFile(join(process.env.RUNNER_TEMP, 'owner-web-tag-github-token'));
    console.log('prior validator accepted');
  } catch {
    console.log('prior validator rejected');
  }

  const { artifactMetadata, archiveBytes } = await corrected.readProtectedWebTagArtifact(priorRun, 1);
  const archiveDigest = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`;
  if (
    artifactMetadata.id !== artifactId ||
    artifactMetadata.name !== artifactName ||
    artifactMetadata.digest !== expectedDigest ||
    archiveDigest !== expectedDigest ||
    artifactMetadata.size_in_bytes !== expectedSize ||
    archiveBytes.byteLength !== expectedSize
  ) {
    throw new Error();
  }
  console.log('corrected reader verified the historical archive');
} catch {
  console.error('hosted token check failed');
  process.exitCode = 1;
} finally {
  try {
    for (const file of written) unlinkSync(file);
    if (workDir) rmdirSync(workDir);
  } catch {
    console.error('hosted token check cleanup failed');
    process.exitCode = 1;
  }
}
