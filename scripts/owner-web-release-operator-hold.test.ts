import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedResponseJson,
  type HoldFetch,
  verifyOperatorOwnedHold,
} from './owner-web-release-operator-hold.js';

const source = 'a'.repeat(40);
const currentRun = {
  id: 12345,
  run_attempt: 1,
  head_sha: source,
  event: 'workflow_dispatch',
  status: 'in_progress',
};
const WRITERS = [
  'deploy.yml',
  'cleanup.yml',
  'owner-web-tag-retirement.yml',
  'owner-web-traffic-reconciliation.yml',
  'prepare-owner-editor-index.yml',
  'owner-editor-v1-maintenance.yml',
  'workspace-import.yml',
];
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'owner-hold-test-'));
  scratch.push(directory);
  writeFileSync(join(directory, 'owner-web-tag-github-token'), 'test-token', { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_SHA: source,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'release',
    RUNNER_TEMP: directory,
    CURRENT_ONLY_CLEANUP: 'false',
  };
  const identity = { source, runId: '12345', attempt: '1' };
  const requests: string[] = [];
  const workflowStates: Record<string, string> = {
    'deploy.yml': 'disabled_manually',
    'cleanup.yml': 'disabled_manually',
    'workspace-import.yml': 'disabled_manually',
  };
  const request: HoldFetch = async (url) => {
    requests.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith('/actions/workflows/deploy.yml'))
      return { id: 1, state: workflowStates['deploy.yml'] };
    if (path.endsWith('/actions/workflows/cleanup.yml'))
      return { id: 2, state: workflowStates['cleanup.yml'] };
    if (path.endsWith('/actions/workflows/workspace-import.yml'))
      return { id: 3, state: workflowStates['workspace-import.yml'] };
    if (path.includes('/actions/workflows/')) {
      const match = /\/actions\/workflows\/([^/]+)\/runs$/.exec(path);
      if (!match) throw new Error(`Unexpected workflow endpoint: ${path}`);
      const workflow = match[1];
      const status = new URL(url).searchParams.get('status');
      return {
        total_count: workflow === 'deploy.yml' && status === 'in_progress' ? 1 : 0,
        workflow_runs: workflow === 'deploy.yml' && status === 'in_progress' ? [currentRun] : [],
      };
    }
    if (path.endsWith('/attempts/1/jobs'))
      return {
        total_count: 1,
        jobs: [{ name: 'release', status: 'in_progress' }],
      };
    throw new Error(`Unexpected API request: ${path}`);
  };
  return { directory, env, identity, request, requests, workflowStates };
}

describe('operator-owned BASIC5 workflow holds', () => {
  it('binds effective cleanup=false and censuses every mutating workflow across active states', async () => {
    const test = fixture();
    const result = await verifyOperatorOwnedHold(test.identity, test.env, test.request, false);
    expect(result.cleanupVariable).toBe('false');
    const receipt = JSON.parse(
      readFileSync(join(test.directory, 'owner-web-release-hold-12345-1.json'), 'utf8'),
    );
    expect(receipt).toMatchObject({
      source,
      runId: '12345',
      attempt: '1',
      job: 'release',
      cleanupVariableBefore: 'false',
      workspaceImportId: 3,
      workspaceImportBefore: 'disabled_manually',
    });
    const watchedRuns = test.requests.filter((url) => url.includes('/runs?status='));
    expect(watchedRuns).toHaveLength(WRITERS.length * ACTIVE.length);
    for (const workflow of WRITERS) {
      for (const status of ACTIVE) {
        expect(
          watchedRuns.some((url) =>
            url.includes(`/actions/workflows/${workflow}/runs?status=${status}&`),
          ),
        ).toBe(true);
      }
    }
    expect(test.requests.some((url) => url.includes('/actions/variables/'))).toBe(false);
    expect(
      watchedRuns.some(
        (url) =>
          url.includes('owner-editor-release-inventory.yml') ||
          url.includes('workspace-export.yml'),
      ),
    ).toBe(false);
  });

  it('blocks a queued manual traffic correction while deploy and cleanup are held', async () => {
    const test = fixture();
    const request: HoldFetch = async (url, token) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/owner-web-traffic-reconciliation.yml/runs'))
        return {
          total_count: 1,
          workflow_runs: [
            {
              id: 12346,
              run_attempt: 1,
              head_sha: source,
              event: 'workflow_dispatch',
              status: new URL(url).searchParams.get('status'),
            },
          ],
        };
      return test.request(url, token);
    };
    await expect(verifyOperatorOwnedHold(test.identity, test.env, request, false)).rejects.toThrow(
      'Competing release run blocks native phase',
    );
  });

  it('captures workspace-import prior state and requires manual disable readback', async () => {
    const test = fixture();
    test.workflowStates['workspace-import.yml'] = 'active';
    await expect(
      verifyOperatorOwnedHold(test.identity, test.env, test.request, false),
    ).rejects.toThrow('Operator workflow hold changed; release is held');
    const receiptPath = join(test.directory, 'owner-web-release-hold-12345-1.json');
    expect(JSON.parse(readFileSync(receiptPath, 'utf8')).workspaceImportBefore).toBe('active');

    test.workflowStates['workspace-import.yml'] = 'disabled_manually';
    await expect(
      verifyOperatorOwnedHold(test.identity, test.env, test.request, false),
    ).resolves.toMatchObject({ workspaceImportWorkflowId: 3 });
  });

  it('blocks an already queued workspace import even when its workflow is disabled', async () => {
    const test = fixture();
    const request: HoldFetch = async (url, token) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/workspace-import.yml/runs'))
        return {
          total_count: 1,
          workflow_runs: [
            {
              id: 12347,
              run_attempt: 1,
              head_sha: source,
              event: 'workflow_dispatch',
              status: new URL(url).searchParams.get('status'),
            },
          ],
        };
      return test.request(url, token);
    };
    await expect(verifyOperatorOwnedHold(test.identity, test.env, request, false)).rejects.toThrow(
      'Competing release run blocks native phase',
    );
  });

  it('rejects a changed effective cleanup snapshot before making any API request', async () => {
    const test = fixture();
    test.env.CURRENT_ONLY_CLEANUP = 'true';
    await expect(
      verifyOperatorOwnedHold(test.identity, test.env, test.request, false),
    ).rejects.toThrow('Operator hold identity mismatch');
    expect(test.requests).toEqual([]);
  });

  it('bounds streamed response bytes', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(33));
          controller.close();
        },
      }),
    );
    await expect(boundedResponseJson(response, 32, 100)).rejects.toThrow(
      'Operator hold unavailable',
    );
  });

  it('decodes a bounded successful response', async () => {
    const response = new Response('{"state":"disabled_manually"}');
    await expect(boundedResponseJson(response, 64, 100)).resolves.toEqual({
      state: 'disabled_manually',
    });
  });

  it('rejects an error response without waiting for stalled body cancellation', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          return new Promise<void>(() => undefined);
        },
      }),
      { status: 403 },
    );
    await expect(boundedResponseJson(response, 64, 10)).rejects.toThrow(
      'Operator hold unavailable',
    );
  });

  it('bounds a stalled body even if cancellation does not settle', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          return new Promise<void>(() => undefined);
        },
      }),
    );
    await expect(boundedResponseJson(response, 64, 10)).rejects.toThrow(
      'Operator hold unavailable',
    );
  });
});
