import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { Db } from '@assistant/db';
import type { ExecutionPersistence } from '@assistant/persistence';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleModule } from './google/module.js';
import type { ModulePlatformContext, ModuleServices } from './platform.js';
import { smsModule } from './sms/module.js';

function contextFor(): ModulePlatformContext {
  return {
    config: loadConfig({ ASSISTANT_MODULES: 'google,sms' }),
    db: {} as Db,
    registry: new ToolRegistry(),
    router: {} as ModulePlatformContext['router'],
    workspace: {} as ModulePlatformContext['workspace'],
    workspacePrefix: 'workspace/test',
    workspaceRoot: '/tmp/assistant-test',
    repoRoot: '/tmp/assistant-test',
    persistence: {} as ExecutionPersistence,
  };
}

/**
 * The least-pinned relocation regression: a module missing credentials skips
 * TOOL registration but must still return its full hook set — routes answered
 * (with their own self-reported guards) even before `pnpm auth:bot`, exactly
 * as when they were hardcoded in the agent. A create() that forgets this
 * would 404 production webhooks while every auth test stays green.
 */
describe('unconfigured channel modules still hook the platform', () => {
  afterEach(() => resetConfigForTest());

  it('google returns every hook with no credentials', () => {
    const context = contextFor();
    const runtime = googleModule.create(context);

    expect(context.registry.all()).toHaveLength(0); // no tools without credentials
    expect(runtime.hooks?.webhooks?.map((route) => route.path)).toEqual(['/gmail/pubsub']);
    expect(runtime.hooks?.internalRoutes?.map((route) => route.path)).toEqual([
      '/gmail/watch',
      '/gmail/sync',
    ]);
    expect(runtime.hooks?.ticks?.map((tick) => tick.name)).toEqual(['email-sync']);
    expect(runtime.hooks?.sweepSteps?.map((step) => step.name)).toEqual([
      'drainEmailObserverWork',
      'sweepEmailAttachmentCustodyCleanup',
      'reapExpiredApplicationWatches',
    ]);
    expect(runtime.hooks?.sweepSteps?.map((step) => step.reportKey).filter(Boolean)).toEqual([
      'emailObserverWorkClaimed',
      'expiredWatches',
    ]);
    expect(runtime.hooks?.taskHandlers?.map((handler) => handler.kind)).toEqual([
      'application_confirmation',
      'application_confirmation_ambiguous',
    ]);
    expect(runtime.hooks?.channel).toBeDefined();
  });

  it('explicit Gmail sync disable fences Pub/Sub, manual sync, watch renewal, and tick', async () => {
    const config = loadConfig({ ASSISTANT_MODULES: 'google', GMAIL_SYNC_ENABLED: 'false' });
    const context = { ...contextFor(), config };
    const runtime = googleModule.create(context);
    const withLock = vi.fn(async <T>(run: () => Promise<T>) => ({ value: await run() }));
    const mailbox = vi.fn(async () => ({
      agentId: 'agent',
      name: 'Owner',
      email: 'owner@example.com',
    }));
    const services = {
      config,
      db: {} as Db,
      router: context.router,
      registry: context.registry,
      dispatcher: {} as ModuleServices['dispatcher'],
      workspace: context.workspace,
      ownerNotifier: { notifyOwner: async () => {}, notifyApprovals: async () => {} },
      emailObservers: [],
      persistence: { emailSync: { withLock, mailbox } },
    } as unknown as ModuleServices;
    const request = { json: async () => null, form: async () => ({}), header: () => undefined };
    const pubsub = runtime.hooks?.webhooks?.find((hook) => hook.path === '/gmail/pubsub');
    const manual = runtime.hooks?.internalRoutes?.find((route) => route.path === '/gmail/sync');
    const watch = runtime.hooks?.internalRoutes?.find((route) => route.path === '/gmail/watch');
    const tick = runtime.hooks?.ticks?.find((candidate) => candidate.name === 'email-sync');
    if (!pubsub || !manual || !watch || !tick) throw new Error('Gmail ingress hooks missing');

    await expect(pubsub.handler(services, request)).resolves.toEqual({
      status: 200,
      json: { skipped: true, reason: 'gmail sync disabled' },
    });
    await expect(manual.handler(services)).resolves.toMatchObject({
      status: 200,
      json: { skipped: true },
    });
    await expect(watch.handler(services)).resolves.toEqual({
      status: 200,
      json: { skipped: true, reason: 'gmail sync disabled' },
    });
    await tick.run(services);
    expect(withLock).not.toHaveBeenCalled();
    expect(mailbox).not.toHaveBeenCalled();
  });

  it('sms returns its channel, notifier, and webhook with no credentials', () => {
    const context = contextFor();
    const runtime = smsModule.create(context);

    expect(context.registry.all()).toHaveLength(0);
    expect(runtime.hooks?.webhooks?.map((route) => route.path)).toEqual(['/twilio/sms']);
    expect(runtime.hooks?.channel).toBeDefined();
    expect(runtime.hooks?.ownerNotifier).toBeDefined();
  });
});
