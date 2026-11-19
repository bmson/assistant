import { createHmac } from 'node:crypto';
import type { Config } from '@assistant/config';
import {
  getGoogleCalendarAccessToken,
  googleCalendarOAuthConfig,
  googleCalendarWriteContractReady,
  reportGoogleCalendarReadFailure,
} from '@assistant/core/google-calendar-oauth';
import { type ExecutionPersistence, GOOGLE_CALENDAR_WRITE_SCOPE } from '@assistant/persistence';
import { GoogleClient, type PersonalCalendarReadAccount } from '@assistant/tools/modules/google';

/** Optional connection authority. No account or configuration is required at boot. */
export function personalCalendarAccountResolver(
  config: Config,
  persistence: ExecutionPersistence,
): ((agentId: string) => Promise<PersonalCalendarReadAccount | null>) | undefined {
  const oauth = googleCalendarOAuthConfig(config);
  const repository = persistence?.googleCalendarConnection;
  if (!repository) return undefined;
  return async (agentId) => {
    const state = await repository.get(agentId);
    if (!state?.adopted && !state?.connection) return null;
    if (!oauth) {
      throw new Error('Personal Google Calendar access is unavailable on this assistant server.');
    }
    const connection = state?.connection;
    if (!connection || connection.status === 'reconnect_required') {
      throw new Error(
        'Reconnect your personal Google Calendar in Settings, or explicitly use the assistant account.',
      );
    }
    const connectionId = connection.id;
    const cursorSecret = createHmac('sha256', config.MCP_ENC_KEY)
      .update(JSON.stringify([agentId, connectionId, connection.account.subject]))
      .digest('hex');
    return {
      ...connection.account,
      connectionId,
      calendarWrite:
        googleCalendarWriteContractReady() &&
        connection.status === 'connected' &&
        connection.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE),
      client: new GoogleClient({
        clientId: '',
        clientSecret: '',
        refreshToken: '',
        tokenProvider: {
          cursorSecret,
          authorizeRequest: async (_url, method) => {
            const current = (await repository.get(agentId))?.connection;
            if (
              !current ||
              current.id !== connectionId ||
              current.account.subject !== connection.account.subject ||
              current.status !== 'connected'
            )
              throw new Error('The personal Calendar connection changed. Review the action again.');
            if (
              !['GET', 'HEAD'].includes(method) &&
              (!googleCalendarWriteContractReady() ||
                !current.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE))
            )
              throw new Error('Enable optional Calendar event-write access in Settings first.');
          },
          requestFailed: (failure) =>
            reportGoogleCalendarReadFailure({
              repository,
              ownerId: agentId,
              connectionId,
              ...failure,
            }),
          accessToken: async (forceRefresh = false, rejectedAccessToken) => {
            const access = await getGoogleCalendarAccessToken({
              repository,
              ownerId: agentId,
              config: oauth,
              expectedConnectionId: connectionId,
              forceRefresh,
              rejectedAccessToken: forceRefresh ? rejectedAccessToken : undefined,
            });
            if (access.connectionId !== connectionId) {
              throw new Error(
                'The Google Calendar connection changed. Start this calendar read again.',
              );
            }
            return { accessToken: access.accessToken, credentialVersion: access.credentialVersion };
          },
        },
      }),
    };
  };
}
