import { type Config, loadConfig, resetConfigForTest } from '@assistant/config';
import type { Db } from '@assistant/db';
import type { ExecutionPersistence } from '@assistant/persistence';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleMeta } from './contract.js';
import { documentsModule } from './documents/module.js';
import { calendarModule } from './google/calendar-module.js';
import { googleModule } from './google/module.js';
import { installModules } from './install.js';
import { defineModule, type ModulePlatformContext, type OwnerNotifier } from './platform.js';
import { remindersModule } from './reminders/module.js';
import { smsModule } from './sms/module.js';
import { watchesModule } from './watches/module.js';

/**
 * Only tool-registering modules are installed here, so the unused halves of the
 * platform context are never dereferenced.
 */
function contextFor(config: Config): ModulePlatformContext {
  return {
    config,
    db: {} as Db,
    registry: new ToolRegistry(),
    router: { embed: async () => [] } as unknown as ModulePlatformContext['router'],
    workspace: {} as ModulePlatformContext['workspace'],
    workspacePrefix: 'workspace/test',
    workspaceRoot: '/tmp/assistant-test',
    repoRoot: '/tmp/assistant-test',
    persistence: {} as ExecutionPersistence,
  };
}

describe('installModules', () => {
  afterEach(() => resetConfigForTest());

  it('installs only the modules the configuration selects', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([remindersModule, watchesModule], context);

    expect(installed.installed).toEqual(['reminders']);
    expect(context.registry.get('reminder.create')).toBeDefined();
    expect(context.registry.get('watch.create')).toBeUndefined();
  });

  it('registers nothing at all for a minimal installation', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'minimal' }));
    const installed = installModules([remindersModule, watchesModule], context);

    expect(installed.installed).toEqual([]);
    expect(context.registry.all()).toHaveLength(0);
  });

  it('reports no exports for a module that is not installed', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'minimal' }));
    const installed = installModules([documentsModule], context);

    expect(installed.exportsOf(documentsModule)).toBeUndefined();
  });

  it('completes a queued job whose module was removed', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([documentsModule, remindersModule], context);

    expect(installed.jobUnavailable('documents.extract')).toBe(
      'documents.extract skipped because the documents module is disabled',
    );
    expect(installed.jobUnavailable('memory.extract')).toBeNull();
  });

  it('runs a job normally while its module is installed', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'documents' }));
    const installed = installModules([documentsModule], context);

    expect(installed.jobUnavailable('documents.extract')).toBeNull();
  });

  it('reports an owner-facing task type undeliverable when its channel module is absent', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([remindersModule, googleModule, smsModule], context);

    expect(installed.channelUnavailable('email_triage')).toContain('google');
    expect(installed.channelUnavailable('sms_turn')).toContain('sms');
    // A task type no module claims delivery for is never a delivery failure.
    expect(installed.channelUnavailable('chat_turn')).toBeNull();
  });

  it('reports a task type deliverable while its channel module is installed', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'google,sms' }));
    const installed = installModules([googleModule, smsModule], context);

    expect(installed.channelUnavailable('email_triage')).toBeNull();
    expect(installed.channelUnavailable('sms_turn')).toBeNull();
  });

  it.each([
    { modules: 'google,calendar', order: [calendarModule, googleModule] },
    { modules: 'all', order: [googleModule, calendarModule] },
  ])(
    'does not double-register Calendar tools when ASSISTANT_MODULES=$modules',
    ({ modules, order }) => {
      const context = contextFor(
        loadConfig({
          ASSISTANT_MODULES: modules,
          GOOGLE_OAUTH_CLIENT_ID: 'test-client',
          GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
          BOT_GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
        }),
      );
      const warning = console.warn;
      console.warn = () => {};
      try {
        expect(() => installModules(order, context)).not.toThrow();
      } finally {
        console.warn = warning;
      }

      expect(context.registry.get('calendar.availability')).toBeDefined();
      expect(context.registry.get('calendar.list_events')).toBeDefined();
      expect(context.registry.get('calendar.create_event')).toBeDefined();
    },
  );

  it('reports a deterministic task kind orphaned when its owning module is absent', () => {
    const disabled = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const withoutGoogle = installModules([remindersModule, googleModule], disabled);
    expect(withoutGoogle.taskKindUnavailable('application_confirmation')).toContain('google');
    // A kind no module owns (e.g. known-sender-reply) still goes to the executor.
    expect(withoutGoogle.taskKindUnavailable('known_sender_reply')).toBeNull();

    resetConfigForTest(); // loadConfig caches; the second config needs a reset
    const enabled = contextFor(loadConfig({ ASSISTANT_MODULES: 'google' }));
    const withGoogle = installModules([googleModule], enabled);
    expect(withGoogle.taskKindUnavailable('application_confirmation')).toBeNull();
  });
});

