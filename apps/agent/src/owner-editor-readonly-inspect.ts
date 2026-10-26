import { createHash } from 'node:crypto';
import {
  createAdcOwnerEditorReadOnlyJsonClient,
  observeOwnerEditorExecution,
  observeOwnerEditorIndexes,
  type ReadOnlyJsonLease,
} from '@assistant/firestore/owner-editor-readonly';
import { z } from 'zod';
import {
  ownerEditorMaintenanceRequestSchema,
  withRpcDeadline,
} from './owner-editor-maintenance.js';

type InspectRequest = Extract<
  ReturnType<typeof ownerEditorMaintenanceRequestSchema.parse>,
  { action: 'inspect' }
>;

export const ownerEditorReadOnlyScope = Object.freeze({
  mode: 'inspect-only-functions',
  executable: 'unsupported_no_trusted_configuration_loader',
  buildIntegration: 'unsupported',
  controllerReceipt: 'unsupported',
  mutation: 'unsupported',
});

export interface OwnerEditorReadOnlyConfiguration {
  /** Independently configured pins, never constructed from stdin or CLI arguments. */
  expectedRequest: InspectRequest;
  execution: Parameters<typeof observeOwnerEditorExecution>[0];
  manifestBytes: Uint8Array;
}

export interface OwnerEditorReadOnlyReceipt {
  schemaVersion: 'owner-editor-readonly-inspect/v1';
  execution: Awaited<ReturnType<typeof observeOwnerEditorExecution>>;
  indexes: Awaited<ReturnType<typeof observeOwnerEditorIndexes>>;
  callerProvenance: 'unsupported';
  runningImageBits: 'unverified';
  sourceProvenance: 'unverified';
  adcCredentialSource: 'unverified';
  globalIndexReadiness: 'unsupported_incomplete_field_inventory';
  coreInspection: 'unsupported_unverified_caller';
  mutationAuthorized: false;
  holdManagement: 'unsupported';
  requestCancellation: 'best_effort';
}

const receiptSchema = z.strictObject({
  schemaVersion: z.literal('owner-editor-readonly-inspect/v1'),
  execution: z.strictObject({
    schemaVersion: z.literal('owner-editor-execution-observation/v1'),
    status: z.enum(['observed', 'unavailable']),
    diagnostic: z.enum([
      'invalid_expected_input',
      'api_unavailable',
      'invalid_response',
      'pagination_limit',
      'repeated_page_token',
      'none',
      'execution_record_mismatch',
      'runtime_signal_mismatch',
    ]),
    recordMatchesExpected: z.boolean(),
    runtimeSignalsMatchExpected: z.boolean(),
    callerProvenance: z.literal('unsupported'),
    runningImageBits: z.literal('unverified'),
    mutationAuthorized: z.literal(false),
  }),
  indexes: z.strictObject({
    schemaVersion: z.literal('owner-editor-index-observation/v1'),
    scopedIndexParity: z.enum(['matches', 'not_ready', 'unknown']),
    manifestSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    counts: z.strictObject({
      expectedCompositeIndexes: z.number().int().min(0).max(1000),
      observedCompositeIndexes: z.number().int().min(0).max(256_000),
      expectedFieldOverrides: z.number().int().min(0).max(1000),
      observedFieldOverrides: z.number().int().min(0).max(256_000),
      collectionGroups: z.number().int().min(0).max(256),
    }),
    diagnostics: z
      .array(
        z.enum([
          'manifest_invalid',
          'target_invalid',
          'observation_failed',
          'scoped_parity_differs',
          'index_build_incomplete',
        ]),
      )
      .max(1),
    globalIndexReadiness: z.literal('unsupported_incomplete_field_inventory'),
  }),
  callerProvenance: z.literal('unsupported'),
  runningImageBits: z.literal('unverified'),
  sourceProvenance: z.literal('unverified'),
  adcCredentialSource: z.literal('unverified'),
  globalIndexReadiness: z.literal('unsupported_incomplete_field_inventory'),
  coreInspection: z.literal('unsupported_unverified_caller'),
  mutationAuthorized: z.literal(false),
  holdManagement: z.literal('unsupported'),
  requestCancellation: z.literal('best_effort'),
});

export interface OwnerEditorReadOnlyInspectionLease {
  observe(signal: AbortSignal): Promise<OwnerEditorReadOnlyReceipt>;
  /** Client disposal only. It never releases an external operation hold. */
  disposeClients(): Promise<void>;
}

function checkedConfiguration(config: OwnerEditorReadOnlyConfiguration): InspectRequest {
  const expected = ownerEditorMaintenanceRequestSchema.parse(config.expectedRequest);
  if (
    expected.action !== 'inspect' ||
    config.execution.project !== expected.project ||
    config.execution.runtimeServiceAccount !== expected.agentRuntimeServiceAccount ||
    !config.execution.imageUri.endsWith(`@${expected.agentImageDigest}`) ||
    config.manifestBytes.byteLength > 2 * 1024 * 1024 ||
    createHash('sha256').update(config.manifestBytes).digest('hex') !== expected.indexManifestSHA256
  )
    throw new Error('Read-only inspection configuration is unavailable');
  return expected;
}

