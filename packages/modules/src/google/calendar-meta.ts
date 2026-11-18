import { googleCalendarOAuthConfig } from '@assistant/config/google-calendar';
import type { ModuleMeta } from '../contract.js';

/**
 * PostgreSQL-independent Google Calendar reads and approved personal event creation. Gmail and the
 * remaining Workspace tools stay in the separate `google` module.
 */
export const calendarMeta = {
  name: 'calendar',
  title: 'Google Calendar',
  summary: 'Read calendars and availability; optionally approve personal event creation.',
  configKeys: [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'BOT_GOOGLE_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_OAUTH_CALLBACK_URL',
    'MCP_ENC_KEY',
  ],
  readiness: (config) => {
    const ready = Boolean(
      config.GOOGLE_OAUTH_CLIENT_ID &&
        config.GOOGLE_OAUTH_CLIENT_SECRET &&
        config.BOT_GOOGLE_REFRESH_TOKEN,
    );
    if (ready) return { ready: true, detail: 'ready' };
    if (googleCalendarOAuthConfig(config)) {
      return {
        ready: true,
        detail: 'personal Calendar onboarding configured; account connection checked separately',
      };
    }
    return { ready: false, detail: 'missing Google OAuth credentials' };
  },
  infra: { gcpApis: ['calendar-json.googleapis.com'] },
  billing: { gcp: [], external: [] },
} satisfies ModuleMeta;
