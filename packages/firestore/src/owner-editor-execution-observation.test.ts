import { describe, expect, it } from 'vitest';
import {
  type OwnerEditorExecutionExpectation,
  observeOwnerEditorExecution,
} from './owner-editor-execution-observation.js';
import type { ReadOnlyJsonClient } from './owner-editor-readonly-http.js';

const imageUri = `us-west1-docker.pkg.dev/example-project/maintenance/runner@sha256:${'a'.repeat(64)}`;
const expected: OwnerEditorExecutionExpectation = {
  project: 'example-project',
  region: 'us-west1',
  job: 'owner-editor-maintenance',
  execution: 'maintenance-20261026-a1b2',
  runtimeServiceAccount: 'maintenance-reader@example-project.iam.gserviceaccount.com',
  imageUri,
};

function executionRecord(overrides: Record<string, unknown> = {}) {
  return {
    name: 'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2',
    uid: 'exec-uid-123',
    job: 'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance',
    parallelism: 1,
    taskCount: 1,
    template: {
      serviceAccount: expected.runtimeServiceAccount,
      maxRetries: 0,
      containers: [{ name: 'runner', image: expected.imageUri }],
    },
    ...overrides,
  };
}

function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    name: 'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2/tasks/0',
    uid: '66666666-7777-4888-8999-000000000000',
    job: 'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance',
    execution:
      'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2',
    index: 0,
    retried: 0,
    serviceAccount: expected.runtimeServiceAccount,
    maxRetries: 0,
    containers: [{ name: 'runner', image: expected.imageUri }],
    ...overrides,
  };
}

function taskRecordWithImplicitZeroDefaults(): Record<string, unknown> {
  const task: Record<string, unknown> = taskRecord();
  delete task.index;
  delete task.retried;
  delete task.maxRetries;
  return task;
}

function runtimeSignals(overrides: Record<string, string | undefined> = {}) {
  return {
    CLOUD_RUN_JOB: expected.job,
    CLOUD_RUN_EXECUTION: expected.execution,
    CLOUD_RUN_TASK_INDEX: '0',
    CLOUD_RUN_TASK_ATTEMPT: '0',
    CLOUD_RUN_TASK_COUNT: '1',
    ...overrides,
  };
}

class FixtureClient implements ReadOnlyJsonClient {
  readonly urls: URL[] = [];

  constructor(private readonly responses: unknown[]) {}

  async get(url: URL): Promise<unknown> {
    this.urls.push(new URL(url));
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }
}

function validClient(tasks: unknown[] = [taskRecord()]) {
  return new FixtureClient([executionRecord(), { tasks, nextPageToken: '' }]);
}

type RecordMismatchCase = {
  label: string;
  execution?: () => Record<string, unknown>;
  task?: () => Record<string, unknown>;
};