/** Synchronous composition: all ADC and API network work stays inside bounded reads. */
export function createOwnerEditorReadOnlyInspectionLease(
  config: OwnerEditorReadOnlyConfiguration,
  runtimeSignals: Readonly<Record<string, string | undefined>>,
  createClient: () => ReadOnlyJsonLease = createAdcOwnerEditorReadOnlyJsonClient,
): OwnerEditorReadOnlyInspectionLease {
  const expected = checkedConfiguration(config);
  const executionPins = Object.freeze({ ...config.execution });
  const manifestBytes = Uint8Array.from(config.manifestBytes);
  const signals = Object.freeze(
    Object.fromEntries(
      [
        'CLOUD_RUN_JOB',
        'CLOUD_RUN_EXECUTION',
        'CLOUD_RUN_TASK_INDEX',
        'CLOUD_RUN_TASK_ATTEMPT',
        'CLOUD_RUN_TASK_COUNT',
      ].map((key) => [key, runtimeSignals[key]]),
    ),
  );
  const clientLease = createClient();
  return {
    async observe(signal) {
      const client = { get: (url: URL) => clientLease.client.get(url, signal) };
      const [execution, indexes] = await Promise.all([
        observeOwnerEditorExecution(executionPins, signals, client),
        observeOwnerEditorIndexes(
          {
            project: expected.project,
            database: expected.database,
            manifestBytes,
            expectedManifestSha256: expected.indexManifestSHA256,
          },
          client,
        ),
      ]);
      return {
        schemaVersion: 'owner-editor-readonly-inspect/v1',
        execution,
        indexes,
        callerProvenance: 'unsupported',
        runningImageBits: 'unverified',
        sourceProvenance: 'unverified',
        adcCredentialSource: 'unverified',
        globalIndexReadiness: 'unsupported_incomplete_field_inventory',
        coreInspection: 'unsupported_unverified_caller',
        mutationAuthorized: false,
        holdManagement: 'unsupported',
        requestCancellation: 'best_effort',
      };
    },
    disposeClients: () => clientLease.disposeClients(),
  };
}

export type OwnerEditorReadOnlyCliResponse =
  | { exitCode: 0; stdout: string; stderr: '' }
  | { exitCode: 1; stdout: ''; stderr: string };

function failure(code: string): OwnerEditorReadOnlyCliResponse {
  return { exitCode: 1, stdout: '', stderr: `owner-editor-inspect:${code}` };
}

/** No process entrypoint, credential flags, environment loading, or service startup. */
export async function runOwnerEditorReadOnlyInspectCli(
  stdin: Uint8Array,
  argv: readonly string[],
  dependencies: {
    expectedRequest: InspectRequest;
    /** Must construct clients synchronously; it performs no network requests. */
    createLease(): OwnerEditorReadOnlyInspectionLease;
  },
): Promise<OwnerEditorReadOnlyCliResponse> {
  if (argv.length !== 0) return failure('unsupported_arguments');
  if (!(stdin instanceof Uint8Array) || stdin.byteLength > 4096) return failure('invalid_request');
  let request: ReturnType<typeof ownerEditorMaintenanceRequestSchema.parse>;
  let expected: InspectRequest;
  try {
    request = ownerEditorMaintenanceRequestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdin)),
    );
    const pin = ownerEditorMaintenanceRequestSchema.parse(dependencies.expectedRequest);
    if (pin.action !== 'inspect') return failure('invalid_configuration');
    expected = pin;
  } catch {
    return failure('invalid_request');
  }
  if (request.action !== 'inspect') return failure('inspect_only');
  if (JSON.stringify(request) !== JSON.stringify(expected)) return failure('target_mismatch');

  const deadline = Date.now() + 60_000;
  let lease: OwnerEditorReadOnlyInspectionLease;
  try {
    lease = dependencies.createLease();
  } catch {
    return failure('inspection_unavailable');
  }
  const controller = new AbortController();
  let output: string | undefined;
  try {
    // Reuse the core's reviewed 10-second RPC deadline; no new timeout harness.
    const result = await withRpcDeadline(
      () => lease.observe(controller.signal),
      deadline,
      'Read-only inspection',
    );
    output = JSON.stringify(receiptSchema.parse(result));
    if (Buffer.byteLength(output, 'utf8') > 64 * 1024) output = undefined;
  } catch {
    output = undefined;
  } finally {
    controller.abort();
  }
  try {
    // Timing out disposal does not establish that pending ADC work was cancelled.
    await withRpcDeadline(() => lease.disposeClients(), deadline, 'Read-only client disposal');
  } catch {
    return failure('cleanup_unknown');
  }
  if (output === undefined) return failure('inspection_unavailable');
  return { exitCode: 0, stdout: output, stderr: '' };
}
