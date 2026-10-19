import { isModuleEnabled } from '@assistant/config/modules';
import { GoogleClient, registerCalendarReadTools } from '@assistant/tools/modules/google';
import { defineModule } from '../platform.js';
import { calendarMeta } from './calendar-meta.js';

/** Calendar reads use Google OAuth and HTTP only; they never touch SQL. */
export const calendarModule = defineModule<GoogleClient>({
  meta: calendarMeta,
  absent: () => new GoogleClient({ clientId: '', clientSecret: '', refreshToken: '' }),
  create: ({ config, registry }) => {
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
    if (!client.configured()) {
      console.warn('calendar module enabled but unavailable — configure Google OAuth credentials');
    } else {
      registerCalendarReadTools(registry, {
        client,
        botEmail: config.ASSISTANT_EMAIL,
        ownerEmail: config.OWNER_EMAIL,
      });
    }
    return { exports: client };
  },
});
