import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  bindArchiveMaintenanceReceipt,
  verifySucceededArchiveObservation,
} from './owner-release-archive-handoff.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  SERVICE_ROOT,
} from './owner-release-current-snapshot.js';
import {
  maintenanceRunName,
  maintenanceWorkflowPath,
  maintenanceWorkflowRef,
} from './owner-release-maintenance-run.js';

const source = 'a'.repeat(40);
const runId = '12345';

function metadata(change: Record<string, unknown> = {}, expired = false) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.github.com');
    expect(url.pathname).toMatch(
      /^\/repos\/bmson\/assistant\/actions\/runs\/12345(?:\/artifacts)?$/,
    );
    const result = url.pathname.endsWith('/artifacts')
      ? {
          total_count: 1,
          artifacts: [
            { id: 5789, name: `${maintenanceRunName}-12345-1`, expired, size_in_bytes: 1337 },
          ],
        }
      : {
          id: 12345,
          head_sha: source,
          head_branch: 'main',
          path: maintenanceWorkflowPath,
          event: 'workflow_dispatch',
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          updated_at: '2026-11-19T23:00:01Z',
          repository: { full_name: 'bmson/assistant' },
          head_repository: { full_name: 'bmson/assistant' },
          ...change,
        };
    return new Response(JSON.stringify(result));
  });
}

describe('archive promotion observation', () => {
  it('downloads the selected ID directly into the path consumed by the normal release', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/deploy.yml', import.meta.url),
      'utf8',
    );
    const steps = workflow.split('      - name: ');
    const download = steps.find((step) =>
      step.startsWith('Download the exact archive maintenance observation'),
    );
    expect(download).toContain(
      `artifact-ids: \${{ steps.archive_observation.outputs.artifact_id }}`,
    );
    expect(download).toContain('merge-multiple: true');
    expect(download).toContain(`path: \${{ runner.temp }}/archive-maintenance`);
    const prepare = steps.findIndex((step) =>
      step.startsWith('Bind the maintained native pair and archive'),
    );
    const mutate = steps.findIndex((step) =>
      step.startsWith('Release Firestore pair with delivery guard'),
    );
    expect(prepare).toBeGreaterThan(0);
    expect(mutate).toBeGreaterThan(prepare);
    expect(steps[prepare]).toContain('owner-release-archive-handoff.ts --prepare');
  });

  it('selects an immutable artifact ID from the exact successful attempt', async () => {
    const request = metadata();
    const result = await verifySucceededArchiveObservation(runId, source, 'test-token', request);
    expect(result.artifactId).toBe('5789');
    expect(request.mock.calls.length).toBe(2);
  });

  it('refuses reruns, unrelated workflows, failed runs and expired artifacts', async () => {
    for (const request of [
      metadata({ run_attempt: 2 }),
      metadata({ path: '.github/workflows/deploy.yml' }),
      metadata({ conclusion: 'failure' }),
      metadata({}, true),
    ]) {
      await expect(
        verifySucceededArchiveObservation(runId, source, 'test-token', request),
      ).rejects.toThrow();
    }
  });

  it('requires exact reviewed recovery receipt and both native roles', () => {
    const recoveryReceiptSha256 = '2'.repeat(64);
    const originals = {
      agent: {
        revision: 'assistant-agent-old',
        serviceUidSha256: bootstrapDigest('agent-uid'),
        revisionUidSha256: '3'.repeat(64),
        parent: `sha256:${'4'.repeat(64)}`,
        child: `sha256:${'5'.repeat(64)}`,
      },
      web: {
        revision: 'assistant-web-old',
        serviceUidSha256: bootstrapDigest('web-uid'),
        revisionUidSha256: '6'.repeat(64),
        parent: `sha256:${'7'.repeat(64)}`,
        child: `sha256:${'8'.repeat(64)}`,
      },
    };
    const nativeBinding = { roles: originals };
    const current = {
      format: 1,
      kind: 'disabled-bootstrap',
      source,
      recoveryReceiptSha256,
      closureReceiptSha256: 'c'.repeat(64),
      drainReceiptSha256: 'd'.repeat(64),
      services: {
        agent: {
          uid: 'agent-uid',
          revision: originals.agent.revision,
          service: `${SERVICE_ROOT}agent`,
        },
        web: { uid: 'web-uid', revision: originals.web.revision, service: `${SERVICE_ROOT}web` },
      },
    } as BootstrapReceipt;
    const evidence = {
      runId,
      runIdentitySha256: 'a'.repeat(64),
      completedAt: 100,
      buildRunId: '666',
      candidateBuildSha256: '9'.repeat(64),
      candidateReviewSha256: '0'.repeat(64),
      packSha256: '1'.repeat(64),
      nativeBinding,
      targets: originals,
    };
    const receipt = {
      format: 1,
      kind: maintenanceRunName,
      source,
      workflowSha: source,
      runId,
      workflowRef: maintenanceWorkflowRef,
      attempt: '1',
      runIdentitySha256: evidence.runIdentitySha256,
      intentSha256: 'f'.repeat(64),
      candidateBuildRunId: evidence.buildRunId,
      candidateBuildSha256: evidence.candidateBuildSha256,
      candidateReviewSha256: evidence.candidateReviewSha256,
      packSha256: evidence.packSha256,
      nativeBindingSha256: bootstrapDigest(nativeBinding),
      recoveryEvidenceSha256: recoveryReceiptSha256,
      archivedReadbackSha256: 'e'.repeat(64),
      archiveGeneration: '1234',
      archiveObjectSha256: 'a'.repeat(64),
      observedAt: 55,
      expiresAt: 150,
      recoveryTargetsReadBack: true,
      mutationAuthorized: false,
      admissionChangePerformed: false,
      original: originals,
    };
    const signedEvidence = {
      ...evidence,
      signedMaintenanceRunId: runId,
      signedMaintenanceReceiptSha256: bootstrapDigest(receipt),
    };
    expect(() =>
      bindArchiveMaintenanceReceipt(receipt, current, {
        ...signedEvidence,
        signedMaintenanceRunId: '54321',
      }),
    ).toThrow();
    expect(() =>
      bindArchiveMaintenanceReceipt(receipt, current, {
        ...signedEvidence,
        signedMaintenanceReceiptSha256: 'f'.repeat(64),
      }),
    ).toThrow();
    expect(bindArchiveMaintenanceReceipt(receipt, current, signedEvidence)).toEqual({
      generation: '1234',
      objectSha256: receipt.archiveObjectSha256,
    });
    for (const invalid of [
      { runId: '4321' },
      { candidateBuildRunId: '667' },
      { recoveryEvidenceSha256: 'b'.repeat(64) },
      { observedAt: 110 },
      { mutationAuthorized: true },
      { original: { ...originals, web: { ...originals.web, child: originals.agent.child } } },
    ]) {
      expect(() =>
        bindArchiveMaintenanceReceipt({ ...receipt, ...invalid }, current, {
          ...signedEvidence,
          signedMaintenanceReceiptSha256: bootstrapDigest({ ...receipt, ...invalid }),
        }),
      ).toThrow();
    }
    expect(() =>
      bindArchiveMaintenanceReceipt(
        receipt,
        {
          ...current,
          services: { ...current.services, web: { ...current.services.web, uid: 'changed' } },
        },
        signedEvidence,
      ),
    ).toThrow();
  });
});
