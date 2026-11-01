import type { ApprovalSnapshot } from '@assistant/application/approvals';
import { describe, expect, it } from 'vitest';
import {
  displayTaskStatus,
  hasReviewableApproval,
  statusLabel,
  toPendingApprovalView,
} from './views';

const now = new Date('2026-07-22T18:00:00.000Z');

function approval(expiresAt: Date): ApprovalSnapshot {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    shortCode: 'A1',
    summary: 'Send the project update',
    payload: { to: ['owner@example.com'], subject: 'Update', body: 'Ready to send.' },
    resolutionPayload: null,
    status: 'pending',
    requestedAt: new Date('2026-07-22T17:00:00.000Z'),
    expiresAt,
    resolvedAt: null,
    resolvedVia: null,
  };
}

describe('toPendingApprovalView', () => {
  it('treats pending approvals past their expiry as expired', () => {
    const view = toPendingApprovalView(
      approval(new Date('2026-07-22T17:59:59.000Z')),
      { type: 'chat_turn', trust: 'owner' },
      { toolName: 'gmail.send', decision: null },
      now,
      'UTC',
    );

    expect(view.expired).toBe(true);
    expect(view.actionKind).toBe('email');
  });

  it('keeps future approvals actionable', () => {
    const view = toPendingApprovalView(
      approval(new Date('2026-07-22T18:00:01.000Z')),
      { type: 'chat_turn', trust: 'owner' },
      { toolName: 'calendar.create_event', decision: null },
      now,
      'UTC',
    );

    expect(view.expired).toBe(false);
    expect(view.actionKind).toBe('calendar');
  });

  it('shows the exact phone-call brief and only offers separate future permission when enabled', () => {
    const call = approval(new Date('2026-07-22T18:00:01.000Z'));
    call.payload = {
      brief: {
        to: '+14155550123',
        contactName: 'Nopa',
        goal: 'Ask about a table tonight.',
        context: 'The owner prefers a quiet table.',
        mayAgreeTo: 'Any table between 7 and 8pm.',
        mustNot: 'Do not leave a deposit.',
        maxMinutes: 12,
        onVoicemail: 'hang_up',
        voicemailMessage: 'Please call back.',
      },
    };
    const view = toPendingApprovalView(
      call,
      { type: 'chat_turn', trust: 'owner' },
      { toolName: 'phone.call', decision: null },
      now,
      'UTC',
      true,
      null,
      true,
    );
    expect(view.ownerNumberGrantAvailable).toBe(true);
    expect(view.fields).toEqual(
      expect.arrayContaining([
        { label: 'Number to call', value: '+14155550123', block: false },
        { label: 'Goal', value: 'Ask about a table tonight.', block: true },
        { label: 'May share', value: 'The owner prefers a quiet table.', block: true },
        { label: 'May agree to', value: 'Any table between 7 and 8pm.', block: true },
        { label: 'Must not', value: 'Do not leave a deposit.', block: true },
        {
          label: 'Saved voicemail message (not used when hanging up)',
          value: 'Please call back.',
          block: true,
        },
      ]),
    );
    expect(
      toPendingApprovalView(
        call,
        { type: 'chat_turn', trust: 'owner' },
        { toolName: 'phone.call', decision: null },
        now,
        'UTC',
        false,
      ).ownerNumberGrantAvailable,
    ).toBe(false);
  });
});

describe('displayTaskStatus', () => {
  it('calls a task waiting on a live approval what it is', () => {
    expect(displayTaskStatus('waiting_approval', true)).toBe('waiting_approval');
    expect(statusLabel(displayTaskStatus('waiting_approval', true))).toBe('Needs your approval');
  });

  it('reports a task parked on a vanished approval as stuck, not waiting on you', () => {
    // The Approvals page has nothing to show for these, so badging them
    // "Needs your approval" sends the owner somewhere empty.
    expect(displayTaskStatus('waiting_approval', false)).toBe('stuck');
    expect(statusLabel('stuck')).toBe('Stuck — nothing to approve');
  });

  it('leaves every other status untouched', () => {
    for (const status of ['pending', 'running', 'done', 'needs_attention', 'sleeping']) {
      expect(displayTaskStatus(status, false)).toBe(status);
      expect(displayTaskStatus(status, true)).toBe(status);
    }
  });
});

describe('hasReviewableApproval', () => {
  it('offers the approval destination only for a live approval wait', () => {
    expect(hasReviewableApproval('waiting_approval', false)).toBe(true);
    expect(hasReviewableApproval('waiting_approval', true)).toBe(false);
    expect(hasReviewableApproval('needs_attention', false)).toBe(false);
  });
});
