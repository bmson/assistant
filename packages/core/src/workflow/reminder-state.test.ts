import { describe, expect, it } from 'vitest';
import { effectiveReminders } from './reminder-state.js';
import { buildRequestChecklist, reconcileRequestChecklist } from './request-checklist.js';
import { reminderResponseCards } from './response-cards.js';
import { enforceResponseContract } from './response-contract.js';

const create = (id: string) => ({
  id: `create-${id}`,
  toolName: 'reminder.create',
  status: 'succeeded',
  result: {
    reminderId: id,
    text: 'Call the dentist',
    kind: 'once',
    nextFires: '2027-01-01T12:00:00Z',
  },
});
const cancel = (id: string, cancelled = true) => ({
  id: `cancel-${id}`,
  toolName: 'reminder.cancel',
  status: 'succeeded',
  result: { reminderId: id, cancelled },
});
describe('effective reminder state', () => {
  it('uses the same cancelled state for cards, claims and checklist completion', () => {
    const evidence = [create('one'), cancel('one')];
    expect(reminderResponseCards(evidence)).toMatchObject([{ enabled: false, nextFires: '' }]);
    const checklist = buildRequestChecklist(
      'Remind me to call the dentist and send an email to the dentist',
    );
    if (!checklist) throw new Error('Missing checklist');
    expect(reconcileRequestChecklist(checklist, evidence).items[0]?.status).toBe('blocked');
    const response = enforceResponseContract('The reminder is set.', evidence, {
      requestText: 'Remind me to call the dentist',
    });
    expect(response.text).not.toContain('The reminder is set.');
  });
  it('does not let a stale list or create replay resurrect a cancellation', () => {
    const evidence = [
      create('one'),
      cancel('one'),
      {
        toolName: 'reminder.list',
        status: 'succeeded',
        result: { reminders: [{ reminderId: 'one', text: 'Call the dentist', enabled: true }] },
      },
      create('one'),
    ];
    expect(effectiveReminders(evidence).get('one')).toMatchObject({
      cancelled: true,
      enabled: false,
    });
  });
  it('preserves failed and ambiguous cancellations and new distinct reminders', () => {
    const evidence = [
      create('one'),
      cancel('one', false),
      {
        ...cancel('one'),
        result: { cancelled: true, reminderId: 'one', deliveryStatus: 'unknown' },
      },
      create('two'),
    ];
    expect([...effectiveReminders(evidence).values()].map((r) => r.enabled)).toEqual([true, true]);
    expect(reminderResponseCards(evidence)).toHaveLength(2);
  });
});
