import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  index: vi.fn(),
  field: vi.fn(),
  remove: vi.fn(),
  getDatabase: vi.fn(),
  close: vi.fn(),
  terminate: vi.fn(),
  adminOptions: vi.fn(),
  dataOptions: vi.fn(),
}));
vi.mock('@google-cloud/firestore', () => ({
  default: {
    v1: {
      FirestoreAdminClient: class {
        constructor(options: unknown) {
          calls.adminOptions(options);
        }
        createDatabase = calls.create;
        createIndex = calls.index;
        updateField = calls.field;
        fieldPath = (project: string, database: string, collection: string, field: string) =>
          `projects/${project}/databases/${database}/collectionGroups/${collection}/fields/${field}`;
        deleteDatabase = calls.remove;
        getDatabase = calls.getDatabase;
        close = calls.close;
      },
    },
    Firestore: class {
      terminate = calls.terminate;
      constructor(options: unknown) {
        calls.dataOptions(options);
      }
    },
  },
}));
vi.mock('./store.js', () => ({
  InstallationStore: class {
    constructor(readonly db: unknown) {}
  },
}));
vi.mock('./task-lifecycle.js', () => ({ dueTasksQuery: vi.fn() }));

import { type ValidationAuthClient, withValidationDatabase } from './validation-admin.js';

