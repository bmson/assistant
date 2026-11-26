import type { Config } from './index.js';

export type GoogleCalendarOAuthConfig = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};
export function googleHouseholdExtendedPurposesReady(
  config: Pick<
    Config,
    | 'GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED'
    | 'GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_COMPATIBILITY_CONFIRMED'
  >,
  mode = process.env.NODE_ENV,
): boolean {
  return (
    config.GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED &&
    (mode === 'development' ||
      mode === 'test' ||
      (mode === 'production' && config.GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_COMPATIBILITY_CONFIRMED))
  );
}

export function googleCalendarOAuthConfig(
  config: Pick<
    Config,
    | 'ASSISTANT_MODULES'
    | 'GOOGLE_OAUTH_CLIENT_ID'
    | 'GOOGLE_OAUTH_CLIENT_SECRET'
    | 'GOOGLE_CALENDAR_OAUTH_CALLBACK_URL'
    | 'MCP_ENC_KEY'
  > &
    Partial<Pick<Config, 'AUTH_GOOGLE_ID' | 'AUTH_GOOGLE_SECRET'>>,
): GoogleCalendarOAuthConfig | null {
  // Select a complete pair; never combine a dashboard client with a Workspace secret.
  const pair =
    config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET
      ? { clientId: config.GOOGLE_OAUTH_CLIENT_ID, clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET }
      : config.AUTH_GOOGLE_ID && config.AUTH_GOOGLE_SECRET
        ? { clientId: config.AUTH_GOOGLE_ID, clientSecret: config.AUTH_GOOGLE_SECRET }
        : null;
  if (
    !config.ASSISTANT_MODULES.some((module) => module === 'google' || module === 'calendar') ||
    !pair ||
    !/^[a-f0-9]{64}$/i.test(config.MCP_ENC_KEY)
  )
    return null;
  try {
    const url = new URL(config.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/api/oauth/google-calendar/callback'
    )
      return null;
    return {
      ...pair,
      callbackUrl: url.href,
    };
  } catch {
    return null;
  }
}
