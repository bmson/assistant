import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  loadConfig: vi.fn(),
  createGoalWithWork: vi.fn(),
  createFirestoreGoalWithWork: vi.fn(),
  getDb: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@assistant/application/goals', () => ({
  archiveGoalRecord: vi.fn(),
  archiveInactiveGoalRecords: vi.fn(),
  changeGoalAutonomy: vi.fn(),
  changeGoalStatus: vi.fn(),
  createGoalWithWork: mocks.createGoalWithWork,
  restoreGoalRecord: vi.fn(),
  startExistingGoalWork: vi.fn(),
  updateGoalSettings: vi.fn(),
}));
vi.mock('@assistant/config', () => ({
  loadConfig: mocks.loadConfig,
  validateAgentPersistenceConfig: vi.fn(() => []),
}));
vi.mock('@assistant/firestore', () => ({
  FirestoreGoalMutationRepository: class {},
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/server', () => ({
  createFirestoreGoalWithWork: mocks.createFirestoreGoalWithWork,
  getDb: mocks.getDb,
  getFirestoreGoalScheduleUpdate: vi.fn(),
  getFirestoreInstallationStore: vi.fn(),
  startFirestoreGoalWork: vi.fn(),
}));

import { createGoal } from './actions.js';

function form(targetDate: string): FormData {
  const data = new FormData();
  data.set('title', 'Plan the move');
  data.set('targetDate', targetDate);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue(undefined);
  mocks.loadConfig.mockReturnValue({ PERSISTENCE_DRIVER: 'postgres' });
  mocks.getDb.mockReturnValue({ db: 'fixture' });
  mocks.createGoalWithWork.mockResolvedValue({
    conversationId: 'conversation',
    taskId: 'task',
    messageCursor: 'cursor',
  });
});

describe('goal form action target dates', () => {
  it.each(['2024-02-30', '2024-04-31', '0000-01-01', '0999-12-31'])(
    'rejects %s before creating a goal or work session',
    async (date) => {
      await expect(createGoal({ error: null }, form(date))).resolves.toMatchObject({
        error: 'Target date is not valid.',
      });
      expect(mocks.createGoalWithWork).not.toHaveBeenCalled();
      expect(mocks.createFirestoreGoalWithWork).not.toHaveBeenCalled();
      expect(mocks.loadConfig).not.toHaveBeenCalled();
    },
  );

  it('keeps a valid leap-day date-only target at UTC midnight', async () => {
    await createGoal({ error: null }, form('2024-02-29'));
    expect(mocks.createGoalWithWork).toHaveBeenCalledWith(
      { db: 'fixture' },
      expect.objectContaining({ targetDate: new Date('2024-02-29T00:00:00.000Z') }),
    );
  });
});
