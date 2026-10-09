import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  planConsumerUninstall,
  rebaseInstallationRelease,
  runConsumerUninstall,
} from './consumer-lifecycle.js';
import {
  advanceInstallationStage,
  createInstallationManifest,
  type InstallationManifest,
  validateInstallationManifest,
} from './installation-manifest.js';
import { persistInstallationProgress } from './installation-state.js';
import type { CommandRunner } from './runner.js';

const oldSha = '0123456789abcdef0123456789abcdef01234567';
const newSha = 'fedcba9876543210fedcba9876543210fedcba98';
const bucket = 'customer-project-pilot-state';

function initialized(): InstallationManifest {
  let manifest = createInstallationManifest({
    identity: {
      installationId: 'pilot',
      projectId: 'customer-project',
      region: 'us-central1',
      databaseId: '(default)',
      release: { commitSha: oldSha, archiveDigest: `sha256:${'a'.repeat(64)}` },
    },
    modules: [],
    modelProvider: 'google',
    resources: [],
    createdAt: '2026-09-24T12:00:00.000Z',
  });
  for (const stage of ['authorized', 'bootstrapped', 'provisioned', 'initialized'] as const)
    manifest = advanceInstallationStage(manifest, stage, '2026-09-24T12:00:01.000Z');
  const owned = (kind: string, name: string, owner: 'bootstrap' | 'terraform') => ({
    kind,
    name,
    scope: 'installation' as const,
    owner,
    installationId: 'pilot',
  });
  return validateInstallationManifest({
    ...manifest,
    resources: [
      owned('state-bucket', bucket, 'bootstrap'),
      owned('release-receipt', `gs://${bucket}/releases/${oldSha}.tar.gz`, 'bootstrap'),
      owned('secret', 'projects/customer-project/secrets/pilot-auth-secret', 'bootstrap'),
      owned(
        'auth-secret-version',
        'projects/customer-project/secrets/pilot-auth-secret/versions/1',
        'bootstrap',
      ),
      owned('assets-bucket', 'customer-project-pilot-assets', 'terraform'),
      owned('runtime-config', `sha256:${'f'.repeat(64)}`, 'terraform'),
      owned('cloud-run-service', 'pilot-web', 'terraform'),
    ],
  });
}

describe('release rebase (update and rollback)', () => {
  it('returns to provisioned on the new release while preserving applied Terraform inventory', () => {
    const next = rebaseInstallationRelease(
      initialized(),
      { commitSha: newSha, archiveDigest: `sha256:${'b'.repeat(64)}` },
      bucket,
      '2026-09-24T13:00:00.000Z',
    );
    expect(next.identity.release.commitSha).toBe(newSha);
    expect(next.stage).toEqual({
      current: 'provisioned',
      completed: ['previewed', 'authorized', 'bootstrapped', 'provisioned'],
      updatedAt: '2026-09-24T13:00:00.000Z',
    });
    expect(next.resources.map((resource) => resource.kind).sort()).toEqual([
      'assets-bucket',
      'auth-secret-version',
      'cloud-run-service',
      'release-receipt',
      'release-receipt',
      'runtime-config',
      'secret',
      'state-bucket',
    ]);
  });

  it('refuses same release, malformed input, and non-deployed installations', () => {
    const current = initialized();
    const release = { commitSha: newSha, archiveDigest: `sha256:${'b'.repeat(64)}` };
    expect(() =>
      rebaseInstallationRelease(current, { ...release, commitSha: oldSha }, bucket, 'x'),
    ).toThrow('already runs this release');
    expect(() =>
      rebaseInstallationRelease(current, { ...release, commitSha: 'main' }, bucket, 'x'),
    ).toThrow('full 40-character SHA');
    const provisioned = validateInstallationManifest({
      ...current,
      stage: {
        current: 'provisioned',
        completed: ['previewed', 'authorized', 'bootstrapped', 'provisioned'],
        updatedAt: current.stage.updatedAt,
      },
    });
    expect(() =>
      rebaseInstallationRelease(provisioned, release, bucket, '2026-09-24T13:00:00.000Z'),
    ).toThrow('initialized or ready');
  });

  it('persists only through the explicit release-rebase transition', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-rebase-'));
    const state = join(dir, 'state.json');
    let persisted: InstallationManifest | null = null;
    const current = initialized();
    // Build the persisted chain one stage at a time, as the installer does.
    const chain = ['authorized', 'bootstrapped', 'provisioned', 'initialized'] as const;
    for (const stage of chain) {
      const next = validateInstallationManifest({
        ...current,
        stage: {
          current: stage,
          completed: ['previewed', ...chain.slice(0, chain.indexOf(stage) + 1)],
          updatedAt: current.stage.updatedAt,
        },
      });
      persisted = await persistInstallationProgress(state, next, persisted);
    }
    const next = rebaseInstallationRelease(
      current,
      { commitSha: newSha, archiveDigest: `sha256:${'b'.repeat(64)}` },
      bucket,
      '2026-09-24T13:00:00.000Z',
    );
    await expect(persistInstallationProgress(state, next, persisted)).rejects.toThrow(
      'immutable installation identity',
    );
    const foreign = validateInstallationManifest({
      ...next,
      identity: { ...next.identity, region: 'us-east1' },
      resources: [],
    });
    await expect(
      persistInstallationProgress(state, foreign, persisted, 'release-rebase'),
    ).rejects.toThrow('may change only the release');
    const lostRuntime = validateInstallationManifest({
      ...next,
      resources: next.resources.filter((resource) => resource.owner !== 'terraform'),
    });
    await expect(
      persistInstallationProgress(state, lostRuntime, persisted, 'release-rebase'),
    ).rejects.toThrow('must preserve Terraform-owned resources');
    await persistInstallationProgress(state, next, persisted, 'release-rebase');
    const saved = JSON.parse(await readFile(state, 'utf8'));
    expect(saved.identity.release.commitSha).toBe(newSha);
    expect(saved.stage.current).toBe('provisioned');
    expect(
      saved.resources.filter((resource: { owner: string }) => resource.owner === 'terraform'),
    ).toEqual(current.resources.filter((resource) => resource.owner === 'terraform'));
  });
});