describe('composition as a restrictor', () => {
  afterEach(() => resetConfigForTest());

  it('warns when configuration names a module this build does not contain', () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders,watches' }));
      installModules([remindersModule], context);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('watches');
    expect(warnings[0]).toContain('assistant.config.ts');
  });

  it('installs the intersection of the composition and the configuration', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([remindersModule, watchesModule], context);
    expect(installed.installed).toEqual(['reminders']);
  });
});

describe('module runtime hooks', () => {
  afterEach(() => resetConfigForTest());

  // A hookless composition must behave exactly as before hooks existed.
  it('aggregates to inert no-ops when no module declares hooks', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([remindersModule], context);

    expect(installed.webhookHandler('/twilio/sms')).toBeUndefined();
    expect(installed.internalHandler('/gmail/sync')).toBeUndefined();
    expect(installed.sweepSteps).toEqual([]);
    expect(installed.ticks).toEqual([]);
    expect(installed.taskHandlerFor('application_confirmation')).toBeUndefined();
    expect(installed.channels).toEqual([]);
    expect(installed.emailObservers).toEqual([]);
  });

  it('reports skipped when no owner notifier is installed', async () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([remindersModule], context);
    await expect(installed.ownerNotifier.notifyOwner({ text: 'hi' })).resolves.toEqual({
      legs: [{ channel: 'none', status: 'skipped' }],
    });
    await expect(installed.ownerNotifier.notifyApprovals([])).resolves.toEqual({
      legs: [{ channel: 'none', status: 'skipped' }],
    });
  });

  const hookMeta = (over: Partial<ModuleMeta>): ModuleMeta =>
    ({ ...remindersModule.meta, ...over }) as ModuleMeta;

  it('refuses a meta-declared webhook with no runtime handler', () => {
    const broken = defineModule({
      meta: hookMeta({ webhooks: [{ path: '/reminders/hook', auth: { kind: 'oneShotToken' } }] }),
      create: () => ({}),
    });
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    expect(() => installModules([broken], context)).toThrow(/declares webhook .* no handler/);
  });

  it('refuses a runtime webhook handler with no meta declaration', () => {
    const broken = defineModule({
      meta: hookMeta({}),
      create: () => ({
        hooks: {
          webhooks: [{ path: '/reminders/hook', handler: async () => ({ status: 200, json: {} }) }],
        },
      }),
    });
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    expect(() => installModules([broken], context)).toThrow(/without declaring it/);
  });

  it('exposes declared hooks and fans the notifier out', async () => {
    const notified: string[] = [];
    const withHooks = defineModule({
      meta: hookMeta({
        webhooks: [{ path: '/reminders/hook', auth: { kind: 'oneShotToken' } }],
        internalRoutes: [{ path: '/reminders/poke' }],
      }),
      create: () => ({
        hooks: {
          webhooks: [{ path: '/reminders/hook', handler: async () => ({ status: 200, json: {} }) }],
          internalRoutes: [
            { path: '/reminders/poke', handler: async () => ({ status: 200, json: {} }) },
          ],
          sweepSteps: [{ name: 'reap', run: async () => 0 }],
          ticks: [{ name: 'tick', everyTicks: 5, run: async () => {} }],
          taskHandlers: [{ kind: 'reminder_fire', run: async () => ({ outcome: 'done' }) }],
          ownerNotifier: {
            notifyOwner: async (input) => {
              notified.push(input.text);
            },
            notifyApprovals: async () => {},
          },
        },
      }),
    });
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([withHooks], context);

    expect(installed.webhookHandler('/reminders/hook')).toBeDefined();
    expect(installed.internalHandler('/reminders/poke')).toBeDefined();
    expect(installed.sweepSteps.map((s) => s.name)).toEqual(['reap']);
    expect(installed.ticks.map((t) => t.name)).toEqual(['tick']);
    expect(installed.taskHandlerFor('reminder_fire')).toBeDefined();
    await installed.ownerNotifier.notifyOwner({ text: 'ping' });
    expect(notified).toEqual(['ping']);
  });

  it('reports independent notifier outcomes instead of resolving total failure as success', async () => {
    const delivered = vi.fn(async () => ({
      legs: [{ channel: 'push', status: 'delivered' as const }],
    }));
    const failing = defineModule({
      meta: hookMeta({ name: 'sms' }),
      create: () => ({
        hooks: {
          ownerNotifier: {
            notifyOwner: async () => {
              throw new Error('provider failed');
            },
            notifyApprovals: async () => ({
              legs: [{ channel: 'sms', status: 'failed' as const }],
            }),
          },
        },
      }),
    });
    const succeeding = defineModule({
      meta: hookMeta({ name: 'push' }),
      create: () => ({
        hooks: { ownerNotifier: { notifyOwner: delivered, notifyApprovals: delivered } },
      }),
    });
    const installed = installModules(
      [failing, succeeding],
      contextFor(loadConfig({ ASSISTANT_MODULES: 'all' })),
    );

    await expect(installed.ownerNotifier.notifyOwner({ text: 'ping' })).resolves.toEqual({
      legs: [
        { channel: 'sms', status: 'failed' },
        { channel: 'push', status: 'delivered' },
      ],
    });
    expect(delivered).toHaveBeenCalledOnce();
  });

  it('retains partial delivery and reports an all-skipped fanout without success', async () => {
    const skipped = vi.fn(async () => ({
      legs: [{ channel: 'push', status: 'skipped' as const }],
    }));
    const delivered = vi.fn(async () => ({
      legs: [{ channel: 'sms', status: 'delivered' as const }],
    }));
    const makeNotifier = (name: ModuleMeta['name'], notifyOwner: OwnerNotifier['notifyOwner']) =>
      defineModule({
        meta: hookMeta({ name }),
        create: () => ({ hooks: { ownerNotifier: { notifyOwner, notifyApprovals: skipped } } }),
      });
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'all' }));
    const partial = installModules(
      [makeNotifier('push', skipped), makeNotifier('sms', delivered)],
      context,
    );
    await expect(partial.ownerNotifier.notifyOwner({ text: 'ping' })).resolves.toEqual({
      legs: [
        { channel: 'push', status: 'skipped' },
        { channel: 'sms', status: 'delivered' },
      ],
    });

    resetConfigForTest();
    const allSkipped = installModules(
      [makeNotifier('push', skipped), makeNotifier('sms', skipped)],
      contextFor(loadConfig({ ASSISTANT_MODULES: 'all' })),
    );
    await expect(allSkipped.ownerNotifier.notifyOwner({ text: 'ping' })).resolves.toEqual({
      legs: [
        { channel: 'push', status: 'skipped' },
        { channel: 'push', status: 'skipped' },
      ],
    });
  });
});

describe('module-owned tools', () => {
  afterEach(() => resetConfigForTest());

  it('registers document search only when the documents module is installed', () => {
    const withDocuments = contextFor(loadConfig({ ASSISTANT_MODULES: 'documents' }));
    installModules([documentsModule], withDocuments);
    expect(withDocuments.registry.get('documents.search')).toBeDefined();

    resetConfigForTest();
    const without = contextFor(loadConfig({ ASSISTANT_MODULES: 'minimal' }));
    installModules([documentsModule], without);
    expect(without.registry.get('documents.search')).toBeUndefined();
  });
});
