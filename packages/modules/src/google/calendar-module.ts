import { isModuleEnabled } from '@assistant/config/modules';
import {
  connectedCalendarClient,
  GoogleClient,
  registerCalendarReadTools,
} from '@assistant/tools/modules/google';
import { defineModule } from '../platform.js';
import { calendarMeta } from './calendar-meta.js';

/** Calendar-only reads use HTTP and the portable connected-account repository. */
export const calendarModule = defineModule<GoogleClient>({
  meta: calendarMeta,
  absent: () => new GoogleClient({ clientId: '', clientSecret: '', refreshToken: '' }),
  create: ({ config, registry, persistence }) => {
    const client = new GoogleClient({
      clientId: config.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: config.BOT_GOOGLE_REFRESH_TOKEN,
    });
    if (isModuleEnabled(config, 'google')) {
      // The full Workspace module owns Calendar registration in combined
      // profiles, independent of module composition order.
      return { exports: client };
    }
    const readClient = connectedCalendarClient(client, config, persistence?.calendarAccounts);
    if (!readClient.configured()) {
      console.warn('calendar module enabled but unavailable — configure Google OAuth credentials');
    } else {
      registerCalendarReadTools(registry, {
        client: readClient,
        botEmail: config.ASSISTANT_EMAIL,
        ownerEmail: config.OWNER_EMAIL,
      });
    }
    return { exports: client };
  },
});