describe('consumer uninstall', () => {
  it('stops work before removing access and keeps data by default', () => {
    const plan = planConsumerUninstall(initialized(), {
      stateBucket: bucket,
      deleteData: false,
      deleteState: false,
    });
    const ids = plan.steps.map((step) => step.id);
    expect(ids.slice(0, 4)).toEqual([
      'scheduler-sweep',
      'tasks-queue',
      'cloud-run-web',
      'cloud-run-agent',
    ]);
    expect(ids).toContain('secret-pilot-auth-secret');
    expect(plan.steps.some((step) => step.destroysData)).toBe(false);
    expect(
      plan.steps.every((step) => step.args.some((arg) => arg.includes('customer-project'))),
    ).toBe(true);
    expect(plan.steps.some((step) => step.args.join(' ').includes('projects delete'))).toBe(false);
    expect(plan.retained.map((item) => item.resource).join('\n')).toContain(
      'Firestore database (default)',
    );
  });

  it('deletes data and state last, only when explicitly selected', () => {
    expect(() =>
      planConsumerUninstall(initialized(), {
        stateBucket: bucket,
        deleteData: false,
        deleteState: true,
      }),
    ).toThrow('requires --delete-data');
    expect(() =>
      planConsumerUninstall(initialized(), {
        stateBucket: 'someone-else-state',
        deleteData: true,
        deleteState: true,
      }),
    ).toThrow('State bucket must be');
    const plan = planConsumerUninstall(initialized(), {
      stateBucket: bucket,
      deleteData: true,
      deleteState: true,
    });
    const ids = plan.steps.map((step) => step.id);
    expect(ids.indexOf('firestore-delete-protection')).toBeLessThan(
      ids.indexOf('firestore-database'),
    );
    expect(ids.at(-1)).toBe('state-bucket');
    expect(ids.indexOf('cloud-run-agent')).toBeLessThan(ids.indexOf('firestore-database'));
    expect(plan.retained.map((item) => item.resource).join('\n')).not.toContain('Firestore');
  });

  it('treats missing resources as done, stops at a failure, and resumes', async () => {
    const plan = planConsumerUninstall(initialized(), {
      stateBucket: bucket,
      deleteData: false,
      deleteState: false,
    });
    const calls: string[] = [];
    let failAgent = true;
    const runner: CommandRunner = {
      async run(_command, args) {
        calls.push(args.join(' '));
        if (args[0] === 'scheduler')
          return { ok: false, stdout: '', stderr: 'NOT_FOUND: job does not exist' };
        if (args.includes('pilot-agent') && failAgent)
          return { ok: false, stdout: '', stderr: 'PERMISSION_DENIED: secret detail' };
        return { ok: true, stdout: '', stderr: '' };
      },
    };
    const preview = await runConsumerUninstall(runner, plan, false);
    expect(calls).toHaveLength(0);
    expect(preview.steps.every((step) => step.status === 'planned')).toBe(true);
    const first = await runConsumerUninstall(runner, plan, true);
    expect(first.completed).toBe(false);
    expect(first.steps[0]?.status).toBe('absent');
    expect(first.steps.find((step) => step.id === 'cloud-run-agent')?.status).toBe('failed');
    expect(first.steps.at(-1)?.status).toBe('skipped');
    failAgent = false;
    const second = await runConsumerUninstall(runner, plan, true);
    expect(second.completed).toBe(true);
  });
});
