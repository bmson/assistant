import type { ReadOnlyJsonClient } from './owner-editor-readonly-http.js';

const CLOUD_RUN_API_ORIGIN = 'https://run.googleapis.com/';
const PAGE_SIZE = 2;
const MAX_TASK_PAGES = 8;
const MAX_TASKS = 2;
const MAX_PAGE_TOKEN_LENGTH = 2048;

type UnavailableReason =
  | 'invalid_expected_input'
  | 'api_unavailable'
  | 'invalid_response'
  | 'pagination_limit'
  | 'repeated_page_token';

type Diagnostic =
  | UnavailableReason
  | 'none'
  | 'execution_record_mismatch'
  | 'runtime_signal_mismatch';

export type OwnerEditorExecutionExpectation = Readonly<{
  project: string;
  region: string;
  job: string;
  execution: string;
  runtimeServiceAccount: string;
  imageUri: string;
}>;

export type OwnerEditorExecutionObservation = Readonly<{
  schemaVersion: 'owner-editor-execution-observation/v1';
  status: 'observed' | 'unavailable';
  diagnostic: Diagnostic;
  recordMatchesExpected: boolean;
  runtimeSignalsMatchExpected: boolean;
  callerProvenance: 'unsupported';
  runningImageBits: 'unverified';
  mutationAuthorized: false;
}>;

type ExpectedResources = {
  jobName: string;
  executionName: string;
  job: string;
  execution: string;
  runtimeServiceAccount: string;
  imageUri: string;
};

