import {
  type InstallationManifest,
  validateInstallationManifest,
} from './installation-manifest.js';
import type { CommandRunner } from './runner.js';

/**
 * Update and uninstall for customer-owned installations. Both work only from
 * the persisted installation inventory and deterministic installer names; they
 * never delete a project or a resource the installation does not own.
 */

// ---------------------------------------------------------------------------
// Update / rollback: select another verified release

/**
 * Rebase an initialized installation onto a different release while keeping
 * its applied Terraform inventory. Updates resume from `provisioned`, so the
 * installer cannot apply a foundation-only configuration over live runtime
 * resources before the new images are built.
 */
export function rebaseInstallationRelease(
  current: InstallationManifest,
  release: { commitSha: string; archiveDigest: string },
  stateBucket: string,
  now: string,
): InstallationManifest {
  const manifest = validateInstallationManifest(current);
  if (manifest.status !== 'active') throw new Error('Cannot update an invalidated installation');
  if (manifest.stage.current !== 'initialized' && manifest.stage.current !== 'ready')
    throw new Error('Only an initialized or ready installation can change release');
  if (!/^[0-9a-f]{40}$/.test(release.commitSha))
    throw new Error('Release commit must be a full 40-character SHA');
  if (!/^sha256:[0-9a-f]{64}$/.test(release.archiveDigest))
    throw new Error('Release archive digest must be sha256:<64 hex>');
  if (release.commitSha === manifest.identity.release.commitSha)
    throw new Error('The installation already runs this release');
  const receipt = `gs://${stateBucket}/releases/${release.commitSha}.tar.gz`;
  return validateInstallationManifest({
    ...manifest,
    identity: { ...manifest.identity, release: { ...release } },
    resources: [
      ...manifest.resources.filter(
        (resource) => !(resource.kind === 'release-receipt' && resource.name === receipt),
      ),
      {
        kind: 'release-receipt',
        name: receipt,
        scope: 'installation',
        owner: 'bootstrap',
        installationId: manifest.identity.installationId,
      },
    ],
    stage: {
      current: 'provisioned',
      completed: ['previewed', 'authorized', 'bootstrapped', 'provisioned'],
      updatedAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Uninstall

export interface UninstallStep {
  id: string;
  description: string;
  /** gcloud arguments; a NOT_FOUND result counts as already done. */
  args: readonly string[];
  /** Destroys stored customer data; runs only with deleteData. */
  destroysData: boolean;
}

export interface UninstallRetained {
  resource: string;
  reason: string;
  billing: string;
}

export interface UninstallPlan {
  installationId: string;
  projectId: string;
  steps: readonly UninstallStep[];
  retained: readonly UninstallRetained[];
}

export interface UninstallOptions {
  stateBucket: string;
  /** Delete the Firestore database, assets/source buckets and the image repository. */
  deleteData: boolean;
  /** Delete the Terraform state/receipt bucket last (requires deleteData). */
  deleteState: boolean;
}

function resourceNames(manifest: InstallationManifest, kind: string): string[] {
  return manifest.resources
    .filter((resource) => resource.kind === kind && resource.owner !== 'preexisting')
    .map((resource) => resource.name);
}

/** An ordered, resumable plan: stop work, remove access, then (optionally) data. */
export function planConsumerUninstall(
  current: InstallationManifest,
  options: UninstallOptions,
): UninstallPlan {
  const manifest = validateInstallationManifest(current);
  const { projectId: project, installationId: id, region, databaseId } = manifest.identity;
  if (options.deleteState && !options.deleteData)
    throw new Error('Deleting the state bucket requires --delete-data (state records the data)');
  if (options.stateBucket !== `${project}-${id}-state`)
    throw new Error(`State bucket must be ${project}-${id}-state for this installation`);
  const p = `--project=${project}`;
  const sa = (name: string) => `${id}-${name}@${project}.iam.gserviceaccount.com`;
  const steps: UninstallStep[] = [];
  const step = (id: string, description: string, args: string[], destroysData = false) =>
    steps.push({ id, description, args, destroysData });

  // 1. Stop schedules, queued work, and execution before anything else.
  step('scheduler-sweep', 'Delete the due-work sweep job', [
    'scheduler',
    'jobs',
    'delete',
    `${id}-sweep`,
    `--location=${region}`,
    p,
    '--quiet',
  ]);
  step('tasks-queue', 'Delete the agent Cloud Tasks queue and its pending tasks', [
    'tasks',
    'queues',
    'delete',
    `${id}-agent-steps`,
    `--location=${region}`,
    p,
    '--quiet',
  ]);
  for (const service of ['web', 'agent'])
    step(`cloud-run-${service}`, `Delete the ${service} Cloud Run service`, [
      'run',
      'services',
      'delete',
      `${id}-${service}`,
      `--region=${region}`,
      p,
      '--quiet',
    ]);

  // 2. Remove runtime identities and their project-level grants.
  const projectGrants: Array<[string, string]> = [
    [sa('runtime'), 'roles/datastore.user'],
    [sa('runtime'), 'roles/aiplatform.user'],
    [sa('web'), 'roles/datastore.user'],
    [sa('web'), 'roles/aiplatform.user'],
  ];
  for (const [member, role] of projectGrants)
    step(`iam-${member.split('@')[0]}-${role.split('/')[1]}`, `Remove ${role} from ${member}`, [
      'projects',
      'remove-iam-policy-binding',
      project,
      `--member=serviceAccount:${member}`,
      `--role=${role}`,
      '--all',
      '--quiet',
    ]);
  for (const name of ['web', 'invoker', 'runtime'])
    step(`service-account-${name}`, `Delete the ${name} service account`, [
      'iam',
      'service-accounts',
      'delete',
      sa(name),
      p,
      '--quiet',
    ]);

  // 3. Secrets the installer generated (never customer-created ones).
  for (const secret of resourceNames(manifest, 'secret')) {
    const secretId = secret.split('/').at(-1) ?? '';
    step(`secret-${secretId}`, `Delete installer-generated secret ${secretId}`, [
      'secrets',
      'delete',
      secretId,
      p,
      '--quiet',
    ]);
  }

  // 4. Stored data and build artifacts, only when explicitly selected.
  if (options.deleteData) {
    step(
      'artifact-registry',
      'Delete the image repository and all image versions',
      ['artifacts', 'repositories', 'delete', id, `--location=${region}`, p, '--quiet'],
      true,
    );
    step(
      'firestore-delete-protection',
      'Disable Firestore delete protection for the installation database',
      ['firestore', 'databases', 'update', `--database=${databaseId}`, '--no-delete-protection', p],
      true,
    );
    step(
      'firestore-database',
      'Delete the installation Firestore database (existing managed backups expire on their own schedule)',
      ['firestore', 'databases', 'delete', `--database=${databaseId}`, p, '--quiet'],
      true,
    );
    for (const bucket of [`${project}-${id}-assets`, `${project}-${id}-source`])
      step(
        `bucket-${bucket}`,
        `Delete bucket gs://${bucket} and every object version`,
        ['storage', 'rm', '--recursive', '--all-versions', `gs://${bucket}`, p],
        true,
      );
    if (options.deleteState)
      step(
        'state-bucket',
        `Delete the Terraform state and release-receipt bucket gs://${options.stateBucket}`,
        ['storage', 'rm', '--recursive', '--all-versions', `gs://${options.stateBucket}`, p],
        true,
      );
  }

  const retained: UninstallRetained[] = [];
  if (!options.deleteData) {
    retained.push(
      {
        resource: `Firestore database ${databaseId}`,
        reason: 'kept by default; export or delete explicitly with --delete-data',
        billing: 'stored data, PITR history, and any managed backups until they expire',
      },
      {
        resource: `gs://${project}-${id}-assets and gs://${project}-${id}-source`,
        reason: 'kept by default',
        billing: 'object storage including noncurrent versions and 7-day soft delete',
      },
      {
        resource: `Artifact Registry repository ${id}`,
        reason: 'kept by default so a reinstall can reuse verified images',
        billing: 'image storage',
      },
    );
  }
  if (!options.deleteState)
    retained.push({
      resource: `gs://${options.stateBucket}`,
      reason: 'Terraform state and release receipts; needed to reinstall or audit',
      billing: 'small object storage',
    });
  retained.push(
    {
      resource: 'Customer-created secrets (Google OAuth client, mobile token)',
      reason: 'created outside the installer; delete them in Secret Manager if unused',
      billing: 'per active secret version',
    },
    {
      resource: 'Enabled Google APIs, billing account link, and the project itself',
      reason: 'the installer never disables APIs or deletes a project',
      billing: 'no charge on their own',
    },
  );
  return { installationId: id, projectId: project, steps, retained };
}

export interface UninstallStepResult {
  id: string;
  status: 'planned' | 'done' | 'absent' | 'failed' | 'skipped';
}

const absent = /(not.?found|404|does not exist|NOT_FOUND)/i;

/** Execute sequentially and stop at the first real failure; rerunning resumes. */
export async function runConsumerUninstall(
  runner: CommandRunner,
  plan: UninstallPlan,
  apply: boolean,
): Promise<{ completed: boolean; steps: UninstallStepResult[] }> {
  const results: UninstallStepResult[] = [];
  let failed = false;
  for (const step of plan.steps) {
    if (!apply) {
      results.push({ id: step.id, status: 'planned' });
      continue;
    }
    if (failed) {
      results.push({ id: step.id, status: 'skipped' });
      continue;
    }
    const result = await runner.run('gcloud', step.args);
    if (result.ok) results.push({ id: step.id, status: 'done' });
    else if (absent.test(result.stderr)) results.push({ id: step.id, status: 'absent' });
    else {
      // gcloud diagnostics can echo headers or policy detail; report only the step.
      results.push({ id: step.id, status: 'failed' });
      failed = true;
    }
  }
  return { completed: apply && !failed, steps: results };
}
