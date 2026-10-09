import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceInstallationStage,
  type CommandRunner,
  createInstallationManifest,
  type InstallationManifest,
  persistInstallationProgress,
  sha256File,
} from '@assistant/setup/installation';
import { describe, expect, it } from 'vitest';
import { runConsumerUninstallCli } from './consumer-uninstall.js';
import { runConsumerUpdateCli } from './consumer-update.js';

const oldSha = '0123456789abcdef0123456789abcdef01234567';
const newSha = 'fedcba9876543210fedcba9876543210fedcba98';
const bucket = 'customer-project-pilot-state';

async function initializedState(): Promise<{ dir: string; state: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-lifecycle-'));
  const state = join(dir, 'state.json');
  let manifest: InstallationManifest = createInstallationManifest({
    identity: {
      installationId: 'pilot',
      projectId: 'customer-project',
      region: 'us-central1',
      databaseId: '(default)',
      release: { commitSha: oldSha, archiveDigest: `sha256:${'a'.repeat(64)}` },
    },
    modules: [],
    modelProvider: 'google',
    resources: [
      {
        kind: 'runtime-config',
        name: `sha256:${'f'.repeat(64)}`,
        scope: 'installation',
        owner: 'terraform',
        installationId: 'pilot',
      },
      {
        kind: 'cloud-run-service',
        name: 'pilot-web',
        scope: 'installation',
        owner: 'terraform',
        installationId: 'pilot',
      },
    ],
    createdAt: '2026-09-24T12:00:00.000Z',
  });
  let persisted: InstallationManifest | null = null;
  for (const stage of ['authorized', 'bootstrapped', 'provisioned', 'initialized'] as const) {
    manifest = advanceInstallationStage(manifest, stage, '2026-09-24T12:00:01.000Z');
    persisted = await persistInstallationProgress(state, manifest, persisted);
  }
  return { dir, state };
}

function recordingRunner(head = newSha, dirty = ''): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      async run(command, args) {
        calls.push([command, ...args].join(' '));
        if (command === 'git' && args[0] === 'rev-parse')
          return { ok: true, stdout: head, stderr: '' };
        if (command === 'git' && args[0] === 'status')
          return { ok: true, stdout: dirty, stderr: '' };
        return { ok: true, stdout: '', stderr: '' };
      },
    },
  };
}

describe('consumer:update', () => {
  it('previews, then uploads the receipt, writes the new manifest, and rebases state', async () => {
    const { dir, state } = await initializedState();
    const archive = join(dir, 'release.tar.gz');
    await writeFile(archive, 'fixture archive');
    const args = [
      '--state',
      state,
      '--state-bucket',
      bucket,
      '--archive',
      archive,
      '--commit-sha',
      newSha,
    ];
    const wrongHead = recordingRunner(oldSha);
    await expect(runConsumerUpdateCli(args, wrongHead.runner)).rejects.toThrow('HEAD');
    const dirty = recordingRunner(newSha, ' M file.ts');
    await expect(runConsumerUpdateCli(args, dirty.runner)).rejects.toThrow('no tracked changes');

    const preview = recordingRunner();
    expect(await runConsumerUpdateCli(args, preview.runner)).toMatchObject({
      applied: false,
      from: oldSha,
      to: newSha,
      stage: 'provisioned',
    });
    expect(preview.calls.some((call) => call.startsWith('gcloud'))).toBe(false);
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('initialized');

    const applied = recordingRunner();
    const result = (await runConsumerUpdateCli(
      [...args, '--apply'],
      applied.runner,
      () => '2026-09-24T13:00:00.000Z',
    )) as { manifestPath: string; next: string[] };
    expect(applied.calls).toContainEqual(
      expect.stringContaining(
        `gcloud storage cp ${archive} gs://${bucket}/releases/${newSha}.tar.gz`,
      ),
    );
    const saved = JSON.parse(await readFile(state, 'utf8'));
    expect(saved.identity.release).toEqual({
      commitSha: newSha,
      archiveDigest: await sha256File(archive),
    });
    expect(saved.stage.current).toBe('provisioned');
    expect(
      saved.resources.filter((resource: { owner: string }) => resource.owner === 'terraform'),
    ).toHaveLength(2);
    expect(JSON.parse(await readFile(result.manifestPath, 'utf8')).identity.release.commitSha).toBe(
      newSha,
    );
    expect(result.next).toHaveLength(2);
    expect(result.next[0]).toContain('--build-images --runtime-config RUNTIME_CONFIG --apply');
    expect(result.next[1]).toContain('--verify --apply');
  });
});

describe('consumer:uninstall', () => {
  it('requires the exact installation confirmation before deleting data', async () => {
    const { state } = await initializedState();
    const { runner, calls } = recordingRunner();
    await expect(
      runConsumerUninstallCli(
        ['--state', state, '--state-bucket', bucket, '--delete-data', '--apply'],
        runner,
      ),
    ).rejects.toThrow('--confirm-installation pilot');
    const preview = (await runConsumerUninstallCli(
      ['--state', state, '--state-bucket', bucket],
      runner,
    )) as { applied: boolean; steps: Array<{ status: string; destroysData: boolean }> };
    expect(preview.applied).toBe(false);
    expect(preview.steps.every((step) => step.status === 'planned' && !step.destroysData)).toBe(
      true,
    );
    expect(calls).toHaveLength(0);
    const applied = (await runConsumerUninstallCli(
      [
        '--state',
        state,
        '--state-bucket',
        bucket,
        '--delete-data',
        '--confirm-installation',
        'pilot',
        '--apply',
      ],
      runner,
    )) as { completed: boolean };
    expect(applied.completed).toBe(true);
    expect(calls.some((call) => call.includes('firestore databases delete'))).toBe(true);
    expect(calls.some((call) => call.includes(`gs://${bucket}`))).toBe(false);
  });
});
