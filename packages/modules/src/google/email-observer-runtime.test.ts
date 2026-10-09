import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { Db } from '@assistant/db';
import type {
  EmailObserverClaim,
  EmailObserverClaimResult,
  EmailObserverWorkRecord,
} from '@assistant/persistence';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainEmailObservers } from '../email-observers.js';
import { installModules } from '../install.js';
import { type ModuleServices, noopOwnerNotifier } from '../platform.js';
import { googleModule } from './module.js';

const owner = 'owner-runtime@example.test';
const work = {
  id: 'd0a92711-b550-4fce-bce9-46e695b93d30',
  agentId: 'agent-runtime',
  sourceKey: 'gmail:runtime-event',
  channelMessageId: 'gmail:runtime-event',
  sourceKind: 'message',
  observerKey: 'google.application-confirmation',
  observerVersion: 1,
  workClass: 'idempotent_db',
  status: 'pending',
} as EmailObserverWorkRecord;

function fixture(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    ASSISTANT_MODULES: 'google',
    EMAIL_INGEST_MODE: 'direct',
    ...env,
  });
  const emailSync = {
    mailbox: vi.fn(async () => ({ agentId: 'agent-runtime', name: 'Owner', email: owner })),
    privacyObservationFence: vi.fn(async () => null),
    listDueEmailObservers: vi.fn(async (_agentId: string, _now: Date, _limit: number) => [work]),
    claimEmailObserver: vi.fn(async (): Promise<EmailObserverClaimResult> => ({ kind: 'none' })),
    loadEmailObserverSource: vi.fn(),
    prepareEmailObserver: vi.fn(),
    completeEmailObserver: vi.fn(),
    failEmailObserver: vi.fn(async () => true),
  };
  const emailAttachmentCustody = {
    listEmailAttachmentCustodyCleanup: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const router = { object: vi.fn(), embed: vi.fn() };
  const runtime = installModules([googleModule], {
    config,
    db: {} as Db,
    registry: new ToolRegistry(),
    repoRoot: '/tmp/email-observer-runtime-test',
    router: router as never,
    workspace: {} as never,
    workspacePrefix: 'test',
    workspaceRoot: '/tmp/email-observer-runtime-test',
    persistence: { emailSync, emailAttachmentCustody } as never,
  });
  const worker = runtime.sweepSteps.find((step) => step.name === 'drainEmailObserverWork');
  if (!worker) throw new Error('Google module did not install its durable observer sweep');
  const ready = vi.fn(async () => true);
  const persistence = { emailSync, emailAttachmentCustody };
  const services = {
    config,
    db: {} as Db,
    router,
    registry: new ToolRegistry(),
    dispatcher: {} as never,
    workspace: { emailAttachmentCustody: {} } as never,
    ownerNotifier: noopOwnerNotifier,
    emailObservers: runtime.emailObservers,
    durableEmailObservers: runtime.durableEmailObservers,
    persistence,
    operationalReady: ready,
  } as unknown as ModuleServices;
  return { config, emailAttachmentCustody, emailSync, ready, router, runtime, services, worker };
}

afterEach(() => {
  resetConfigForTest();
  vi.restoreAllMocks();
});