type TaskPages =
  | { status: 'ok'; tasks: Record<string, unknown>[] }
  | { status: 'unavailable'; reason: UnavailableReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function safeSegment(value: unknown): value is string {
  return (
    boundedString(value, 128) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function matchesArtifactRegistryDigest(
  value: unknown,
  region: string,
  project: string,
): value is string {
  if (!boundedString(value, 1024)) return false;
  const prefix = `${region}-docker.pkg.dev/${project}/`;
  if (!value.startsWith(prefix)) return false;
  const repositoryAndImage = value.slice(prefix.length);
  const separator = repositoryAndImage.indexOf('/');
  if (separator <= 0) return false;
  const repository = repositoryAndImage.slice(0, separator);
  const imageDigest = repositoryAndImage.slice(separator + 1);
  return (
    /^[a-z][a-z0-9-]{0,62}$/.test(repository) &&
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[0-9a-f]{64}$/.test(imageDigest)
  );
}

function taskBelongsToExecution(value: unknown, executionName: string): value is string {
  if (!boundedString(value)) return false;
  const prefix = `${executionName}/tasks/`;
  return value.startsWith(prefix) && safeSegment(value.slice(prefix.length));
}

function taskUidIsUuidV4(value: unknown): value is string {
  return (
    boundedString(value, 36) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function implicitZero(value: unknown): boolean {
  return value === undefined || value === 0;
}

function expectedResources(expected: OwnerEditorExecutionExpectation): ExpectedResources | null {
  if (
    !isRecord(expected) ||
    !safeSegment(expected.project) ||
    !safeSegment(expected.region) ||
    !safeSegment(expected.job) ||
    !safeSegment(expected.execution) ||
    !boundedString(expected.runtimeServiceAccount, 320) ||
    !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(expected.runtimeServiceAccount) ||
    !matchesArtifactRegistryDigest(expected.imageUri, expected.region, expected.project)
  ) {
    return null;
  }

  const jobName = `projects/${expected.project}/locations/${expected.region}/jobs/${expected.job}`;
  const executionName = `${jobName}/executions/${expected.execution}`;
  return {
    jobName,
    executionName,
    job: expected.job,
    execution: expected.execution,
    runtimeServiceAccount: expected.runtimeServiceAccount,
    imageUri: expected.imageUri,
  };
}

function unavailable(
  reason: UnavailableReason,
  runtimeSignalsMatchExpected = false,
): OwnerEditorExecutionObservation {
  return {
    schemaVersion: 'owner-editor-execution-observation/v1',
    status: 'unavailable',
    diagnostic: reason,
    recordMatchesExpected: false,
    runtimeSignalsMatchExpected,
    callerProvenance: 'unsupported',
    runningImageBits: 'unverified',
    mutationAuthorized: false,
  };
}

function observed(
  recordMatchesExpected: boolean,
  runtimeSignalsMatchExpected: boolean,
): OwnerEditorExecutionObservation {
  return {
    schemaVersion: 'owner-editor-execution-observation/v1',
    status: 'observed',
    diagnostic: !recordMatchesExpected
      ? 'execution_record_mismatch'
      : runtimeSignalsMatchExpected
        ? 'none'
        : 'runtime_signal_mismatch',
    recordMatchesExpected,
    runtimeSignalsMatchExpected,
    callerProvenance: 'unsupported',
    runningImageBits: 'unverified',
    mutationAuthorized: false,
  };
}

function runtimeSignalsMatch(
  runtimeSignals: Readonly<Record<string, string | undefined>>,
  expected: ExpectedResources,
): boolean {
  try {
    return (
      runtimeSignals.CLOUD_RUN_JOB === expected.job &&
      runtimeSignals.CLOUD_RUN_EXECUTION === expected.execution &&
      runtimeSignals.CLOUD_RUN_TASK_INDEX === '0' &&
      runtimeSignals.CLOUD_RUN_TASK_ATTEMPT === '0' &&
      runtimeSignals.CLOUD_RUN_TASK_COUNT === '1'
    );
  } catch {
    return false;
  }
}

function taskListUrl(executionName: string, pageToken?: string): URL {
  const url = new URL(`v2/${executionName}/tasks`, CLOUD_RUN_API_ORIGIN);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
  return url;
}

async function listTasks(client: ReadOnlyJsonClient, executionName: string): Promise<TaskPages> {
  const tasks: Record<string, unknown>[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    let body: unknown;
    try {
      body = await client.get(taskListUrl(executionName, pageToken));
    } catch {
      return { status: 'unavailable', reason: 'api_unavailable' };
    }
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== 'tasks' && key !== 'nextPageToken')
    )
      return { status: 'unavailable', reason: 'invalid_response' };
    const pageTasks = body.tasks === undefined ? [] : body.tasks;
    if (!Array.isArray(pageTasks) || pageTasks.length > PAGE_SIZE) {
      return { status: 'unavailable', reason: 'invalid_response' };
    }
    for (const task of pageTasks) {
      if (!isRecord(task)) return { status: 'unavailable', reason: 'invalid_response' };
      tasks.push(task);
      if (tasks.length > MAX_TASKS) return { status: 'unavailable', reason: 'invalid_response' };
      if (tasks.length === MAX_TASKS) return { status: 'ok', tasks };
    }

    const nextPageToken = body.nextPageToken;
    if (nextPageToken === undefined || nextPageToken === '') return { status: 'ok', tasks };
    if (!boundedString(nextPageToken, MAX_PAGE_TOKEN_LENGTH)) {
      return { status: 'unavailable', reason: 'invalid_response' };
    }
    if (seenTokens.has(nextPageToken)) {
      return { status: 'unavailable', reason: 'repeated_page_token' };
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  return { status: 'unavailable', reason: 'pagination_limit' };
}

function hasSingleExpectedContainer(value: unknown, expectedImage: string): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return false;
  // Container metadata names the configured container; this image reference does not prove
  // which bits are running.
  return boundedString(value[0].name, 128) && value[0].image === expectedImage;
}

function executionMatchesExpected(
  execution: Record<string, unknown>,
  tasks: Record<string, unknown>[],
  expected: ExpectedResources,
): boolean {
  const template = execution.template;
  if (!isRecord(template) || tasks.length !== 1) return false;
  const task = tasks[0];
  if (!task) return false;

  const executionContainers = template.containers;
  const taskContainers = task.containers;
  if (
    !Array.isArray(executionContainers) ||
    !Array.isArray(taskContainers) ||
    !hasSingleExpectedContainer(executionContainers, expected.imageUri) ||
    !hasSingleExpectedContainer(taskContainers, expected.imageUri)
  ) {
    return false;
  }
  const executionContainer: unknown = executionContainers[0];
  const taskContainer: unknown = taskContainers[0];
  if (!isRecord(executionContainer) || !isRecord(taskContainer)) return false;

  return (
    boundedString(execution.name) &&
    execution.name === expected.executionName &&
    boundedString(execution.uid, 256) &&
    execution.uid === execution.uid.trim() &&
    execution.job === expected.jobName &&
    execution.parallelism === 1 &&
    execution.taskCount === 1 &&
    template.serviceAccount === expected.runtimeServiceAccount &&
    // Do not infer zero from an omitted API field.
    template.maxRetries === 0 &&
    executionContainer.name === taskContainer.name &&
    taskBelongsToExecution(task.name, expected.executionName) &&
    taskUidIsUuidV4(task.uid) &&
    task.uid === task.uid.trim() &&
    task.job === expected.jobName &&
    task.execution === expected.executionName &&
    implicitZero(task.index) &&
    implicitZero(task.retried) &&
    task.serviceAccount === expected.runtimeServiceAccount &&
    implicitZero(task.maxRetries)
  );
}

/** Read-only Cloud Run v2 execution/task observer. Its output never authorizes mutation. */
export async function observeOwnerEditorExecution(
  expectedInput: OwnerEditorExecutionExpectation,
  runtimeSignals: Readonly<Record<string, string | undefined>>,
  client: ReadOnlyJsonClient,
): Promise<OwnerEditorExecutionObservation> {
  const expected = expectedResources(expectedInput);
  if (!expected || !isRecord(runtimeSignals)) return unavailable('invalid_expected_input');
  const runtimeMatches = runtimeSignalsMatch(runtimeSignals, expected);

  const executionUrl = new URL(`v2/${expected.executionName}`, CLOUD_RUN_API_ORIGIN);
  let execution: unknown;
  try {
    execution = await client.get(executionUrl);
  } catch {
    return unavailable('api_unavailable', runtimeMatches);
  }
  if (!isRecord(execution)) return unavailable('invalid_response', runtimeMatches);

  const listed = await listTasks(client, expected.executionName);
  if (listed.status === 'unavailable') return unavailable(listed.reason, runtimeMatches);
  const recordMatchesExpected = executionMatchesExpected(execution, listed.tasks, expected);
  return observed(recordMatchesExpected, runtimeMatches);
}