describe('isolated live-validation resource lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const operation = () => [{ promise: async () => [] }];
    calls.create.mockReset().mockImplementation(operation);
    calls.index.mockReset().mockImplementation(operation);
    calls.field.mockReset().mockImplementation(operation);
    calls.remove.mockReset().mockImplementation(operation);
    calls.getDatabase
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('missing'), { code: 5 }));
    calls.close.mockReset().mockResolvedValue(undefined);
    calls.terminate.mockReset().mockResolvedValue(undefined);
    calls.adminOptions.mockReset();
    calls.dataOptions.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());
  const input = {
    projectId: 'test-project',
    location: 'us-west1',
    indexes: [],
    progress: () => {},
  };
  it('deletes only the fresh generated database when validation fails', async () => {
    await expect(
      withValidationDatabase(input, async () => {
        throw new Error('validation failed');
      }),
    ).rejects.toThrow('validation failed');
    const create = calls.create.mock.calls[0]?.[0];
    expect(create.databaseId).toMatch(/^assistant-validation-[a-f0-9]{16}$/);
    expect(calls.remove).toHaveBeenCalledWith(
      {
        name: `projects/test-project/databases/${create.databaseId}`,
      },
      { timeout: 10_000 },
    );
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it('does not adopt or delete a database after rejected creation', async () => {
    calls.create.mockRejectedValue(new Error('already exists'));
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow('already exists');
    expect(calls.remove).not.toHaveBeenCalled();
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it('still removes the database if client termination fails', async () => {
    calls.terminate.mockRejectedValue(new Error('close failed'));
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow('close failed');
    expect(calls.remove).toHaveBeenCalledOnce();
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it('refuses emulator routing before creating any cloud resources', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8789');
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow(
      'refuses emulator',
    );
    expect(calls.create).not.toHaveBeenCalled();
  });
  it('shares an explicit auth client between admin and data clients', async () => {
    const authClient = { getAccessToken: vi.fn() } as unknown as ValidationAuthClient;
    await expect(withValidationDatabase({ ...input, authClient }, async () => true)).resolves.toBe(
      true,
    );
    expect(calls.adminOptions).toHaveBeenCalledWith(
      expect.objectContaining({ authClient, projectId: 'test-project' }),
    );
    expect(calls.dataOptions).toHaveBeenCalledWith(
      expect.objectContaining({ authClient, projectId: 'test-project' }),
    );
  });
  it('starts independent indexes together and waits for all builds before cleanup after a failure', async () => {
    let finishSecond!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    calls.index
      .mockImplementationOnce(() => [
        {
          promise: async () => {
            throw new Error('index failed');
          },
        },
      ])
      .mockImplementationOnce(() => [{ promise: () => pending }]);
    const validate = vi.fn();
    const progress = vi.fn();
    const run = withValidationDatabase(
      {
        ...input,
        progress,
        indexes: [{ collectionGroup: 'tasks' }, { collectionGroup: 'outbox' }],
      },
      validate,
    );
    const rejection = expect(run).rejects.toThrow('index failed');
    await vi.waitFor(() => expect(calls.index).toHaveBeenCalledTimes(2));
    expect(calls.remove).not.toHaveBeenCalled();
    finishSecond();
    await rejection;
    expect(validate).not.toHaveBeenCalled();
    expect(calls.remove).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(
      'validation_failed',
      expect.objectContaining({ message: 'index failed' }),
    );
    expect(progress.mock.calls.findIndex(([stage]) => stage === 'validation_failed')).toBeLessThan(
      progress.mock.calls.findIndex(([stage]) => stage === 'deleting_database'),
    );
  });
  it('retries an aborted index creation while retaining cleanup ownership', async () => {
    calls.index.mockRejectedValueOnce(
      Object.assign(new Error('metadata contention'), { code: 10 }),
    );
    const validate = vi.fn(async () => true);
    await expect(
      withValidationDatabase({ ...input, indexes: [{ collectionGroup: 'tasks' }] }, validate),
    ).resolves.toBe(true);
    expect(calls.index).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledOnce();
    expect(calls.remove).toHaveBeenCalledOnce();
  });
  it('applies field exemptions and waits for all operations before cleanup after failure', async () => {
    let finishSecond!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    calls.field
      .mockImplementationOnce(() => [
        {
          promise: async () => {
            throw new Error('field override failed');
          },
        },
      ])
      .mockImplementationOnce(() => [{ promise: () => pending }]);
    const validate = vi.fn();
    const run = withValidationDatabase(
      {
        ...input,
        fieldOverrides: [
          { collectionGroup: 'messages', fieldPath: 'parts', indexes: [] },
          { collectionGroup: 'tasks', fieldPath: 'state', indexes: [] },
        ],
      },
      validate,
    );
    const rejection = expect(run).rejects.toThrow('field override failed');
    await vi.waitFor(() => expect(calls.field).toHaveBeenCalledTimes(2));
    expect(calls.field.mock.calls[0]?.[0]).toMatchObject({
      field: {
        name: expect.stringContaining('/collectionGroups/messages/fields/parts'),
        indexConfig: { indexes: [] },
      },
      updateMask: { paths: ['index_config'] },
    });
    expect(calls.remove).not.toHaveBeenCalled();
    finishSecond();
    await rejection;
    expect(validate).not.toHaveBeenCalled();
    expect(calls.remove).toHaveBeenCalledOnce();
  });
  it('reports a passed workload before waiting for database cleanup', async () => {
    const progress = vi.fn();
    await expect(
      withValidationDatabase({ ...input, progress }, async () => 'passed'),
    ).resolves.toBe('passed');
    expect(progress.mock.calls.findIndex(([stage]) => stage === 'validation_passed')).toBeLessThan(
      progress.mock.calls.findIndex(([stage]) => stage === 'deleting_database'),
    );
  });
  it('polls the exact database until it is absent after deletion submission', async () => {
    calls.getDatabase
      .mockResolvedValueOnce([{}])
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 5 }));
    await expect(withValidationDatabase(input, async () => true)).resolves.toBe(true);
    expect(calls.getDatabase).toHaveBeenCalledTimes(2);
    expect(calls.getDatabase.mock.calls[0]?.[0]).toEqual({
      name: calls.remove.mock.calls[0]?.[0].name,
    });
    expect(calls.getDatabase.mock.calls[0]?.[1].timeout).toBeGreaterThan(0);
  });
  it('does not treat permission failures as deletion success', async () => {
    calls.getDatabase.mockRejectedValue(Object.assign(new Error('denied'), { code: 7 }));
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow('denied');
    expect(calls.remove).toHaveBeenCalledOnce();
  });
  it('retries transient delete contention before polling absence', async () => {
    calls.remove
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 10 }))
      .mockImplementationOnce(() => [{ promise: async () => [] }]);
    await expect(withValidationDatabase(input, async () => true)).resolves.toBe(true);
    expect(calls.remove).toHaveBeenCalledTimes(2);
  });
  it('preserves a non-retryable delete failure', async () => {
    calls.remove.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 7 }));
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow('forbidden');
    expect(calls.remove).toHaveBeenCalledOnce();
    expect(calls.getDatabase).not.toHaveBeenCalled();
  });
});

