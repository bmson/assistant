import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type CommandRunner,
  persistInstallationProgress,
  readPersistedInstallation,
  rebaseInstallationRelease,
  serializeInstallationManifest,
  sha256File,
  systemRunner,
} from '@assistant/setup/installation';

const usage = `Usage: pnpm consumer:update --state PATH --state-bucket NAME --archive NEW_RELEASE.tar.gz --commit-sha SHA [--apply]

Moves an initialized or ready customer installation to another verified source
release (an update, or a rollback to an earlier release). Run it from a clean
checkout of that exact commit. It verifies the archive digest, uploads the
release receipt to the customer state bucket, preserves Terraform-owned runtime
resources, returns the selected release to the provisioned stage, and writes
install-manifest-<sha>.json beside the state. Then rerun consumer:install with
that manifest: it builds and deploys the release (or, for a rollback, reuses
--images image-manifest-<sha>.json) without applying a foundation-only plan, and
requires --verify again before ready.
Without --apply nothing changes.
`;

export async function runConsumerUpdateCli(
  argv: string[] = process.argv.slice(2),
  runner: CommandRunner = systemRunner,
  now: () => string = () => new Date().toISOString(),
): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      state: { type: 'string' },
      'state-bucket': { type: 'string' },
      archive: { type: 'string' },
      'commit-sha': { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return usage;
  const missing = (['state', 'state-bucket', 'archive', 'commit-sha'] as const).find(
    (key) => !values[key],
  );
  if (missing) throw new Error(`missing --${missing}\n\n${usage.trim()}`);
  const statePath = values.state as string;
  const stateBucket = values['state-bucket'] as string;
  const archive = values.archive as string;
  const commitSha = values['commit-sha'] as string;
  const current = await readPersistedInstallation(statePath);
  if (!current) throw new Error('No persisted installation state at --state');
  const { projectId, installationId } = current.identity;
  if (stateBucket !== `${projectId}-${installationId}-state`)
    throw new Error(`State bucket must be ${projectId}-${installationId}-state`);

  const head = await runner.run('git', ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok || head.stdout !== commitSha)
    throw new Error('Run the update from a checkout whose HEAD is the selected release commit');
  const dirty = await runner.run('git', ['status', '--porcelain', '--untracked-files=no']);
  if (!dirty.ok || dirty.stdout.length > 0)
    throw new Error('The release checkout must have no tracked changes');
  const archiveDigest = await sha256File(archive);
  const next = rebaseInstallationRelease(current, { commitSha, archiveDigest }, stateBucket, now());
  const manifestPath = path.join(path.dirname(statePath), `install-manifest-${commitSha}.json`);
  const summary = {
    installationId,
    from: current.identity.release.commitSha,
    to: commitSha,
    archiveDigest,
    manifestPath,
    stage: next.stage.current,
  };
  if (!values.apply) return { applied: false, ...summary };

  const receipt = `gs://${stateBucket}/releases/${commitSha}.tar.gz`;
  const upload = await runner.run('gcloud', [
    'storage',
    'cp',
    archive,
    receipt,
    `--custom-metadata=assistant_installation=${installationId},assistant_archive_digest=${archiveDigest}`,
  ]);
  if (!upload.ok) throw new Error('Could not upload the release receipt to the state bucket');
  await writeFile(manifestPath, serializeInstallationManifest(next), { mode: 0o600 });
  await persistInstallationProgress(statePath, next, current, 'release-rebase');
  return {
    applied: true,
    ...summary,
    next: [
      `pnpm consumer:install --manifest ${manifestPath} --archive ${archive} --state ${statePath} --state-bucket ${stateBucket} --terraform-dir infra/gcp/consumer/terraform --build-images --runtime-config RUNTIME_CONFIG --apply`,
      `pnpm consumer:install --manifest ${manifestPath} --archive ${archive} --state ${statePath} --state-bucket ${stateBucket} --terraform-dir infra/gcp/consumer/terraform --images ${path.join(path.dirname(statePath), `image-manifest-${commitSha}.json`)} --runtime-config RUNTIME_CONFIG --verify --apply`,
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsumerUpdateCli()
    .then((result) =>
      process.stdout.write(
        typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `consumer:update: ${error instanceof Error ? error.message : 'update failed'}\n`,
      );
      process.exitCode = 1;
    });
}
