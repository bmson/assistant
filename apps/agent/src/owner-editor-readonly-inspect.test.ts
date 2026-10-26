import { createHash, randomUUID } from 'node:crypto';
import type { ReadOnlyJsonLease } from '@assistant/firestore/owner-editor-readonly';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOwnerEditorReadOnlyInspectionLease,
  runOwnerEditorReadOnlyInspectCli,
} from './owner-editor-readonly-inspect.js';

afterEach(() => vi.useRealTimers());

/** These API payloads are invented fixtures, never cloud observations. */
function fixture() {
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      indexes: [
        {
          collectionGroup: 'contacts',
          queryScope: 'COLLECTION',
          fields: [
            { fieldPath: 'name', order: 'ASCENDING' },
            { fieldPath: 'createdAt', order: 'ASCENDING' },
          ],
        },
      ],
      fieldOverrides: [],
    }),
  );
  const expectedRequest = {
    action: 'inspect' as const,
    sourceSHA: 'a'.repeat(40),
    project: 'example-project',
    database: '(default)',
    installationId: 'example-installation',
    ownerId: randomUUID(),
    agentImageDigest: `sha256:${'b'.repeat(64)}`,
    agentRuntimeServiceAccount: 'maintenance@example-project.iam.gserviceaccount.com',
    webReleaseSHA: 'c'.repeat(40),
    agentReleaseSHA: 'a'.repeat(40),
    indexManifestSHA256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
  const execution = {
    project: expectedRequest.project,
    region: 'us-central1',
    job: 'maintenance',
    execution: 'run-one',
    runtimeServiceAccount: expectedRequest.agentRuntimeServiceAccount,
    imageUri: `us-central1-docker.pkg.dev/example-project/maintenance/agent@${expectedRequest.agentImageDigest}`,
  };
  const job = 'projects/example-project/locations/us-central1/jobs/maintenance';
  const run = `${job}/executions/run-one`;
  const containers = [{ name: 'maintenance', image: execution.imageUri }];
  const calls: URL[] = [];
  const disposal = vi.fn(async () => undefined);
  const clientLease: ReadOnlyJsonLease = {
    client: {
      async get(url) {
        calls.push(new URL(url));
        if (url.pathname.endsWith('/executions/run-one'))
          return {
            name: run,
            uid: '11111111-2222-4333-8444-555555555555',
            job,
            parallelism: 1,
            taskCount: 1,
            template: {
              serviceAccount: execution.runtimeServiceAccount,
              maxRetries: 0,
              containers,
            },
          };
        if (url.pathname.endsWith('/tasks'))
          return {
            tasks: [
              {
                name: `${run}/tasks/opaque-task-7`,
                uid: '66666666-7777-4888-8999-000000000000',
                job,
                execution: run,
                index: 0,
                retried: 0,
                maxRetries: 0,
                serviceAccount: execution.runtimeServiceAccount,
                containers,
              },
            ],
          };
        if (url.pathname.endsWith('/indexes'))
          return {
            indexes: [
              {
                name: 'projects/example-project/databases/(default)/collectionGroups/contacts/indexes/fixture',
                queryScope: 'COLLECTION',
                state: 'READY',
                fields: [
                  { fieldPath: 'name', order: 'ASCENDING' },
                  { fieldPath: 'createdAt', order: 'ASCENDING' },
                  { fieldPath: '__name__', order: 'ASCENDING' },
                ],
              },
            ],
          };
        return { fields: [] };
      },
    },
    disposeClients: disposal,
  };
  const signals = {
    CLOUD_RUN_JOB: 'maintenance',
    CLOUD_RUN_EXECUTION: 'run-one',
    CLOUD_RUN_TASK_INDEX: '0',
    CLOUD_RUN_TASK_ATTEMPT: '0',
    CLOUD_RUN_TASK_COUNT: '1',
  };
  const config = { expectedRequest, execution, manifestBytes };
  const factory = vi.fn(() =>
    createOwnerEditorReadOnlyInspectionLease(config, signals, () => clientLease),
  );
  const input = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  return { config, calls, disposal, factory, input, signals };
}