it('keeps deployable composite indexes and field overrides in their correct sections', async () => {
  const spec = JSON.parse(
    await readFile(
      new URL('../../../infra/gcp/firestore/firestore.indexes.json', import.meta.url),
      'utf8',
    ),
  );
  for (const index of spec.indexes) {
    expect(index).toMatchObject({
      collectionGroup: expect.any(String),
      queryScope: expect.any(String),
      fields: expect.any(Array),
    });
    expect(index.fields.length).toBeGreaterThan(1);
    expect(index).not.toHaveProperty('fieldPath');
  }
  for (const override of spec.fieldOverrides) {
    expect(override).toMatchObject({
      collectionGroup: expect.any(String),
      fieldPath: expect.any(String),
      indexes: expect.any(Array),
    });
    expect(override).not.toHaveProperty('fields');
  }
  const watchIndexes = spec.indexes
    .filter((index: { collectionGroup: string }) => index.collectionGroup === 'watches')
    .map((index: { fields: Array<{ fieldPath: string; order: string }> }) =>
      index.fields.map((field) => `${field.fieldPath}:${field.order}`).join(','),
    );
  expect(watchIndexes).toEqual(
    expect.arrayContaining([
      'agentId:ASCENDING,createdAt:DESCENDING',
      'agentId:ASCENDING,status:ASCENDING,createdAt:DESCENDING',
      'status:ASCENDING,expiresAt:ASCENDING',
      'agentId:ASCENDING,status:ASCENDING,expiresAt:ASCENDING',
      'agentId:ASCENDING,status:ASCENDING,kind:ASCENDING,expiresAt:ASCENDING',
      'status:ASCENDING,kind:ASCENDING,nextPollAt:ASCENDING',
    ]),
  );
  const taskIndexes = spec.indexes
    .filter((index: { collectionGroup: string }) => index.collectionGroup === 'tasks')
    .map((index: { fields: Array<{ fieldPath: string; order: string }> }) =>
      index.fields.map((field) => `${field.fieldPath}:${field.order}`).join(','),
    );
  expect(taskIndexes).toEqual(
    expect.arrayContaining([
      'agentId:ASCENDING,status:ASCENDING,lockedUntil:ASCENDING',
      'agentId:ASCENDING,status:ASCENDING,updatedAt:ASCENDING,runAfter:ASCENDING',
      'agentId:ASCENDING,runAfter:ASCENDING,status:ASCENDING,updatedAt:ASCENDING',
      // Composer cancellation inventories bounded nonterminal owner turns by owner/conversation/status.
      'agentId:ASCENDING,conversationId:ASCENDING,status:ASCENDING',
    ]),
  );
  const commitmentIndexes = spec.indexes
    .filter((index: { collectionGroup: string }) => index.collectionGroup === 'commitments')
    .map((index: { fields: Array<{ fieldPath: string; order: string }> }) =>
      index.fields.map((field) => `${field.fieldPath}:${field.order}`).join(','),
    );
  expect(commitmentIndexes).toContain('agentId:ASCENDING,status:ASCENDING');
  const modelCallIndexes = spec.indexes
    .filter((index: { collectionGroup: string }) => index.collectionGroup === 'modelCalls')
    .map((index: { fields: Array<{ fieldPath: string; order: string }> }) =>
      index.fields.map((field) => `${field.fieldPath}:${field.order}`).join(','),
    );
  expect(modelCallIndexes).toContain('agentId:ASCENDING,role:ASCENDING,createdAt:DESCENDING');
});