describe('Google durable email observer runtime sweep', () => {
  it('defaults off and performs no readiness check, mailbox read, or claim', async () => {
    const state = fixture({ GMAIL_SYNC_ENABLED: 'true' });
    expect(state.config.EMAIL_OBSERVER_WORKER_ENABLED).toBe(false);

    await expect(state.worker.run(state.services)).resolves.toBe(0);

    expect(state.ready).not.toHaveBeenCalled();
    expect(state.emailSync.mailbox).not.toHaveBeenCalled();
    expect(state.emailSync.claimEmailObserver).not.toHaveBeenCalled();
    expect(state.router.object).not.toHaveBeenCalled();
    const custodyCleanup = state.runtime.sweepSteps.find(
      (step) => step.name === 'sweepEmailAttachmentCustodyCleanup',
    );
    if (!custodyCleanup) throw new Error('attachment custody cleanup sweep is missing');
    await custodyCleanup.run(state.services);
    expect(state.emailAttachmentCustody.listEmailAttachmentCustodyCleanup).toHaveBeenCalledWith({
      agentId: 'agent-runtime',
      cursor: null,
      limit: 50,
    });
  });

  it('does not claim work when Google credentials are absent', async () => {
    const state = fixture({
      EMAIL_OBSERVER_WORKER_ENABLED: 'true',
      GMAIL_SYNC_ENABLED: 'true',
    });

    await expect(state.worker.run(state.services)).resolves.toBe(0);

    expect(state.ready).not.toHaveBeenCalled();
    expect(state.emailSync.mailbox).not.toHaveBeenCalled();
    expect(state.emailSync.claimEmailObserver).not.toHaveBeenCalled();
  });

  it('pauses before listing or claiming work when operational readiness is false', async () => {
    const state = fixture({
      EMAIL_OBSERVER_WORKER_ENABLED: 'true',
      GMAIL_SYNC_ENABLED: 'true',
      GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
      BOT_GOOGLE_REFRESH_TOKEN: 'synthetic-refresh-token',
    });
    state.ready.mockResolvedValue(false);

    await expect(state.worker.run(state.services)).resolves.toBe(0);

    expect(state.ready).toHaveBeenCalledOnce();
    expect(state.emailSync.mailbox).toHaveBeenCalledOnce();
    expect(state.emailSync.listDueEmailObservers).not.toHaveBeenCalled();
    expect(state.emailSync.claimEmailObserver).not.toHaveBeenCalled();
  });

  it('pauses queued work when Gmail sync is explicitly disabled', async () => {
    const state = fixture({
      EMAIL_OBSERVER_WORKER_ENABLED: 'true',
      GMAIL_SYNC_ENABLED: 'false',
      GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
      BOT_GOOGLE_REFRESH_TOKEN: 'synthetic-refresh-token',
    });

    await expect(state.worker.run(state.services)).resolves.toBe(0);

    expect(state.ready).not.toHaveBeenCalled();
    expect(state.emailSync.mailbox).not.toHaveBeenCalled();
    expect(state.emailSync.claimEmailObserver).not.toHaveBeenCalled();
  });

  it('keeps paid email-card work due while generative cards are disabled', async () => {
    const state = fixture({ GENERATIVE_CARDS_ENABLED: 'false' });
    state.emailSync.listDueEmailObservers.mockResolvedValue([
      {
        ...work,
        observerKey: 'google.email-card',
        workClass: 'paid_ambiguous',
      },
    ]);

    const result = await drainEmailObservers(state.services, 'agent-runtime', { limit: 20 });

    expect(state.config.GENERATIVE_CARDS_ENABLED).toBe(false);
    expect(result.claimed).toBe(0);
    expect(state.emailSync.claimEmailObserver).not.toHaveBeenCalled();
    expect(state.router.object).not.toHaveBeenCalled();
  });

  it('drains one bounded row through the installed registry after all gates pass', async () => {
    const state = fixture({
      EMAIL_OBSERVER_WORKER_ENABLED: 'true',
      GMAIL_SYNC_ENABLED: 'true',
      GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
      BOT_GOOGLE_REFRESH_TOKEN: 'synthetic-refresh-token',
    });
    const claim = {
      ...work,
      status: 'claimed',
      claimToken: 'synthetic-claim',
      claimGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      privacyGeneration: null,
      preparedResult: null,
    } as EmailObserverClaim;
    state.emailSync.listDueEmailObservers.mockResolvedValue([work]);
    state.emailSync.claimEmailObserver.mockResolvedValue({ kind: 'claimed', claim });
    state.emailSync.loadEmailObserverSource.mockResolvedValue({
      agentId: work.agentId,
      messageId: 'runtime-event',
      sourceId: work.sourceKey,
      from: 'spoofed@example.test',
      subject: 'Unverified confirmation',
      body: 'A synthetic unverified source used only to prove the real installed observer no-ops.',
      authenticated: false,
      origin: 'unknown',
      contentTrust: 'unknown',
      ingestMode: 'direct',
      sourceVerification: 'authenticated',
      hasExternalOrUnknown: true,
    });

    await expect(state.worker.run(state.services)).resolves.toBe(1);

    expect(state.ready).toHaveBeenCalledTimes(4);
    expect(state.emailSync.mailbox).toHaveBeenCalledOnce();
    expect(state.emailSync.listDueEmailObservers).toHaveBeenCalledWith(
      'agent-runtime',
      expect.any(Date),
      20,
      [{ key: 'google.email-attachments', version: 3, workClass: 'idempotent_db' }],
    );
    expect(state.emailSync.claimEmailObserver).toHaveBeenCalledOnce();
    expect(state.emailSync.failEmailObserver).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'no_op' }),
    );
    expect(state.router.object).not.toHaveBeenCalled();
  });
});