describe('inspect-only CLI with real parsers and invented HTTP responses', () => {
  it('reports observations while keeping provenance, global coverage and mutation unsupported', async () => {
    const f = fixture();
    const result = await runOwnerEditorReadOnlyInspectCli(f.input(f.config.expectedRequest), [], {
      expectedRequest: f.config.expectedRequest,
      createLease: f.factory,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      execution: { recordMatchesExpected: true, callerProvenance: 'unsupported' },
      indexes: { scopedIndexParity: 'matches' },
      runningImageBits: 'unverified',
      globalIndexReadiness: 'unsupported_incomplete_field_inventory',
      coreInspection: 'unsupported_unverified_caller',
      mutationAuthorized: false,
      holdManagement: 'unsupported',
      adcCredentialSource: 'unverified',
    });
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.disposal).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(4);
    expect(result.stdout).not.toContain('opaque-task-7');
    expect(result.stdout).not.toContain('iam.gserviceaccount.com');
  });

  it.each([
    'arguments',
    'unknown_fields',
    'wrong_target',
    'invalid_json',
    'invalid_utf8',
    'oversized',
  ])('rejects %s before client construction', async (kind) => {
    const f = fixture();
    let input = f.input(f.config.expectedRequest);
    let args: string[] = [];
    if (kind === 'arguments') args = ['--project=other'];
    if (kind === 'unknown_fields') input = f.input({ ...f.config.expectedRequest, injected: true });
    if (kind === 'wrong_target')
      input = f.input({ ...f.config.expectedRequest, project: 'another-project' });
    if (kind === 'invalid_json') input = new TextEncoder().encode('{');
    if (kind === 'invalid_utf8') input = new Uint8Array([0xc3, 0x28]);
    if (kind === 'oversized') input = new Uint8Array(4097);
    const result = await runOwnerEditorReadOnlyInspectCli(input, args, {
      expectedRequest: f.config.expectedRequest,
      createLease: f.factory,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a valid mutation request before constructing clients', async () => {
    const f = fixture();
    const result = await runOwnerEditorReadOnlyInspectCli(
      f.input({
        ...f.config.expectedRequest,
        action: 'enable',
        operationId: randomUUID(),
        targetEpoch: randomUUID(),
        requestDigest: 'd'.repeat(64),
        expectedEpochStateDigestOrAbsent: null,
        expectedEpochNativeVersionOrAbsent: null,
        expectedOwnerNativeVersion: { seconds: 1, nanoseconds: 0 },
        expectedPrivacyDigest: 'e'.repeat(64),
        expectedLineageDigest: 'f'.repeat(64),
        expectedLineageNativeVersion: { seconds: 1, nanoseconds: 0 },
        preflightDigest: '1'.repeat(64),
        maintenanceDrainEvidenceDigest: '2'.repeat(64),
        checkpointEvidenceDigest: '3'.repeat(64),
      }),
      [],
      { expectedRequest: f.config.expectedRequest, createLease: f.factory },
    );
    expect(result.stderr).toBe('owner-editor-inspect:inspect_only');
    expect(f.factory).not.toHaveBeenCalled();
  });

  it('freezes configured pins before an asynchronous observation', async () => {
    const f = fixture();
    const lease = f.factory();
    f.config.execution.execution = 'attacker-run';
    f.signals.CLOUD_RUN_EXECUTION = 'attacker-run';
    f.config.manifestBytes.fill(0);
    const result = await lease.observe(new AbortController().signal);
    expect(result.execution.recordMatchesExpected).toBe(true);
    expect(result.execution.runtimeSignalsMatchExpected).toBe(true);
    expect(result.indexes.scopedIndexParity).toBe('matches');
    await lease.disposeClients();
  });

  it('maps construction and provider errors to fixed text', async () => {
    const f = fixture();
    const result = await runOwnerEditorReadOnlyInspectCli(f.input(f.config.expectedRequest), [], {
      expectedRequest: f.config.expectedRequest,
      createLease() {
        throw new Error('private token');
      },
    });
    expect(result.stderr).toBe('owner-editor-inspect:inspection_unavailable');
    expect(result.stdout).toBe('');
  });

  it('bounds disposal and reports cleanup unknown without claiming cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = fixture();
    const lease = f.factory();
    const disposal = vi.fn(() => new Promise<void>(() => undefined));
    const pending = runOwnerEditorReadOnlyInspectCli(f.input(f.config.expectedRequest), [], {
      expectedRequest: f.config.expectedRequest,
      createLease: () => ({ observe: lease.observe, disposeClients: disposal }),
    });
    await vi.advanceTimersByTimeAsync(10_001);
    const result = await pending;
    expect(result.stderr).toBe('owner-editor-inspect:cleanup_unknown');
    expect(result.stdout).toBe('');
    expect(disposal).toHaveBeenCalledTimes(1);
    await lease.disposeClients();
  });
});
