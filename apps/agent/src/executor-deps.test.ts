import { sqlOnlyCodeJobs } from '@assistant/core';
import type { TaskRow } from '@assistant/db';
import type { InstalledModuleSet, ModuleChannel } from '@assistant/modules';
import { finalChannelDelivery, finalChannelDeliveryReport } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { notifyAttention } from '../../../packages/core/src/workflow/executor/notices.js';
import {
  type AgentDeps,
  approvalSummaryNotice,
  pinnedMemoryEmbed,
  shouldMirrorIntoPrimary,
} from './deps.js';
import { approvalNoticeEmail, executorDeps } from './executor-deps.js';

describe('Firestore memory embedding provenance', () => {
  it('accepts vendor-qualified OpenRouter model IDs', async () => {
    const role = vi.fn().mockResolvedValue({ primaryModel: 'openai/text-embedding-3-small' });
    const embed = vi.fn().mockResolvedValue([[1, 0, 0]]);
    const pinned = pinnedMemoryEmbed(
      {
        provider: 'openrouter',
        model: 'openai/text-embedding-3-small',
        dimensions: 1536,
        revision: '1',
      },
      { role },
      embed,
    );

    await expect(pinned(['private fact'])).resolves.toEqual([[1, 0, 0]]);
    expect(embed).toHaveBeenCalledOnce();
  });

  it('refuses a changed embedding role before requesting a vector', async () => {
    const role = vi.fn().mockResolvedValue({ primaryModel: 'openai/text-embedding-3-small' });
    const embed = vi.fn().mockResolvedValue([[1, 0, 0]]);
    const pinned = pinnedMemoryEmbed(
      { provider: 'google', model: 'gemini-embedding-001', dimensions: 1536, revision: '1' },
      { role },
      embed,
    );

    await expect(pinned(['private fact'])).rejects.toThrow(
      'Firestore memory embedding role must use google/gemini-embedding-001',
    );
    expect(embed).not.toHaveBeenCalled();
    role.mockResolvedValue({ primaryModel: 'google/gemini-embedding-001' });
    await expect(pinned(['private fact'])).resolves.toEqual([[1, 0, 0]]);
    expect(embed).toHaveBeenCalledOnce();
  });
});

describe('approvalNoticeEmail', () => {
  const notice = approvalNoticeEmail([
    { shortCode: 'A7', summary: 'Create event "The Odyssey" 2026-07-23T18:00 and invite owner' },
  ]);

  it('names every pending approval with its code', () => {
    expect(notice).toContain('A7');
    expect(notice).toContain('The Odyssey');
  });

  it('limits the pending claim to the listed actions', () => {
    expect(notice).toMatch(/These actions are waiting for your approval/i);
    expect(notice).not.toMatch(/nothing has happened|before I act on this/i);
  });

  it('does not invite an email reply, which cannot resolve an approval', () => {
    // Only sms-channel parses "YES A7". Telling the owner to reply to the email
    // would be an instruction the system silently drops.
    expect(notice).not.toMatch(/reply to this email/i);
    expect(notice).toMatch(/dashboard/i);
    expect(notice).toMatch(/text message/i);
  });

  it('lists each approval when several park together', () => {
    const many = approvalNoticeEmail([
      { shortCode: 'A8', summary: 'first' },
      { shortCode: 'A9', summary: 'second' },
    ]);
    expect(many).toContain('[A8] first');
    expect(many).toContain('[A9] second');
  });
});

describe('dashboard notice mirroring', () => {
  it('does not mirror a notice back into the primary conversation that already owns it', () => {
    expect(shouldMirrorIntoPrimary('primary-chat', 'primary-chat')).toBe(false);
  });

  it('still mirrors background and work-thread notices into the primary conversation', () => {
    expect(shouldMirrorIntoPrimary('work-chat', 'primary-chat')).toBe(true);
    expect(shouldMirrorIntoPrimary(null, 'primary-chat')).toBe(true);
  });
});

