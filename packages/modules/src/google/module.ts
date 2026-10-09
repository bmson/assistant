import { appendSignature, loadVoiceContext, rewriteInVoice } from '@assistant/core';
import type {
  ApplicationConfirmationRepository,
  ExecutionPersistence,
} from '@assistant/persistence';
import {
  GoogleClient,
  registerApplicationTools,
  registerCalendarTools,
  registerDocsTools,
  registerDriveTools,
  registerGmailTools,
  registerSheetsTools,
  registerSlidesTools,
} from '@assistant/tools/modules/google';
import { drainEmailObservers } from '../email-observers.js';
import { defineModule, type ModuleHooks, type ModuleServices } from '../platform.js';
import {
  applicationConfirmationTaskHandlers,
  applicationPersistence,
  reapExpiredApplicationWatches,
} from './application-confirmations.js';
import { googleDurableEmailObservers } from './durable-email-observers.js';
import { sweepEmailAttachmentCustodyCleanup } from './email-attachment-cleanup.js';
import { cardFromEmail } from './email-cards.js';
import { deliverEmailFinal } from './email-channel.js';
import {
  type EmailSyncDeps,
  MailboxSyncCoordinator,
  renewWatch,
  syncMailboxWithDistributedLock,
} from './email-sync.js';
import { googleMeta } from './meta.js';
import { emailObserverWorkerEnabled, gmailSyncEnabled } from './runtime.js';

/** Mail state and the owner's voice, from the persistence bundle of either driver. */
function emailPersistence(persistence: ExecutionPersistence) {
  const { emailSync, voiceContext } = persistence;
  if (!emailSync || !voiceContext)
    throw new Error('google: persistence has no mail or voice repository');
  return { emailSync, voiceContext };
}

/** The watch repository, resolved when a tool runs so a bundle without it still installs. */
function lazyApplications(persistence: ExecutionPersistence): ApplicationConfirmationRepository {
  return new Proxy({} as ApplicationConfirmationRepository, {
    get(_target, property) {
      if (property === 'kind') return 'application-confirmation-repository';
      const repository = persistence.applications;
      if (!repository) throw new Error('application confirmations need a persistence repository');
      const value = repository[property as keyof ApplicationConfirmationRepository];
      return typeof value === 'function' ? value.bind(repository) : value;
    },
  });
}

/**
 * A client with no credentials: `configured()` is false and every call is
 * refused. Declared as the module's `absent` value so the
 * composition root can hold a plain field and callers can query it freely.
 */
const unconfiguredGoogleClient = () =>
  new GoogleClient({ clientId: '', clientSecret: '', refreshToken: '' });

