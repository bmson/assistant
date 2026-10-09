import type { Config } from '@assistant/config';
import { describe, expect, it, vi } from 'vitest';
import { type EmailSyncDeps, syncMailboxWithDistributedLock } from './email-sync.js';

function fixture(
  options: {
    ready?: () => Promise<boolean>;
    lastHistoryId?: bigint | null;
    enabled?: boolean;
  } = {},
) {
  const ready = options.ready ?? vi.fn(async () => true);
  const emailSync = {
    withLock: vi.fn(
      async <T>(run: (lease: import('@assistant/persistence').EmailSyncLease) => Promise<T>) => {
        const lease = {
          holder: 'test-holder',
          generation: 1,
          renew: vi.fn(async () => {}),
          assertCurrent: vi.fn(async () => {}),
        };
        return { value: await run(lease) };
      },
    ),
    mailbox: vi.fn(async () => ({ agentId: 'agent-1', name: 'Owner', email: 'owner@example.com' })),
    syncState: vi.fn(async () =>
      options.lastHistoryId === undefined
        ? null
        : { lastHistoryId: options.lastHistoryId, cursor: null },
    ),
    contactTrust: vi.fn(async () => []),
    raiseBaseline: vi.fn(async () => {}),
    saveCursor: vi.fn(async () => {}),
    completeDrain: vi.fn(async () => {}),
    setWatchExpiration: vi.fn(async () => {}),
    conversationForThread: vi.fn(async () => 'conversation-1'),
    recordIngest: vi.fn(async () => null),
    markTriaged: vi.fn(async () => {}),
    inboundMessage: vi.fn(async () => null),
    hasTaskForEvent: vi.fn(async () => false),
    ingestRecord: vi.fn(async () => null),
    triagedSince: vi.fn(async () => 0),
    replyThread: vi.fn(async () => null),
    listRecoverableDirectIngests: vi.fn(async () => []),
    markDirectIngestRecoveryUnavailable: vi.fn(async () => true),
  };
  const api = vi.fn(async () => ({ historyId: '42' }));
  const deps = {
    config: {
      ASSISTANT_MODULES: ['google'],
      GMAIL_SYNC_ENABLED: options.enabled === false ? 'false' : 'true',
    } as unknown as Config,
    persistence: { emailSync },
    googleClient: { configured: () => true, api },
    operationalReady: ready,
  } as unknown as EmailSyncDeps;
  return { deps, emailSync, api, ready };
}

describe('Gmail activation fence', () => {
  it('does not read Gmail or mutate sync state while activation is pending', async () => {
    const f = fixture({ ready: vi.fn(async () => false) });

    await expect(syncMailboxWithDistributedLock(f.deps)).rejects.toThrow('not operationally ready');

    expect(f.api).not.toHaveBeenCalled();
    expect(f.emailSync.mailbox).not.toHaveBeenCalled();
    expect(f.emailSync.raiseBaseline).not.toHaveBeenCalled();
    expect(f.emailSync.saveCursor).not.toHaveBeenCalled();
  });

  it('resumes a baseline sync after explicit activation', async () => {
    let active = false;
    const f = fixture({ ready: async () => active });

    await expect(syncMailboxWithDistributedLock(f.deps)).rejects.toThrow('not operationally ready');
    expect(f.api).not.toHaveBeenCalled();

    active = true;
    await expect(syncMailboxWithDistributedLock(f.deps)).resolves.toEqual({
      processed: 0,
      morePending: false,
    });
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.emailSync.raiseBaseline).toHaveBeenCalledWith(
      'owner@example.com',
      42n,
      expect.objectContaining({ holder: 'test-holder', generation: 1 }),
    );
  });

  it('rechecks activation after profile read before writing a checkpoint', async () => {
    let active = true;
    const ready = vi.fn(async () => active);
    const f = fixture({ ready, lastHistoryId: 21n });
    f.api.mockImplementation(async () => {
      active = false;
      return { historyId: '42' };
    });

    await expect(syncMailboxWithDistributedLock(f.deps)).rejects.toThrow('not operationally ready');

    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.emailSync.saveCursor).not.toHaveBeenCalled();
    expect(f.emailSync.completeDrain).not.toHaveBeenCalled();
  });

  it('does not enter the lock or Gmail when sync is explicitly disabled', async () => {
    const f = fixture({ enabled: false });

    await expect(syncMailboxWithDistributedLock(f.deps)).resolves.toEqual({ processed: 0 });

    expect(f.emailSync.withLock).not.toHaveBeenCalled();
    expect(f.api).not.toHaveBeenCalled();
    expect(f.emailSync.mailbox).not.toHaveBeenCalled();
  });

  it('stops an active drain when sync is disabled during a provider read', async () => {
    const f = fixture();
    f.api.mockImplementation(async () => {
      f.deps.config.GMAIL_SYNC_ENABLED = 'false';
      return { historyId: '42' };
    });

    await expect(syncMailboxWithDistributedLock(f.deps)).rejects.toThrow('Gmail sync disabled');

    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.emailSync.raiseBaseline).not.toHaveBeenCalled();
    expect(f.emailSync.saveCursor).not.toHaveBeenCalled();
    expect(f.emailSync.completeDrain).not.toHaveBeenCalled();
  });
});
