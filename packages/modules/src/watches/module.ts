import { getAgent } from '@assistant/core/chat';
import { registerWatchTools } from '@assistant/tools/watches';
import { defineModule } from '../platform.js';
import { matchEmailWatches, reapExpiredWatches } from './email-watches.js';
import { drainWatchFireEffects } from './fire.js';
import { watchesMeta } from './meta.js';
import { pollDueWebWatches } from './web-watches.js';

export const watchesModule = defineModule({
  meta: watchesMeta,
  create: ({ registry, persistence }) => {
    const watches = persistence.watches;
    registerWatchTools(registry, watches);
    return {
      hooks: {
        // Watches observe every authenticated inbound email (the google module
        // fans these out) and notify through whichever owner channel is
        // installed — never by importing a channel module directly.
        emailObservers: [
          async (services, event) => {
            await matchEmailWatches(
              {
                watches: services.persistence.watches,
                messages: services.persistence.messages,
                tasks: services.persistence.tasks,
                notifyOwner: services.ownerNotifier.notifyOwner,
              },
              event,
            );
          },
        ],
        durableEmailObservers: [
          {
            identity: { key: 'watches.email-match', version: 1, workClass: 'idempotent_db' },
            prepare: async (_services, source) =>
              source.authenticated ? { kind: 'prepared', result: {} } : { kind: 'no_op' },
            apply: async (services, source) => {
              await matchEmailWatches(
                {
                  watches: services.persistence.watches,
                  messages: services.persistence.messages,
                  tasks: services.persistence.tasks,
                  notifyOwner: services.ownerNotifier.notifyOwner,
                },
                {
                  agentId: source.agentId,
                  messageId: source.messageId ?? source.sourceId.replace(/^gmail:/, ''),
                  from: source.from,
                  subject: source.subject,
                  body: source.body,
                  authenticated: source.authenticated,
                },
              );
              return { kind: 'complete' };
            },
          },
        ],
        sweepSteps: [
          {
            name: 'drainWatchFireEffects',
            reportKey: 'watchFireEffectsDrained',
            portable: true,
            run: async (services) => {
              const agentId =
                services.config.PERSISTENCE_DRIVER === 'firestore'
                  ? services.config.FIRESTORE_AGENT_ID
                  : (await getAgent(services.db)).id;
              if (!agentId) return 0;
              const result = await drainWatchFireEffects(
                {
                  watches: services.persistence.watches,
                  messages: services.persistence.messages,
                  tasks: services.persistence.tasks,
                  notifyOwner: services.ownerNotifier.notifyOwner,
                },
                agentId,
              );
              return result.delivered + result.failed + result.unknown;
            },
          },
          {
            name: 'reapExpiredWatches',
            // Preserves the /internal/sweep response key from the hardcoded era.
            reportKey: 'expiredInboxWatches',
            portable: true,
            run: (services) => reapExpiredWatches({ watches: services.persistence.watches }),
          },
          {
            // Poll due web watches ("watch.poll_web"): fetch each watched page
            // through the SSRF-guarded fetch and notify the owner on a change.
            name: 'pollWebWatches',
            reportKey: 'webWatchFires',
            portable: true,
            run: (services) =>
              pollDueWebWatches({
                watches: services.persistence.watches,
                messages: services.persistence.messages,
                tasks: services.persistence.tasks,
                notifyOwner: services.ownerNotifier.notifyOwner,
              }),
          },
        ],
      },
    };
  },
});
