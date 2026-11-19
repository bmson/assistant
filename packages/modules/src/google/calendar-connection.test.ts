import { randomUUID } from 'node:crypto';
import { type Config, loadConfig, resetConfigForTest } from '@assistant/config';
import { encryptStoredCredential } from '@assistant/core/mcp-secrets';
import type { ExecutionPersistence } from '@assistant/persistence';
import {
  createGoogleCalendarConnectionRepository,
  emptyGoogleCalendarConnection,
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  type GoogleCalendarConnectionState,
} from '@assistant/persistence';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installModules } from '../install.js';
import type { ModulePlatformContext } from '../platform.js';
import { personalCalendarAccountResolver } from './calendar-connection.js';
import { calendarModule } from './calendar-module.js';
import { googleModule } from './module.js';

function context(config: Config, state: unknown = null) {
  return {
    config,
    db: {},
    registry: new ToolRegistry(),
    router: {},
    workspace: {},
    workspacePrefix: 'test',
    workspaceRoot: '/tmp/assistant-test',
    repoRoot: '/tmp/assistant-test',
    persistence: {
      googleCalendarConnection: { get: vi.fn(async () => state) },
      toolExecution: {},
    } as unknown as ExecutionPersistence,
  } as ModulePlatformContext;
}

const settings = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
  GOOGLE_CALENDAR_OAUTH_CALLBACK_URL:
    'https://assistant.example.test/api/oauth/google-calendar/callback',
  MCP_ENC_KEY: 'ab'.repeat(32),
};