describe('approvalSummaryNotice', () => {
  it('explains the task purpose and count without leaking approval codes or payloads', () => {
    expect(
      approvalSummaryNotice([
        { purpose: 'Find an open cafe nearby' },
        { purpose: 'Find an open cafe nearby' },
      ]),
    ).toEqual({
      text: 'Approval needed to continue: Find an open cafe nearby\n2 actions are waiting for review in Approvals.',
      extraParts: [
        { type: 'approval-summary', purpose: 'Find an open cafe nearby', approvalCount: 2 },
      ],
    });
  });
});

/**
 * The channel fan-out semantics carried over from the hardcoded era: every
 * channel's configured-check runs before ANY channel delivers, delivery order
 * is composition order (email before sms), and the approval flow pings the
 * owner out-of-band before posting the in-thread notice.
 */
describe('executorDeps channel composition', () => {
  const calls: string[] = [];
  const channel = (name: string, over: Partial<ModuleChannel> = {}): ModuleChannel => ({
    name,
    deliverFinal: async (_services, _task, _text, attemptId) => {
      calls.push(`deliver:${name}`);
      return finalChannelDelivery(name, 'accepted', attemptId);
    },
    deliverApprovalNotice: async () => {
      calls.push(`notice:${name}`);
    },
    ...over,
  });
  const depsWith = (
    channels: ModuleChannel[],
    channelUnavailable: (taskType: string) => string | null = () => null,
  ): AgentDeps =>
    ({
      config: { PERSISTENCE_DRIVER: 'postgres' },
      db: {},
      // The composition root hands agentServices the policy-gated phone legs
      // as a unit; the fixture stands in for it directly.
      outOfBandNotifier: {
        notifyOwner: async () => {
          calls.push('ping:owner');
        },
        notifyApprovals: async () => {
          calls.push('ping:approvals');
        },
      },
      modules: {
        channels,
        ownerNotifier: {
          notifyOwner: async () => {
            calls.push('ping:owner');
          },
          notifyApprovals: async () => {
            calls.push('ping:approvals');
          },
        },
        emailObservers: [],
        jobUnavailable: () => null,
        channelUnavailable,
      } as unknown as InstalledModuleSet,
    }) as unknown as AgentDeps;
  const task = { id: 't1', type: 'email_triage', trust: 'owner' } as TaskRow;

  it('does not dispatch a channel that reports a required setup failure', async () => {
    calls.length = 0;
    const deps = depsWith([], () => 'google channel unavailable');
    await expect(
      executorDeps(deps).deliverFinal?.(task, 'answer', 'attempt-1'),
    ).resolves.toMatchObject({
      legs: [{ channel: 'email', status: 'rejected', attemptId: 'attempt-1' }],
    });
    expect(calls).toEqual([]);
  });

  it('delivers through every channel in composition order', async () => {
    calls.length = 0;
    const deps = depsWith([channel('email'), channel('sms')]);
    await executorDeps(deps).deliverFinal?.(task, 'answer', 'attempt-1');
    expect(calls).toEqual(['deliver:email', 'deliver:sms']);
  });

  it('returns each channel result separately so a mixed delivery is not flattened', async () => {
    calls.length = 0;
    const deps = depsWith([
      channel('email', {
        deliverFinal: async (_services, _task, _text, attemptId) =>
          finalChannelDelivery('email', 'accepted', attemptId),
      }),
      channel('sms', {
        deliverFinal: async (_services, _task, _text, attemptId) =>
          finalChannelDelivery('sms', 'rejected', attemptId, 'missing-target'),
      }),
    ]);
    await expect(
      executorDeps(deps).deliverFinal?.(task, 'answer', 'attempt-1'),
    ).resolves.toMatchObject({
      legs: [
        { channel: 'email', status: 'accepted', attemptId: 'attempt-1' },
        { channel: 'sms', status: 'rejected', attemptId: 'attempt-1', reason: 'missing-target' },
      ],
    });
  });

  it('keeps accepted siblings when another channel throws after its attempt began', async () => {
    const deps = depsWith([
      channel('email'),
      channel('sms', {
        deliverFinal: async () => {
          throw new Error('transport closed');
        },
      }),
    ]);
    await expect(
      executorDeps(deps).deliverFinal?.(task, 'answer', 'attempt-2'),
    ).resolves.toMatchObject({
      legs: [
        { channel: 'email', status: 'accepted' },
        { channel: 'sms', status: 'unknown', attemptId: 'attempt-2' },
      ],
    });
  });

  it('retries only rejected legs and retains already accepted siblings', async () => {
    calls.length = 0;
    const deps = depsWith([
      channel('email'),
      channel('sms', {
        deliverFinal: async (_services, _task, _text, attemptId) => {
          calls.push('deliver:sms');
          return finalChannelDelivery('sms', 'accepted', attemptId);
        },
      }),
    ]);
    const previous = finalChannelDeliveryReport([
      finalChannelDelivery('email', 'accepted', 'attempt-1'),
      finalChannelDelivery('sms', 'rejected', 'attempt-1', 'missing-target'),
    ]);
    await expect(
      executorDeps(deps).deliverFinal?.(task, 'answer', 'attempt-2', previous),
    ).resolves.toMatchObject({
      legs: [
        { channel: 'email', status: 'accepted', attemptId: 'attempt-1' },
        { channel: 'sms', status: 'accepted', attemptId: 'attempt-2' },
      ],
    });
    expect(calls).toEqual(['deliver:sms']);
  });

  it('pings the owner before posting the in-thread approval notice', async () => {
    calls.length = 0;
    const deps = depsWith([channel('email')]);
    await executorDeps(deps).notifyApproval?.(task, [
      { taskId: 't1', shortCode: 'A7', summary: 's' },
    ]);
    expect(calls).toEqual(['ping:approvals', 'notice:email']);
  });

  it('fails an owner-facing task loudly when its owning channel module is uninstalled', async () => {
    // A missing owning module is a typed rejection, not a successful no-op.
    calls.length = 0;
    const deps = depsWith([], (type) =>
      type === 'email_triage'
        ? 'email_triage cannot be delivered because the google module is not installed'
        : null,
    );
    await expect(
      executorDeps(deps).deliverFinal?.(task, 'answer', 'attempt-1'),
    ).resolves.toMatchObject({
      legs: [{ status: 'rejected', reason: 'channel-module-unavailable' }],
    });
    expect(calls).toEqual([]);
  });

  it('does not block a non-owner task when a channel is absent', async () => {
    calls.length = 0;
    const unknownTask = { id: 't2', type: 'email_triage', trust: 'unknown' } as TaskRow;
    const deps = depsWith([], () => 'should not be consulted for non-owner tasks');
    await expect(
      executorDeps(deps).deliverFinal?.(unknownTask, 'answer', 'attempt-1'),
    ).resolves.toMatchObject({
      legs: [{ status: 'not_applicable' }],
    });
    expect(calls).toEqual([]); // no channels, nothing delivered, no throw
  });

  it('does not stamp attention when the composed dashboard and phone legs all fail', async () => {
    const append = vi.fn().mockRejectedValue(new Error('conversation store unavailable'));
    const markAttentionNotified = vi.fn().mockResolvedValue(true);
    const failedDeps = {
      config: { PERSISTENCE_DRIVER: 'postgres' },
      // Dashboard delivery reaches the actual agentServices composition and
      // fails while looking up the owner. The phone leg then reports its own
      // failed/skipped outcomes through the same executorDeps port.
      db: {
        select: () => {
          throw new Error('database unavailable');
        },
      },
      persistence: {
        messages: { kind: 'message-repository', append },
        tasks: { kind: 'task-lease-repository', markAttentionNotified },
      },
      outOfBandNotifier: {
        notifyOwner: async () => ({
          legs: [
            { channel: 'sms', status: 'failed' as const },
            { channel: 'push', status: 'skipped' as const },
          ],
        }),
        notifyApprovals: async () => ({ legs: [{ channel: 'sms', status: 'skipped' as const }] }),
      },
      modules: {
        channels: [],
        emailObservers: [],
        jobUnavailable: () => null,
        channelUnavailable: () => null,
      },
    } as unknown as AgentDeps;
    const task = {
      id: 'notice-retry-task',
      agentId: 'agent-1',
      conversationId: 'owner-chat',
      trust: 'owner',
    } as TaskRow;

    await notifyAttention(executorDeps(failedDeps), task, 'I could not finish.');

    expect(append).toHaveBeenCalledOnce();
    expect(markAttentionNotified).not.toHaveBeenCalled();
  });
});

