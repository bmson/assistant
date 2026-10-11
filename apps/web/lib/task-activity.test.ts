import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  driver: 'postgres',
  db: { id: 'postgres-db' },
  store: { id: 'firestore-store' },
  agentId: 'configured-owner-agent',
  application: {
    archiveActivity: vi.fn(),
    archiveActivityWithRepository: vi.fn(),
    archiveOldActivity: vi.fn(),
    archiveOldActivityWithRepository: vi.fn(),
    getTaskDetail: vi.fn(),
    getTaskDetailWithRepository: vi.fn(),
    getActivityStatus: vi.fn(),
    getActivityStatusWithRepository: vi.fn(),
    listActivity: vi.fn(),
    listActivityWithRepository: vi.fn(),
    restoreActivity: vi.fn(),
    restoreActivityWithRepository: vi.fn(),
  },
}));

vi.mock('@assistant/config', () => ({
  loadConfig: () => ({
    PERSISTENCE_DRIVER: mocked.driver,
    FIRESTORE_AGENT_ID: mocked.agentId,
  }),
}));
vi.mock('@/lib/server', () => ({
  getDb: () => mocked.db,
  getFirestoreInstallationStore: () => mocked.store,
}));
vi.mock('@assistant/application/tasks', () => mocked.application);
vi.mock('@assistant/firestore', () => ({
  FirestoreTaskActivityRepository: class {
    constructor(readonly store: unknown) {}
  },
  FirestoreTaskActivityCommandRepository: class {
    constructor(readonly store: unknown) {}
  },
}));

import {
  archiveOldTaskActivity,
  archiveTaskActivity,
  getTaskActivityDetail,
  getTaskActivityStatus,
  listTaskActivity,
  restoreTaskActivity,
} from './task-activity.js';

describe('web Activity persistence dispatch', () => {
  beforeEach(() => {
    mocked.driver = 'postgres';
    for (const method of Object.values(mocked.application)) method.mockReset();
  });

  it('keeps PostgreSQL list, detail, archive, restore, and archive-old use cases unchanged', async () => {
    const filter = { archived: false, filter: 'working' as const };
    await listTaskActivity(filter);
    await getTaskActivityDetail('task-id', { pageSize: 10 });
    await archiveTaskActivity('task-id');
    await restoreTaskActivity('task-id');
    await archiveOldTaskActivity();

    expect(mocked.application.listActivity).toHaveBeenCalledWith(mocked.db, filter);
    expect(mocked.application.getTaskDetail).toHaveBeenCalledWith(mocked.db, 'task-id', {
      pageSize: 10,
    });
    expect(mocked.application.archiveActivity).toHaveBeenCalledWith(mocked.db, 'task-id');
    expect(mocked.application.restoreActivity).toHaveBeenCalledWith(mocked.db, 'task-id');
    expect(mocked.application.archiveOldActivity).toHaveBeenCalledWith(mocked.db);
  });

  it('uses Firestore repositories and the configured owner ID for every Activity operation', async () => {
    mocked.driver = 'firestore';
    const filter = { archived: true, filter: 'all' as const };
    await listTaskActivity(filter);
    await getTaskActivityDetail('task-id', { before: new Date('2026-09-20T12:00:00Z') });
    await archiveTaskActivity('task-id');
    await restoreTaskActivity('task-id');
    await archiveOldTaskActivity();

    const listRepository = mocked.application.listActivityWithRepository.mock.calls[0]?.[0] as {
      store: unknown;
    };
    const detailRepository = mocked.application.getTaskDetailWithRepository.mock.calls[0]?.[0] as {
      store: unknown;
    };
    expect(listRepository.store).toBe(mocked.store);
    expect(mocked.application.listActivityWithRepository).toHaveBeenCalledWith(
      expect.any(Object),
      mocked.agentId,
      filter,
    );
    expect(detailRepository.store).toBe(mocked.store);
    expect(mocked.application.getTaskDetailWithRepository).toHaveBeenCalledWith(
      expect.any(Object),
      mocked.agentId,
      'task-id',
      { before: new Date('2026-09-20T12:00:00Z') },
    );
    expect(mocked.application.archiveActivityWithRepository).toHaveBeenCalledWith(
      expect.objectContaining({ store: mocked.store }),
      mocked.agentId,
      'task-id',
    );
    expect(mocked.application.restoreActivityWithRepository).toHaveBeenCalledWith(
      expect.objectContaining({ store: mocked.store }),
      mocked.agentId,
      'task-id',
    );
    expect(mocked.application.archiveOldActivityWithRepository).toHaveBeenCalledWith(
      expect.objectContaining({ store: mocked.store }),
      mocked.agentId,
    );
    expect(mocked.application.listActivity).not.toHaveBeenCalled();
    expect(mocked.application.getTaskDetail).not.toHaveBeenCalled();
  });

  it('dispatches compact status reads through the configured persistence driver', async () => {
    mocked.application.getActivityStatus.mockResolvedValue({ id: 'task-id', status: 'running' });
    expect(await getTaskActivityStatus('task-id')).toMatchObject({ status: 'running' });
    expect(mocked.application.getActivityStatus).toHaveBeenCalledWith(mocked.db, 'task-id');

    mocked.driver = 'firestore';
    mocked.application.getActivityStatusWithRepository.mockResolvedValue({
      id: 'task-id',
      status: 'done',
    });
    expect(await getTaskActivityStatus('task-id')).toMatchObject({ status: 'done' });
    const repository = mocked.application.getActivityStatusWithRepository.mock.calls.at(
      -1,
    )?.[0] as {
      store: unknown;
    };
    expect(repository.store).toBe(mocked.store);
    expect(mocked.application.getActivityStatusWithRepository).toHaveBeenCalledWith(
      expect.any(Object),
      mocked.agentId,
      'task-id',
    );
  });
});
