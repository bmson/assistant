import type { OccasionToolRow, OwnerCommitment } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { briefingLifeContext } from './life-context.js';

const occasion = (values: Partial<OccasionToolRow> = {}): OccasionToolRow => ({
  id: 'birthday',
  contactId: 'person',
  contactName: 'Ada',
  kind: 'birthday',
  label: '',
  month: 1,
  day: 1,
  year: 1980,
  recurrence: 'annual',
  leadDays: 7,
  notes: '',
  originTrust: 'owner',
  quarantined: false,
  ownerConfirmed: true,
  ...values,
});
const commitment = (values: Partial<OwnerCommitment> = {}): OwnerCommitment => ({
  id: 'promise',
  agentId: 'owner',
  conversationId: 'chat',
  sourceMessageId: null,
  sourceTaskId: null,
  sourceOccurrenceKey: null,
  reopenedFromId: null,
  reopenOperationId: null,
  kind: 'promise',
  title: 'Return the school form',
  details: '',
  nextAction: '',
  status: 'open',
  dueAt: null,
  snoozedUntil: null,
  resolvedAt: null,
  resolution: null,
  confidence: '0.9',
  contentHash: 'hash',
  createdAt: new Date('2026-12-01'),
  updatedAt: new Date('2026-12-01'),
  ...values,
});

describe('briefing life context', () => {
  it('follows up on undated promises after two days without rushing open decisions', () => {
    const now = new Date('2026-12-31');
    const updatedAt = new Date('2026-12-28');
    const selected = briefingLifeContext(
      {
        commitments: [
          commitment({ updatedAt, title: 'Save the dentist draft' }),
          commitment({
            id: 'decision',
            kind: 'decision',
            updatedAt,
            title: 'Choose next summer trip',
          }),
        ],
      },
      now,
      'UTC',
    ).commitments;
    expect(selected.map((row) => row.title)).toEqual(['Save the dentist draft']);
    expect(selected[0]?.detail).toContain('at least 2 days');
  });
  it('surfaces a birthday on the owner’s civil day across the year boundary', () => {
    const now = new Date('2026-12-31T11:00:00Z'); // Jan 1 in Kiritimati
    expect(
      briefingLifeContext({ occasions: [occasion()] }, now, 'Pacific/Kiritimati').occasions,
    ).toEqual([{ title: 'Ada — birthday', detail: 'Today', meta: 'Today' }]);
    expect(
      briefingLifeContext({ occasions: [occasion()] }, now, 'America/Los_Angeles').occasions[0]
        ?.detail,
    ).toBe('In 1 day');
  });

  it('excludes quarantined/inferred dates, invalid dates and past one-off events', () => {
    const rows = [
      occasion({ quarantined: true }),
      occasion({ originTrust: 'assistant', ownerConfirmed: false }),
      occasion({ month: 2, day: 31 }),
      occasion({ recurrence: 'once', year: 2020 }),
      occasion({ recurrence: 'once', year: null }),
    ];
    expect(
      briefingLifeContext({ occasions: rows }, new Date('2026-12-31'), 'UTC').occasions,
    ).toEqual([]);
  });

  it('keeps overdue and undated promises visible without reviving resolved or snoozed work', () => {
    const now = new Date('2026-12-31');
    const rows = [
      commitment(),
      commitment({ id: 'duplicate-promise' }),
      commitment({ id: 'due', title: 'Reply to the school', dueAt: new Date('2026-12-30') }),
      commitment({ id: 'resolved', status: 'resolved', resolvedAt: now }),
      commitment({ id: 'dismissed', status: 'dismissed' }),
      commitment({ id: 'snoozed', status: 'snoozed', snoozedUntil: new Date('2027-01-10') }),
      commitment({ id: 'future', dueAt: new Date('2027-02-01') }),
      commitment({ id: 'recent', updatedAt: now }),
    ];
    const selected = briefingLifeContext({ commitments: rows }, now, 'UTC').commitments;
    expect(selected.map((row) => row.title)).toEqual([
      'Reply to the school',
      'Return the school form',
    ]);
    expect(selected[0]?.meta).toBe('Past recorded due date');
    expect(selected[1]?.detail).toContain('Still open in your records');
  });
});
