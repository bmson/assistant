import type {
  ReminderRepository,
  ScheduleRecord,
  ScheduleRepository,
} from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { cancelNamedReminder } from './reminders.js';
import { listOwnerSchedules } from './schedules.js';

function row(id: string, text: string): ScheduleRecord {
  return {
    id,
    agentId: 'owner',
    name: `reminder:${id}`,
    cron: '* * * * *',
    enabled: true,
    taskTemplate: { reminderText: text, reminderKind: 'recurring' },
    nextRunAt: new Date(1),
    seedTemplateKey: null,
    seedTemplateRevision: null,
    seedDefinition: null,
    seedReviewRequired: false,
    lastRunAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
function fixture(pages: ScheduleRecord[][]) {
  let page = 0;
  const listPage = vi.fn(async () => {
    const items = pages[page++] ?? [];
    return { items, nextCursor: page < pages.length ? (items.at(-1)?.id ?? null) : null };
  });
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const schedules: ScheduleRepository = {
    kind: 'schedule-repository',
    listPage,
    setOwnerEnabled: unused,
    ensure: unused,
    getByName: unused,
    listUninitialized: unused,
    listDue: unused,
    initialize: unused,
    commitOccurrence: unused,
  };
  const cancel = vi.fn(async () => ({
    cancelled: true,
    text: 'sunglasses',
    queuedTasksCancelled: 1,
  }));
  const reminders: ReminderRepository = { kind: 'reminder-repository', cancel };
  return { store: { schedules, reminders }, listPage, cancel };
}

it('collects later pages before deciding whether a reminder phrase is ambiguous', async () => {
  const f = fixture([[row('a', 'sunglasses')], [row('b', 'sunglasses')]]);
  const result = await cancelNamedReminder(f.store, 'owner', { query: 'the sunglasses reminder' });
  expect(result).toMatchObject({ cancelled: false, reason: 'ambiguous' });
  expect(f.listPage).toHaveBeenCalledTimes(2);
  expect(f.cancel).not.toHaveBeenCalled();
});

it('finds a unique later-page match but does not claim success after concurrent cancellation', async () => {
  const f = fixture([[row('a', 'water plants')], [row('b', 'sunglasses')]]);
  f.cancel.mockResolvedValue({ cancelled: false, text: '', queuedTasksCancelled: 0 });
  const now = new Date();
  expect(await cancelNamedReminder(f.store, 'owner', { query: 'sunglasses' }, now)).toEqual({
    cancelled: false,
    reason: 'not_found',
  });
  expect(f.cancel).toHaveBeenCalledWith('owner', 'b', now);
});

it('cancels explicit IDs through the authoritative command without scanning schedules', async () => {
  const f = fixture([]);
  expect(await cancelNamedReminder(f.store, 'owner', { reminderId: 'a' })).toMatchObject({
    cancelled: true,
    reminderId: 'a',
  });
  expect(f.listPage).not.toHaveBeenCalled();
});

it('fails closed at the scan budget or an owner mismatch', async () => {
  const f = fixture(Array.from({ length: 51 }, (_, i) => [row(String(i), 'sunglasses')]));
  await expect(cancelNamedReminder(f.store, 'owner', { query: 'sunglasses' })).rejects.toThrow(
    'Too many schedules',
  );
  expect(f.cancel).not.toHaveBeenCalled();
  const foreign = fixture([[{ ...row('foreign', 'sunglasses'), agentId: 'another-owner' }]]);
  await expect(listOwnerSchedules(foreign.store.schedules, 'owner')).rejects.toThrow(
    'owner mismatch',
  );
});

it('does not treat an empty legacy reminder text as a partial match', async () => {
  const f = fixture([[row('empty', '')]]);
  expect(await cancelNamedReminder(f.store, 'owner', { query: 'sunglasses' })).toEqual({
    cancelled: false,
    reason: 'not_found',
  });
  expect(f.cancel).not.toHaveBeenCalled();
});
