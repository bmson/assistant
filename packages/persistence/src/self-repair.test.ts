import { describe, expect, it } from 'vitest';
import {
  type RepairIssue,
  repairClaimCandidate,
  repairQueueNextEligibleAt,
} from './self-repair.js';

const now = new Date('2026-10-07T12:00:00.000Z');
function queued(id: string, nextEligibleAt?: string): RepairIssue {
  return {
    id,
    agentId: 'owner',
    fingerprint: id,
    status: 'reported',
    version: 1,
    data: {
      source: 'feedback',
      title: id,
      summary: 'synthetic',
      history: [{ status: 'reported', at: now.toISOString(), detail: '' }],
      ...(nextEligibleAt ? { nextEligibleAt } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('self-repair retry eligibility', () => {
  it('skips future retries without blocking later eligible reports', () => {
    const waiting = queued('waiting', new Date(now.getTime() + 60_000).toISOString());
    const fresh = queued('fresh');
    expect(repairClaimCandidate([waiting, fresh], now, 2)?.id).toBe('fresh');
    expect(repairClaimCandidate([waiting], now, 2)).toBeNull();
    expect(repairClaimCandidate([waiting], new Date(now.getTime() + 60_000), 2)?.id).toBe(
      'waiting',
    );
    const malformed = queued('malformed', 'not-a-time');
    expect(repairClaimCandidate([malformed], now, 2)).toBeNull();
  });

  it('returns the actual earliest retry wake and respects manual owner action', () => {
    const first = queued('first', new Date(now.getTime() + 30_000).toISOString());
    const second = queued('second', new Date(now.getTime() + 60_000).toISOString());
    expect(repairQueueNextEligibleAt([first, second], now, 2)?.toISOString()).toBe(
      first.data.nextEligibleAt,
    );
    first.data.manualRunRequestedAt = now.toISOString();
    expect(repairClaimCandidate([first, second], now, 0)?.id).toBe('first');
  });
});
