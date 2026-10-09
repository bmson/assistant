import { getAgent } from '@assistant/core/chat';
import { ApnsClient } from '@assistant/tools/modules/push';
import { defineModule, type ModuleHooks } from '../platform.js';
import {
  drainPushNotificationOutbox,
  notifyApprovalsByPush,
  notifyOwnerByPush,
  type PushChannelDeps,
} from './channel.js';
import { pushMeta } from './meta.js';

/**
 * A client with no credentials: `configured()` is false and every send is
 * skipped. Declared as the module's `absent` value so the composition root can
 * hold a plain field and callers can query it freely.
 */
const unconfiguredApnsClient = () => new ApnsClient('', '', '', '');

/**
 * APNs owner channel: an owner-notifier leg alongside SMS, so notices and
 * approval pings reach the iOS app even when it is closed. Device tokens
 * arrive through the mobile API (POST /api/mobile/v1/devices); this module
 * only reads them. Self-guards on `configured()` exactly like the SMS channel.
 */
export const pushModule = defineModule<ApnsClient>({
  meta: pushMeta,
  absent: unconfiguredApnsClient,
  create: ({ config, db, persistence }) => {
    const client = new ApnsClient(
      config.APNS_KEY_ID,
      config.APNS_TEAM_ID,
      config.APNS_PRIVATE_KEY,
      config.APNS_BUNDLE_ID,
    );
    // Devices come from the persistence bundle on either driver. The owner is
    // the configured Firestore agent, or PostgreSQL's single agent row.
    const devices = persistence.deviceTokens;
    if (!devices) throw new Error('push: persistence has no device-token repository');
    const firestore = config.PERSISTENCE_DRIVER === 'firestore';
    const channelDeps: PushChannelDeps = {
      apns: client,
      devices,
      notificationOutbox: persistence.notificationOutbox,
      owner: firestore
        ? async () => {
            const owner = await persistence.executionContext.getAgent(config.FIRESTORE_AGENT_ID);
            if (!owner) throw new Error('push: the configured owner is missing');
            return owner;
          }
        : () => getAgent(db),
    };

    const hooks: ModuleHooks = {
      ownerNotifier: {
        notifyOwner: (input) => notifyOwnerByPush(channelDeps, input),
        notifyApprovals: (approvalsToPing) =>
          notifyApprovalsByPush(channelDeps, [...approvalsToPing]),
      },
      sweepSteps: [
        {
          name: 'drainPushNotificationOutbox',
          portable: true,
          run: async () => drainPushNotificationOutbox(channelDeps),
        },
      ],
    };
    return { exports: client, hooks };
  },
});