const recordMismatchCases: RecordMismatchCase[] = [
  {
    label: 'project in execution resource',
    execution: () =>
      executionRecord({
        name: 'projects/other/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2',
      }),
  },
  {
    label: 'region in execution resource',
    execution: () =>
      executionRecord({
        name: 'projects/example-project/locations/europe-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2',
      }),
  },
  {
    label: 'wrong job',
    execution: () =>
      executionRecord({ job: 'projects/example-project/locations/us-west1/jobs/other' }),
  },
  { label: 'wrong execution uid', execution: () => executionRecord({ uid: '' }) },
  {
    label: 'wrong service account',
    execution: () =>
      executionRecord({
        template: {
          serviceAccount: 'other@example-project.iam.gserviceaccount.com',
          maxRetries: 0,
          containers: [{ name: 'runner', image: expected.imageUri }],
        },
      }),
  },
  { label: 'wrong parallelism', execution: () => executionRecord({ parallelism: 2 }) },
  { label: 'wrong task count', execution: () => executionRecord({ taskCount: 2 }) },
  {
    label: 'wrong execution image',
    execution: () =>
      executionRecord({
        template: {
          serviceAccount: expected.runtimeServiceAccount,
          maxRetries: 0,
          containers: [
            {
              name: 'runner',
              image: 'us-west1-docker.pkg.dev/example-project/maintenance/runner:release',
            },
          ],
        },
      }),
  },
  {
    label: 'tagged task image',
    task: () =>
      taskRecord({
        containers: [
          {
            name: 'runner',
            image: 'us-west1-docker.pkg.dev/example-project/maintenance/runner:release',
          },
        ],
      }),
  },
  {
    label: 'wrong task digest',
    task: () =>
      taskRecord({
        containers: [
          {
            name: 'runner',
            image: `us-west1-docker.pkg.dev/example-project/maintenance/runner@sha256:${'b'.repeat(64)}`,
          },
        ],
      }),
  },
  { label: 'non-UUIDv4 task uid', task: () => taskRecord({ uid: 'task-uid-456' }) },
  {
    label: 'wrong task project',
    task: () =>
      taskRecord({
        name: 'projects/other/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2/tasks/0',
      }),
  },
  {
    label: 'wrong task region',
    task: () =>
      taskRecord({
        name: 'projects/example-project/locations/europe-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2/tasks/0',
      }),
  },
  {
    label: 'wrong task job',
    task: () => taskRecord({ job: 'projects/example-project/locations/us-west1/jobs/other' }),
  },
  {
    label: 'wrong task execution',
    task: () =>
      taskRecord({
        execution:
          'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/other',
      }),
  },
  {
    label: 'task resource under another execution',
    task: () =>
      taskRecord({
        name: 'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/other/tasks/task-0',
      }),
  },
  { label: 'wrong task uid', task: () => taskRecord({ uid: '' }) },
  { label: 'wrong task index', task: () => taskRecord({ index: 1 }) },
  { label: 'retried task', task: () => taskRecord({ retried: 1 }) },
  {
    label: 'wrong task principal',
    task: () => taskRecord({ serviceAccount: 'other@example-project.iam.gserviceaccount.com' }),
  },
  {
    label: 'missing execution maxRetries',
    execution: () =>
      executionRecord({
        template: {
          serviceAccount: expected.runtimeServiceAccount,
          containers: [{ name: 'runner', image: expected.imageUri }],
        },
      }),
  },
  { label: 'null task index', task: () => taskRecord({ index: null }) },
  { label: 'string task retry count', task: () => taskRecord({ retried: '0' }) },
  { label: 'null task maxRetries', task: () => taskRecord({ maxRetries: null }) },
];

const runtimeSignalMismatchCases = [
  ['job', { CLOUD_RUN_JOB: 'other-job' }],
  ['execution', { CLOUD_RUN_EXECUTION: 'other-execution' }],
  ['task index', { CLOUD_RUN_TASK_INDEX: '1' }],
  ['task attempt', { CLOUD_RUN_TASK_ATTEMPT: '1' }],
  ['task count', { CLOUD_RUN_TASK_COUNT: '2' }],
] as const;

const apiFailureCases: Array<[string, Error]> = [
  ['permission denied', Object.assign(new Error('403 private detail'), { status: 403 })],
  ['timeout', new Error('timeout private detail')],
];

const malformedResponseCases: Array<[string, unknown[]]> = [
  ['execution response is not an object', [null]],
  ['task list has a malformed task field', [executionRecord(), { tasks: 'not-an-array' }]],
];