export const googleModule = defineModule<GoogleClient>({
  meta: googleMeta,
  absent: unconfiguredGoogleClient,
  create: ({ config, db, registry, router, workspace, persistence }) => {
    const client = new GoogleClient({
      clientId: config.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: config.BOT_GOOGLE_REFRESH_TOKEN,
    });

    const syncDeps = (services: ModuleServices): EmailSyncDeps => ({
      config: services.config,
      db: services.db,
      persistence: services.persistence,
      router: services.router,
      workspace: services.workspace,
      googleClient: client,
      notifyOwner: services.ownerNotifier.notifyOwner,
      operationalReady: services.operationalReady,
      observeInboundEmail: async (event) => {
        for (const observe of services.emailObservers) {
          await observe(services, event).catch((err) =>
            console.error('inbound email observer failed', err),
          );
        }
      },
      durableEmailObservers: services.durableEmailObservers,
    });
    const confirmDeps = (services: ModuleServices) => ({
      persistence: applicationPersistence(services.persistence),
      notifyOwner: services.ownerNotifier.notifyOwner,
    });

    // Single-flight per runtime instance, not per module file: the coordinator
    // coalesces concurrent Pub/Sub pokes and scheduler ticks, and lives in this
    // closure so tests (and any second create()) get their own.
    let nextSyncDeps: EmailSyncDeps | undefined;
    const coordinator = new MailboxSyncCoordinator(async () => {
      if (!nextSyncDeps) throw new Error('mailbox sync dependencies unavailable');
      return syncMailboxWithDistributedLock(nextSyncDeps);
    });
    const sync = (services: ModuleServices) => {
      nextSyncDeps = syncDeps(services);
      // Observer rows are admitted atomically, but the worker remains paused
      // until every registered side effect has a fenced/idempotent delivery path.
      return coordinator.sync();
    };

    // Hooks exist on the unconfigured branch too: routes must answer (the
    // guards inside self-report), and sync no-ops on an unconfigured client —
    // exactly the behavior the agent had when these were hardcoded.
    const hooks: ModuleHooks = {
      // Bookings, tickets, deliveries and appointments in the owner's mail
      // become saved cards as they arrive (email-cards.ts).
      durableEmailObservers: googleDurableEmailObservers(client),
      emailObservers: [
        async (services, event) => {
          if (!services.config.GENERATIVE_CARDS_ENABLED) return;
          await cardFromEmail(
            {
              router: services.router,
              generatedCards: services.persistence.generatedCards,
              notifications: services.persistence.notifications,
              notifyOwner: services.ownerNotifier.notifyOwner,
            },
            { ...event, now: event.now ?? new Date() },
          );
        },
      ],
      webhooks: [
        {
          path: '/gmail/pubsub',
          handler: async (services) => {
            if (!gmailSyncEnabled(services.config)) {
              return { status: 200, json: { skipped: true, reason: 'gmail sync disabled' } };
            }
            // The push payload is only a poke — history.list is the source of
            // truth. Acknowledge only after the durable history cursor
            // advances; Pub/Sub retries a non-2xx, so a crash loses no poke.
            try {
              await sync(services);
            } catch (error) {
              if (!gmailSyncEnabled(services.config)) {
                return { status: 200, json: { skipped: true, reason: 'gmail sync disabled' } };
              }
              console.error('pubsub-triggered sync failed', error);
              return { status: 503, json: { error: 'mailbox sync failed' } };
            }
            return { status: 200, json: { ok: true } };
          },
        },
      ],
      internalRoutes: [
        {
          path: '/gmail/watch',
          handler: async (services) => {
            if (!gmailSyncEnabled(services.config)) {
              return { status: 200, json: { skipped: true, reason: 'gmail sync disabled' } };
            }
            if (!services.config.GMAIL_PUBSUB_TOPIC) {
              return {
                status: 501,
                json: {
                  error:
                    'GMAIL_PUBSUB_TOPIC not set — local dev uses polling; push arrives with deploy',
                },
              };
            }
            const expiration = await renewWatch(
              syncDeps(services),
              services.config.GMAIL_PUBSUB_TOPIC,
            );
            return { status: 200, json: { renewed: true, expiration: expiration.toISOString() } };
          },
        },
        {
          path: '/gmail/sync',
          handler: async (services) => {
            if (!gmailSyncEnabled(services.config)) {
              return {
                status: 200,
                json: { skipped: true, reason: 'gmail sync disabled by module or setting' },
              };
            }
            return { status: 200, json: await sync(services) };
          },
        },
      ],
      // Local fallback cadence (~30s against the 2s tick); prod uses Pub/Sub
      // push plus the every-minute scheduler job above.
      ticks: [
        {
          name: 'email-sync',
          everyTicks: 15,
          // Sync state, the mailbox lock, and ingest go through persistence.
          portable: true,
          run: async (services) => {
            if (!client.configured() || !gmailSyncEnabled(services.config)) return;
            await sync(services);
          },
        },
      ],
      sweepSteps: [
        {
          name: 'drainEmailObserverWork',
          reportKey: 'emailObserverWorkClaimed',
          portable: true,
          run: async (services) => {
            if (!emailObserverWorkerEnabled(services.config) || !client.configured()) return 0;
            const emailSync = services.persistence.emailSync;
            if (!emailSync) throw new Error('email observer persistence is unavailable');
            const mailbox = await emailSync.mailbox();
            const result = await drainEmailObservers(services, mailbox.agentId, {
              limit: 20,
              shouldContinue: () =>
                emailObserverWorkerEnabled(services.config) && client.configured(),
            });
            return result.claimed;
          },
        },
        {
          name: 'sweepEmailAttachmentCustodyCleanup',
          portable: true,
          run: async (services) => {
            const emailSync = services.persistence.emailSync;
            if (!emailSync) return 0;
            const mailbox = await emailSync.mailbox();
            return sweepEmailAttachmentCustodyCleanup(
              services.persistence.emailAttachmentCustody,
              services.workspace.emailAttachmentCustody,
              mailbox.agentId,
            );
          },
        },
        {
          name: 'reapExpiredApplicationWatches',
          // Preserves the /internal/sweep response key from the hardcoded era.
          reportKey: 'expiredWatches',
          portable: true,
          run: (services) => reapExpiredApplicationWatches(confirmDeps(services)),
        },
      ],
      taskHandlers: applicationConfirmationTaskHandlers,
      channel: {
        name: 'email',
        assertDeliverable: (task) => {
          if (task.type === 'email_triage' && task.trust === 'owner' && !client.configured()) {
            throw new Error('email final delivery is not configured');
          }
        },
        deliverFinal: async (services, task, text, attemptId) => {
          return deliverEmailFinal(
            { persistence: emailPersistence(services.persistence), googleClient: client },
            task,
            text,
            attemptId,
          );
        },
        deliverApprovalNotice: async (services, task, text) => {
          await deliverEmailFinal(
            { persistence: emailPersistence(services.persistence), googleClient: client },
            task,
            text,
          );
        },
      },
    };

    if (!client.configured()) {
      console.warn('google module enabled but unavailable — run pnpm auth:bot');
      return { exports: client, hooks };
    }

    const prepareOutbound = async (
      text: string,
      register: 'email_casual' | 'email_professional',
    ) => {
      const voice = await loadVoiceContext(persistence.voiceContext ?? db, router, register, text);
      const result = await rewriteInVoice(router, { draft: text, register, context: voice });
      return { text: appendSignature(result.text, voice.signature), flagged: result.flagged };
    };

    registerGmailTools(registry, {
      client,
      botEmail: config.ASSISTANT_EMAIL,
      botName: config.ASSISTANT_NAME,
      workspace,
      prepareOutbound,
    });
    registerCalendarTools(registry, {
      client,
      botEmail: config.ASSISTANT_EMAIL,
      ownerEmail: config.OWNER_EMAIL,
    });
    registerDocsTools(registry, {
      client,
      botEmail: config.ASSISTANT_EMAIL,
      ownerEmail: config.OWNER_EMAIL,
    });
    registerDriveTools(registry, {
      client,
      workspace,
      catalog: persistence.documentCatalog ?? db,
    });
    registerSheetsTools(registry, { client, ownerEmail: config.OWNER_EMAIL });
    registerSlidesTools(registry, { client, ownerEmail: config.OWNER_EMAIL });
    registerApplicationTools(registry, {
      client,
      // Resolved per call so a bundle without the repository still installs.
      applications: lazyApplications(persistence),
      tasks: persistence.tasks,
    });
    return { exports: client, hooks };
  },
});