describe('executorDeps code-job availability', () => {
  const depsFor = (driver: 'postgres' | 'firestore', moduleOwned: string | null = null) =>
    ({
      config: { PERSISTENCE_DRIVER: driver, FIRESTORE_AGENT_ID: 'agent' },
      db: {},
      ...(driver === 'firestore'
        ? { firestoreStore: {}, persistence: { notificationOutbox: {} } }
        : {}),
      outOfBandNotifier: { notifyOwner: async () => {}, notifyApprovals: async () => {} },
      modules: {
        channels: [],
        ownerNotifier: { notifyOwner: async () => {}, notifyApprovals: async () => {} },
        emailObservers: [],
        jobUnavailable: () => moduleOwned,
      } as unknown as InstalledModuleSet,
    }) as unknown as AgentDeps;

  it('completes SQL-only jobs benignly under Firestore and keeps portable ones', () => {
    const jobs = executorDeps(depsFor('firestore'));
    // Shrinks to nothing as the last jobs are ported; each one left is named.
    for (const job of sqlOnlyCodeJobs())
      expect(jobs.jobUnavailable?.(job)).toBe(
        `${job} skipped because it is not yet available on Firestore persistence`,
      );
    expect(jobs.jobUnavailable?.('dream.run')).toBeNull();
    expect(jobs.jobUnavailable?.('graph.curiosity')).toBeNull();
    expect(jobs.jobUnavailable?.('memory.consolidate')).toBeNull();
    expect(jobs.jobUnavailable?.('reminder.notify')).toBeNull();
  });

  it('leaves every job available on PostgreSQL and prefers the module owner message', () => {
    expect(executorDeps(depsFor('postgres')).jobUnavailable?.('dream.run')).toBeNull();
    const moduleOff = executorDeps(depsFor('firestore', 'documents.process: module off'));
    expect(moduleOff.jobUnavailable?.('documents.process')).toBe('documents.process: module off');
  });
});