describe('optional personal Google Calendar composition', () => {
  afterEach(() => {
    resetConfigForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { modules: 'calendar', order: [calendarModule] },
    { modules: 'google', order: [googleModule] },
    { modules: 'calendar,google', order: [calendarModule, googleModule] },
    { modules: 'google,calendar', order: [googleModule, calendarModule] },
  ])(
    'installs personal read/create/reconciliation without the legacy bot token for $modules',
    ({ modules, order }) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = context(loadConfig({ ...settings, ASSISTANT_MODULES: modules }));
      expect(() => installModules(order, ctx)).not.toThrow();
      expect(
        ctx.registry
          .all()
          .map(({ tool }) => tool.name)
          .sort(),
      ).toEqual([
        'calendar.availability',
        'calendar.create_event',
        'calendar.list_calendars',
        'calendar.list_events',
        'calendar.reconcile_event_creation',
        'calendar.search_events',
      ]);
    },
  );

  it('keeps assistant writes and Gmail when the legacy token is configured', () => {
    const ctx = context(
      loadConfig({
        ...settings,
        ASSISTANT_MODULES: 'google,calendar',
        BOT_GOOGLE_REFRESH_TOKEN: 'legacy-refresh',
      }),
    );
    installModules([googleModule, calendarModule], ctx);
    expect(ctx.registry.get('calendar.create_event')).toBeDefined();
    expect(ctx.registry.get('gmail.send')).toBeDefined();
    expect(ctx.registry.get('drive.search')).toBeDefined();
    expect(ctx.config.BOT_GOOGLE_REFRESH_TOKEN).toBe('legacy-refresh');
  });

  it('does not register integrations for a minimal installation', () => {
    const ctx = context(loadConfig({ ASSISTANT_MODULES: 'minimal' }));
    installModules([googleModule, calendarModule], ctx);
    expect(ctx.registry.all()).toEqual([]);
  });

  it('keeps never-connected legacy routing available without OAuth onboarding configuration', async () => {
    const ctx = context(loadConfig({ ASSISTANT_MODULES: 'calendar' }));
    const resolve = personalCalendarAccountResolver(ctx.config, ctx.persistence);
    expect(resolve).toBeDefined();
    await expect(resolve?.('owner')).resolves.toBeNull();
  });

  it('does not silently fall back after disconnect or loss of onboarding configuration', async () => {
    const ctx = context(loadConfig({ ...settings, ASSISTANT_MODULES: 'calendar' }), {
      adopted: true,
      connection: null,
    });
    const resolve = personalCalendarAccountResolver(ctx.config, ctx.persistence);
    await expect(resolve?.('owner')).rejects.toThrow('Reconnect');
    const withoutConfiguration = { ...ctx.config, GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: '' };
    await expect(
      personalCalendarAccountResolver(withoutConfiguration, ctx.persistence)?.('owner'),
    ).rejects.toThrow('unavailable');
  });
  it.each([false, true])(
    'keeps version-2 reads usable and permits personal provider POST only with the new release gate=%s',
    async (gate) => {
      vi.stubEnv('MCP_ENC_KEY', settings.MCP_ENC_KEY);
      resetConfigForTest();
      for (const [key, value] of Object.entries({
        ASSISTANT_RELEASE_API_CONTRACT: gate ? '2' : '1',
        ASSISTANT_RELEASE_AGENT_API_MIN: '2',
        ASSISTANT_RELEASE_AGENT_API_MAX: '2',
        ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
        ASSISTANT_RELEASE_SCHEMA_VERSION: '2',
        ASSISTANT_RELEASE_SCHEMA_MIN: '2',
        ASSISTANT_RELEASE_SCHEMA_MAX: '2',
      }))
        vi.stubEnv(key, value);
      const config = loadConfig({
        ...settings,
        ASSISTANT_MODULES: 'calendar',
        BOT_GOOGLE_REFRESH_TOKEN: 'unchanged',
      });
      let state: GoogleCalendarConnectionState = {
        ...emptyGoogleCalendarConnection('owner'),
        version: 2,
        adopted: true,
        connection: {
          id: randomUUID(),
          credentialVersion: 0,
          refreshLease: null,
          account: { subject: 'subject', email: 'owner@example.com' },
          refreshTokenEncrypted: encryptStoredCredential('refresh'),
          accessTokenEncrypted: encryptStoredCredential('access'),
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: ['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE],
          status: 'connected',
          connectedAt: new Date().toISOString(),
        },
      };
      const repository = createGoogleCalendarConnectionRepository({
        read: async () => structuredClone(state),
        async update(_owner, change) {
          const next = change(structuredClone(state));
          state = next.state;
          return next.result;
        },
      });
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json({ id: 'synthetic' }));
      const account = await personalCalendarAccountResolver(config, {
        googleCalendarConnection: repository,
      } as unknown as ExecutionPersistence)?.('owner');
      if (!account) throw Error('Expected personal account');
      expect(account.calendarWrite).toBe(gate);
      const url = 'https://www.googleapis.com/calendar/v3/calendars/selected/events';
      await expect(account.client.api(url)).resolves.toMatchObject({ id: 'synthetic' });
      fetcher.mockClear();
      if (gate) {
        await expect(
          account.client.api(url, { method: 'POST', body: '{}' }),
        ).resolves.toMatchObject({ id: 'synthetic' });
        expect(fetcher).toHaveBeenCalledOnce();
        vi.stubEnv('ASSISTANT_RELEASE_API_CONTRACT', '1');
        fetcher.mockClear();
      }
      await expect(account.client.api(url, { method: 'POST', body: '{}' })).rejects.toThrow(
        'event-write',
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(state.connection?.status).toBe('connected');
      expect(config.BOT_GOOGLE_REFRESH_TOKEN).toBe('unchanged');
    },
  );
  it.each([
    [401, '', 'reconnect_required', 'roster'],
    [403, 'insufficientPermissions', 'reconnect_required', 'roster'],
    [403, 'rateLimitExceeded', 'provider_unavailable', 'roster'],
    [403, 'forbidden', 'connected', 'calendar'],
    [403, 'forbidden', 'provider_unavailable', 'roster'],
  ] as const)(
    'persists the real personal-client HTTP %s %s outcome as %s',
    async (status, reason, expected, surface) => {
      vi.stubEnv('MCP_ENC_KEY', settings.MCP_ENC_KEY);
      resetConfigForTest();
      const config = loadConfig({
        ...settings,
        ASSISTANT_MODULES: 'calendar',
        BOT_GOOGLE_REFRESH_TOKEN: 'legacy-unchanged',
      });
      let state: GoogleCalendarConnectionState = {
        ...emptyGoogleCalendarConnection('owner'),
        adopted: true,
        revision: 2,
        connection: {
          id: randomUUID(),
          credentialVersion: 0,
          refreshLease: null,
          account: { subject: 'subject', email: 'owner@example.com' },
          refreshTokenEncrypted: encryptStoredCredential('refresh'),
          accessTokenEncrypted: encryptStoredCredential('old'),
          accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          scopes: ['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE],
          status: 'connected',
          connectedAt: new Date().toISOString(),
        },
      };
      const repository = createGoogleCalendarConnectionRepository({
        read: async () => structuredClone(state),
        async update(_owner, change) {
          const next = change(structuredClone(state));
          state = next.state;
          return next.result;
        },
      });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/token'))
          return Response.json({ access_token: 'fresh', token_type: 'Bearer', expires_in: 3600 });
        if (String(url).includes('fields=kind'))
          return Response.json({ kind: 'calendar#calendarList' });
        return Response.json({ error: { errors: [{ reason }] } }, { status });
      });
      const persistence = {
        googleCalendarConnection: repository,
      } as unknown as ExecutionPersistence;
      const account = await personalCalendarAccountResolver(config, persistence)?.('owner');
      if (!account) throw new Error('Expected personal account');
      await expect(
        account.client.api(
          surface === 'calendar'
            ? 'https://www.googleapis.com/calendar/v3/calendars/shared/events'
            : 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        ),
      ).rejects.toMatchObject({ status });
      expect(state.connection?.status).toBe(expected);
      expect(config.BOT_GOOGLE_REFRESH_TOKEN).toBe('legacy-unchanged');
      const tokenRequests = fetch.mock.calls.filter(([url]) => String(url).includes('/token'));
      expect(tokenRequests).toHaveLength(status === 401 ? 1 : 0);
      const calendarRequests = fetch.mock.calls.filter(
        ([url]) => !String(url).includes('/token') && !String(url).includes('fields=kind'),
      );
      expect(calendarRequests).toHaveLength(status === 401 ? 2 : 1);
    },
  );
});
