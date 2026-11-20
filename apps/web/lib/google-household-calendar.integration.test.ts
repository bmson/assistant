import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createFirestoreGoogleCalendarConnectionRepository } from '@assistant/firestore';
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  type GoogleCalendarConnectionRepository,
  type HouseholdCalendarSettings,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, PUT } from '@/app/api/mobile/v1/connections/google-calendar/household/route';
import { getDb, getFirestoreInstallationStore } from './server';

vi.mock('@/auth', () => ({ isAuthed: vi.fn() }));

const base = 'https://assistant.example.test/api/mobile/v1/connections/google-calendar/household';
const token = 'synthetic-household-phone-bearer';
const calendarAccessToken = 'synthetic-personal-calendar-access';
const types = ['postgres', 'firestore'] as const;

function request(path = '', body?: object, authenticated = true) {
  return new Request(base + path, {
    method: body ? 'PUT' : 'GET',
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe.each(types)('household Calendar through mobile routes on %s', (driver) => {
  const loopbackEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
    process.env.FIRESTORE_EMULATOR_HOST ?? '',
  );
  const enabled =
    driver === 'firestore' ? loopbackEmulator : !!process.env.ASSISTANT_TEST_TARGET_TOKEN;
  let cleanup: (() => Promise<unknown>) | undefined;

  afterEach(async () => {
    try {
      await cleanup?.();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      resetConfigForTest();
    }
  });

  it.skipIf(!enabled)(
    'saves, reopens and enforces choices before requesting calendar data',
    async () => {
      let owner: string = randomUUID();
      vi.stubEnv('ASSISTANT_MODULES', 'calendar');
      vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'fixture-client');
      vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'fixture-secret');
      vi.stubEnv(
        'GOOGLE_CALENDAR_OAUTH_CALLBACK_URL',
        'https://assistant.example.test/api/oauth/google-calendar/callback',
      );
      vi.stubEnv('MCP_ENC_KEY', 'a'.repeat(64));
      vi.stubEnv('MOBILE_API_TOKEN', token);
      vi.stubEnv('PERSISTENCE_DRIVER', driver);
      vi.stubEnv('FIRESTORE_AGENT_ID', owner);
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', `b2-${owner}`);
      vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
      vi.stubEnv(
        'FIRESTORE_EMBEDDING_SPACE',
        '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
      );
      vi.stubEnv('QUEUE_DRIVER', 'local');
      vi.stubEnv('CANARY_ENABLED', 'false');
      vi.stubEnv('RESTORE_REHEARSAL', 'false');
      resetConfigForTest();

      let repository: GoogleCalendarConnectionRepository;
      let seedStoredChoices: (
        settings: HouseholdCalendarSettings & { connectionId: string },
      ) => Promise<unknown>;
      if (driver === 'postgres') {
        const {
          createPostgresGoogleCalendarConnectionRepository,
          assertPostgresInstallationOwner,
        } = await import('@assistant/db');
        const db = getDb();
        owner = await assertPostgresInstallationOwner(db);
        repository = createPostgresGoogleCalendarConnectionRepository(db);
        seedStoredChoices = (settings) => db.$client`
          insert into google_household_calendar_choices (agent_id, settings)
          values (${owner}, ${JSON.stringify(settings)}::jsonb)
          on conflict (agent_id) do update set settings = excluded.settings
        `;
      } else {
        const store = getFirestoreInstallationStore();
        cleanup = async () => {
          await store.db.recursiveDelete(store.root);
          await store.db.terminate();
        };
        repository = createFirestoreGoogleCalendarConnectionRepository(store);
        seedStoredChoices = (settings) =>
          store.doc('googleHouseholdCalendarChoices', owner).set({ agentId: owner, settings });
      }
      const { encryptStoredCredential } = await import('@assistant/core/mcp-secrets');
      const connectionId = randomUUID();
      const stateHash = 'a'.repeat(64);
      const now = new Date();
      await repository.begin(owner, {
        id: connectionId,
        stateHash,
        nonce: 'synthetic',
        verifierEncrypted: 'opaque',
        expiresAt: new Date(+now + 60_000).toISOString(),
        outcome: 'pending',
      });
      const claimed = await repository.consume(owner, connectionId, stateHash, now);
      expect(claimed).not.toBeNull();
      if (!claimed) throw new Error('Unable to seed the synthetic connection');
      expect(
        await repository.finish(
          owner,
          connectionId,
          claimed.revision,
          'connected',
          {
            id: connectionId,
            credentialVersion: 0,
            refreshLease: null,
            status: 'connected',
            account: { subject: 'personal-fixture', email: 'personal@example.test' },
            refreshTokenEncrypted: encryptStoredCredential('synthetic-refresh'),
            accessTokenEncrypted: encryptStoredCredential(calendarAccessToken),
            scopes: ['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE],
            connectedAt: now.toISOString(),
            accessTokenExpiresAt: new Date(+now + 3600_000).toISOString(),
          },
          now,
        ),
      ).toBe(true);

      const family = 'family@example.test';
      const work = 'work@example.test';
      const other = 'other@example.test';
      const purposeSources = [
        {
          id: 'school@example.test',
          summary: 'Oak School',
          purpose: 'school',
          title: 'Science fair',
        },
        {
          id: 'activity@example.test',
          summary: 'Community club',
          purpose: 'activity',
          title: 'Practice',
        },
        {
          id: 'holidays@example.test',
          summary: 'Holiday calendar',
          purpose: 'holidays',
          title: 'Local holiday',
        },
      ] as const;
      let extraRoster = false;
      const providerCalls: string[] = [];
      let rosterMode: 'ready' | 'truncated' | 'unavailable' = 'ready';
      let duringFamilyRead: (() => Promise<unknown>) | undefined;
      vi.stubGlobal('fetch', async (raw: string, init: RequestInit) => {
        const url = new URL(raw);
        if (url.href === 'https://oauth2.googleapis.com/token') {
          expect(String(init.body)).toContain('grant_type=refresh_token');
          return Response.json({
            access_token: calendarAccessToken,
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
        expect(url.origin).toBe('https://www.googleapis.com');
        expect(new Headers(init.headers).get('authorization')).toBe(
          `Bearer ${calendarAccessToken}`,
        );
        if (url.pathname.endsWith('/calendarList')) {
          if (url.searchParams.get('maxResults') === '1') {
            return rosterMode === 'unavailable'
              ? Response.json({ error: 'fixture' }, { status: 403 })
              : Response.json({ kind: 'calendar#calendarList' });
          }
          providerCalls.push('roster');
          expect(url.searchParams.get('minAccessRole')).toBe('freeBusyReader');
          if (rosterMode === 'unavailable')
            return Response.json({ error: 'fixture' }, { status: 403 });
          return Response.json({
            items: [
              {
                id: family,
                summary: 'Family',
                accessRole: 'owner',
                dataOwner: 'personal@example.test',
              },
              { id: work, summary: 'Work', accessRole: 'reader' },
              {
                id: other,
                summary: 'Other',
                accessRole: 'owner',
                dataOwner: 'different-owner@example.test',
              },
              ...(extraRoster
                ? purposeSources.map(({ id, summary }) => ({
                    id,
                    summary,
                    accessRole: 'owner',
                    dataOwner: 'personal@example.test',
                  }))
                : []),
            ],
            ...(rosterMode === 'truncated' ? { nextPageToken: 'fixture-page' } : {}),
          });
        }
        if (url.pathname.endsWith('/freeBusy')) {
          providerCalls.push(
            'busy:' +
              JSON.parse(String(init.body))
                .items.map(({ id }: { id: string }) => id)
                .join(','),
          );
          return Response.json({
            calendars: {
              [work]: {
                busy: [
                  {
                    start: '2026-11-19T20:00:00Z',
                    end: '2026-11-19T21:00:00Z',
                    summary: 'Private work title',
                  },
                ],
              },
            },
          });
        }
        const id = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
        providerCalls.push(`events:${id}`);
        await duringFamilyRead?.();
        return Response.json({
          items: [
            {
              id: 'fixture-event',
              summary:
                purposeSources.find((source) => source.id === id)?.title ??
                (id === family ? 'Family appointment' : 'Excluded title'),
              start: { dateTime: '2026-11-19T18:00:00Z' },
              end: { dateTime: '2026-11-19T19:00:00Z' },
            },
          ],
        });
      });

      expect((await GET(request('', undefined, false))).status).toBe(401);
      expect((await PUT(request('', { connectionId, choices: [] }, false))).status).toBe(401);
      expect(providerCalls).toEqual([]);
      expect(await (await GET(request())).json()).toMatchObject({
        connectionId,
        revision: null,
        state: 'ready',
        remaining: 3,
      });
      const choices = [
        { id: family, purpose: 'household' },
        { id: work, purpose: 'work_free_busy' },
      ];
      const saved = await PUT(request('', { connectionId, choices }));
      expect(saved.status).toBe(200);
      const { revision } = await saved.json();
      const reopened = await (await GET(request())).json();
      expect(reopened).toMatchObject({
        state: 'ready',
        revision,
        remaining: 1,
        calendars: [
          { id: family, purpose: 'household' },
          { id: work, purpose: 'work_free_busy' },
          { id: other, purpose: null },
        ],
      });

      function window(currentRevision: string) {
        return (
          '?' +
          new URLSearchParams({
            connectionId,
            revision: currentRevision,
            timeMin: '2026-11-19T08:00:00Z',
            timeMax: '2026-11-20T08:00:00Z',
          })
        );
      }
      async function verifyPreview(currentRevision: string) {
        providerCalls.length = 0;
        const result = await (await GET(request(window(currentRevision)))).json();
        expect(result).toMatchObject({
          complete: true,
          rows: [
            { calendar: 'Family', title: 'Family appointment' },
            { calendar: 'Work', title: 'Busy', start: '2026-11-19T20:00:00.000Z' },
          ],
        });
        expect(JSON.stringify(result)).not.toContain('Private work title');
        expect(providerCalls).toEqual(['roster', `events:${family}`, `busy:${work}`]);
      }

      await verifyPreview(revision);
      expect(
        (
          await PUT(
            request('', {
              connectionId,
              revision,
              choices: [...choices, { id: other, purpose: 'household' }],
            }),
          )
        ).status,
      ).toBe(409);
      const withIgnore = [...choices, { id: other, purpose: 'ignore' }];
      const ignored = await (
        await PUT(request('', { connectionId, revision, choices: withIgnore }))
      ).json();
      expect(ignored).toMatchObject({ remaining: 0 });
      expect(ignored.revision).not.toBe(revision);
      expect(await (await GET(request())).json()).toMatchObject({
        remaining: 0,
        calendars: [
          { id: family, purpose: 'household' },
          { id: work, purpose: 'work_free_busy' },
          { id: other, purpose: 'ignore' },
        ],
      });
      expect((await PUT(request('', { connectionId, revision, choices }))).status).toBe(409);
      await verifyPreview(ignored.revision);

      rosterMode = 'truncated';
      expect(await (await GET(request())).json()).toMatchObject({
        state: 'incomplete',
        remaining: null,
      });
      providerCalls.length = 0;
      expect(await (await GET(request(window(ignored.revision)))).json()).toEqual({
        complete: false,
        rows: [],
      });
      expect(
        (await PUT(request('', { connectionId, revision: ignored.revision, choices }))).status,
      ).toBe(503);
      expect(providerCalls).toEqual(['roster', 'roster']);
      rosterMode = 'unavailable';
      expect((await GET(request())).status).toBe(503);
      expect((await GET(request(window(ignored.revision)))).status).toBe(503);
      rosterMode = 'ready';
      expect(await (await GET(request())).json()).toMatchObject({
        remaining: 0,
        revision: ignored.revision,
      });

      duringFamilyRead = () =>
        repository.saveHousehold(owner, connectionId, ignored.revision, {
          revision: randomUUID(),
          choices: [{ id: family, purpose: 'ignore' }],
        });
      providerCalls.length = 0;
      expect((await GET(request(window(ignored.revision)))).status).toBe(409);
      expect(providerCalls).toEqual(['roster', `events:${family}`]);
      duringFamilyRead = undefined;
      extraRoster = true;
      const extendedSettings = {
        revision: randomUUID(),
        connectionId,
        choices: [...withIgnore, ...purposeSources.map(({ id, purpose }) => ({ id, purpose }))],
      };
      await seedStoredChoices(extendedSettings);
      const bridgeSetup = await GET(request());
      expect(bridgeSetup.status).toBe(200);
      const bridgeView = await bridgeSetup.json();
      expect(bridgeView).toMatchObject({
        state: 'incomplete',
        remaining: null,
        revision: extendedSettings.revision,
      });
      for (const { id } of purposeSources)
        expect(bridgeView.calendars).toContainEqual(expect.objectContaining({ id, purpose: null }));
      providerCalls.length = 0;
      const bridgePreview = await (await GET(request(window(extendedSettings.revision)))).json();
      expect(bridgePreview).toMatchObject({
        complete: false,
        rows: [
          { calendar: 'Family', title: 'Family appointment' },
          { calendar: 'Work', title: 'Busy' },
        ],
      });
      expect(providerCalls).toEqual(['roster', `events:${family}`, `busy:${work}`]);
      expect(
        (await PUT(request('', { connectionId, revision: extendedSettings.revision, choices: [] })))
          .status,
      ).toBe(409);
      expect((await repository.get(owner))?.household).toEqual({
        revision: extendedSettings.revision,
        choices: extendedSettings.choices,
      });
      await repository.disconnect(owner);
      expect((await repository.get(owner))?.household).toBeUndefined();
      expect((await GET(request())).status).toBe(503);
    },
    30_000,
  );
});