describe('calendar reader occurrence provenance', () => {
  it('retains original occurrence identity through actual provider normalization and executor composition', async () => {
    const client = {
      configured: () => true,
      api: async (url: string) =>
        url.includes('calendarList')
          ? { items: [{ id: 'work', summary: 'Work' }] }
          : {
              items: [
                {
                  id: 'moved',
                  iCalUID: 'series',
                  recurringEventId: 'r',
                  originalStartTime: { dateTime: '2026-10-08T09:00:00Z' },
                  start: { dateTime: '2026-10-07T09:00:00Z' },
                  end: { dateTime: '2026-10-07T10:00:00Z' },
                  summary: 'Standup',
                },
              ],
            },
    };
    const deps = {
      db: {},
      persistence: {},
      config: {},
      modules: { channels: [], requireExports: () => client },
    } as unknown as AgentDeps;
    const read = executorDeps(deps).calendarReader;
    if (!read) throw new Error('Calendar reader unavailable');
    const result = await read({
      timeMin: new Date('2026-10-07T00:00:00Z'),
      timeMax: new Date('2026-10-08T00:00:00Z'),
    });
    expect(result.events[0]).toMatchObject({
      eventId: 'moved',
      calendarId: 'work',
      iCalUID: 'series',
      originalStartTime: '2026-10-08T09:00:00Z',
    });
  });
});