describe('Cloud Run execution observation (API fixtures only)', () => {
  it('compares the fixed execution and one task while exposing only safe assessment fields', async () => {
    const client = validClient();
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);

    expect(result).toEqual({
      schemaVersion: 'owner-editor-execution-observation/v1',
      status: 'observed',
      diagnostic: 'none',
      recordMatchesExpected: true,
      runtimeSignalsMatchExpected: true,
      callerProvenance: 'unsupported',
      runningImageBits: 'unverified',
      mutationAuthorized: false,
    });
    expect(client.urls.map((url) => `${url.origin}${url.pathname}`)).toEqual([
      'https://run.googleapis.com/v2/projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2',
      'https://run.googleapis.com/v2/projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2/tasks',
    ]);
    expect(client.urls[1]?.searchParams.get('pageSize')).toBe('2');
  });

  it.each(recordMismatchCases)(
    'rejects $label without treating the record as proof',
    async (testCase) => {
      const client = new FixtureClient([
        testCase.execution?.() ?? executionRecord(),
        { tasks: [testCase.task?.() ?? taskRecord()], nextPageToken: '' },
      ]);
      const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
      expect(result.status).toBe('observed');
      expect(result.recordMatchesExpected).toBe(false);
      expect(result.mutationAuthorized).toBe(false);
    },
  );

  it('accepts a nonzero opaque task resource ID under the exact execution when index is zero', async () => {
    const client = validClient([
      taskRecord({
        name: 'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2/tasks/task-0-suffix',
      }),
    ]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('observed');
    expect(result.recordMatchesExpected).toBe(true);
  });

  it('accepts omitted Task int32 fields as their implicit zero values', async () => {
    const result = await observeOwnerEditorExecution(
      expected,
      runtimeSignals(),
      validClient([taskRecordWithImplicitZeroDefaults()]),
    );
    expect(result.status).toBe('observed');
    expect(result.recordMatchesExpected).toBe(true);
  });

  it('rejects an error-shaped task page rather than interpreting it as an empty list', async () => {
    const client = new FixtureClient([
      executionRecord(),
      { error: { message: 'private task failure' } },
    ]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toBe('invalid_response');
    expect(JSON.stringify(result)).not.toContain('private task failure');
  });

  it.each([
    'us-west1-docker.pkg.dev/example-project/maintenance/runner:release',
    'https://us-west1-docker.pkg.dev/example-project/maintenance/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'us-west1-docker.pkg.dev/example-project/maintenance/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?x=1',
    'us-west1-docker.pkg.dev/example-project/maintenance/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#fragment',
    'us-central1-docker.pkg.dev/example-project/maintenance/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'us-west1-docker.pkg.dev/other-project/maintenance/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])('rejects a noncanonical expected image reference: %s', async (image) => {
    const client = validClient();
    const result = await observeOwnerEditorExecution(
      { ...expected, imageUri: image },
      runtimeSignals(),
      client,
    );
    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toBe('invalid_expected_input');
    expect(client.urls).toEqual([]);
  });

  it.each(runtimeSignalMismatchCases)(
    'reports a %s runtime signal mismatch separately without echoing values',
    async (_label, overrides) => {
      const result = await observeOwnerEditorExecution(
        expected,
        runtimeSignals(overrides),
        validClient(),
      );
      expect(result.recordMatchesExpected).toBe(true);
      expect(result.runtimeSignalsMatchExpected).toBe(false);
      expect(result.diagnostic).toBe('runtime_signal_mismatch');
      expect(result.callerProvenance).toBe('unsupported');
      expect(result.runningImageBits).toBe('unverified');
      expect(result.mutationAuthorized).toBe(false);
    },
  );

  it('does not echo runtime environment signal values', async () => {
    const secretSentinel = 'private-runtime-value-should-not-appear';
    const result = await observeOwnerEditorExecution(
      expected,
      runtimeSignals({ CLOUD_RUN_TASK_ATTEMPT: secretSentinel }),
      validClient(),
    );
    expect(JSON.stringify(result)).not.toContain(secretSentinel);
  });

  it('rejects exactly two tasks because the expected execution is single-task', async () => {
    const client = validClient([
      taskRecord(),
      taskRecord({
        index: 1,
        uid: '77777777-8888-4888-8999-000000000000',
        name: 'projects/example-project/locations/us-west1/jobs/owner-editor-maintenance/executions/maintenance-20261026-a1b2/tasks/task-1',
      }),
    ]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('observed');
    expect(result.recordMatchesExpected).toBe(false);
    expect(result.mutationAuthorized).toBe(false);
  });

  it('rejects more than two tasks without growing the observation bound', async () => {
    const client = validClient([
      taskRecord(),
      taskRecord({ uid: '77777777-8888-4888-8999-000000000000' }),
      taskRecord({ uid: '00000000-1111-4111-8111-111111111111' }),
    ]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toBe('invalid_response');
    expect(client.urls).toHaveLength(2);
  });

  it('follows the exact execution task resource, preserving pageSize and encoding page tokens', async () => {
    const client = new FixtureClient([
      executionRecord(),
      { tasks: [], nextPageToken: 'cursor/one' },
      { tasks: [taskRecord()], nextPageToken: '' },
    ]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.recordMatchesExpected).toBe(true);
    expect(client.urls[1]?.searchParams.get('pageSize')).toBe('2');
    expect(client.urls[2]?.pathname).toBe(`${client.urls[1]?.pathname}`);
    expect(client.urls[2]?.searchParams.get('pageSize')).toBe('2');
    expect(client.urls[2]?.searchParams.get('pageToken')).toBe('cursor/one');
  });

  it('rejects repeated pagination tokens and caps task pages at eight', async () => {
    const repeated = new FixtureClient([
      executionRecord(),
      { tasks: [], nextPageToken: 'repeat' },
      { tasks: [], nextPageToken: 'repeat' },
    ]);
    const repeatedResult = await observeOwnerEditorExecution(expected, runtimeSignals(), repeated);
    expect(repeatedResult.status).toBe('unavailable');
    expect(repeatedResult.diagnostic).toBe('repeated_page_token');

    const pages: unknown[] = [executionRecord()];
    for (let index = 0; index < 8; index += 1) {
      pages.push({ tasks: [], nextPageToken: `page-${index}` });
    }
    const capped = new FixtureClient(pages);
    const cappedResult = await observeOwnerEditorExecution(expected, runtimeSignals(), capped);
    expect(cappedResult.status).toBe('unavailable');
    expect(cappedResult.diagnostic).toBe('pagination_limit');
    expect(capped.urls).toHaveLength(9);
  });

  it.each(apiFailureCases)('returns a bounded unavailable receipt for %s', async (_case, error) => {
    const client = new FixtureClient([error]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toBe('api_unavailable');
    expect(result.runtimeSignalsMatchExpected).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private detail');
    expect(client.urls).toHaveLength(1);
  });

  it('does not report a partial match when task listing fails after the execution read', async () => {
    const client = new FixtureClient([executionRecord(), new Error('403 task permission detail')]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toBe('api_unavailable');
    expect(result.recordMatchesExpected).toBe(false);
    expect(result.runtimeSignalsMatchExpected).toBe(true);
    expect(JSON.stringify(result)).not.toContain('task permission detail');
    expect(client.urls).toHaveLength(2);
  });

  it.each(malformedResponseCases)('fails closed when %s', async (_case, responses) => {
    const client = new FixtureClient(responses);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toBe('invalid_response');
  });

  it('requires the task array to stay within the requested page size', async () => {
    const client = new FixtureClient([
      executionRecord(),
      {
        tasks: [
          taskRecord(),
          taskRecord({ uid: '77777777-8888-4888-8999-000000000000' }),
          taskRecord({ uid: '00000000-1111-4111-8111-111111111111' }),
        ],
      },
    ]);
    const result = await observeOwnerEditorExecution(expected, runtimeSignals(), client);
    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toBe('invalid_response');
    expect(client.urls).toHaveLength(2);
  });

  it('treats an omitted repeated task field as empty, but rejects explicit null', async () => {
    const omitted = new FixtureClient([executionRecord(), { nextPageToken: '' }]);
    const omittedResult = await observeOwnerEditorExecution(expected, runtimeSignals(), omitted);
    expect(omittedResult.status).toBe('observed');
    expect(omittedResult.recordMatchesExpected).toBe(false);

    const nullTasks = new FixtureClient([executionRecord(), { tasks: null, nextPageToken: '' }]);
    const nullResult = await observeOwnerEditorExecution(expected, runtimeSignals(), nullTasks);
    expect(nullResult.status).toBe('unavailable');
    expect(nullResult.diagnostic).toBe('invalid_response');
  });
});
