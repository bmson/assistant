import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createFirestoreGoogleCalendarConnectionRepository } from '@assistant/firestore';
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  type GoogleCalendarConnectionRepository,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, PUT } from '@/app/api/mobile/v1/connections/google-calendar/household/route';
import { getDb, getFirestoreInstallationStore } from './server';

vi.mock('@/auth', () => ({ isAuthed: vi.fn() }));

const base = 'https://assistant.example.test/api/mobile/v1/connections/google-calendar/household';
const token = 'synthetic-household-phone-bearer';
const calendarAccessToken = 'synthetic-personal-calendar-access';
const types = ['postgres', 'firestore'] as const;

function request(path = '', body?: object, authenticated = true, extended = false) {
  return new Request(base + path, {
    method: body ? 'PUT' : 'GET',
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(extended ? { 'x-assistant-household-calendar-version': '2' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const v2 = (path = '', body?: object) => request(path, body, true, true);

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
      vi.stubEnv('GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED', 'false');
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
      if (driver === 'postgres') {
        const {
          createPostgresGoogleCalendarConnectionRepository,
          assertPostgresInstallationOwner,
        } = await import('@assistant/db');
        const db = getDb();
        owner = await assertPostgresInstallationOwner(db);
        repository = createPostgresGoogleCalendarConnectionRepository(db);
      } else {
        const store = getFirestoreInstallationStore();
        cleanup = async () => {
          await store.db.recursiveDelete(store.root);
          await store.db.terminate();
        };
        repository = createFirestoreGoogleCalendarConnectionRepository(store);
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
      let omittedSource: string | undefined;
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
                ? purposeSources
                    .filter(({ id }) => id !== omittedSource)
                    .map(({ id, summary }) => ({
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
          expect(init.method).toBe('POST');
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
      const starting = (await repository.get(owner))?.household?.revision;
      const baseline = await (
        await PUT(v2('', { connectionId, revision: starting, choices: withIgnore }))
      ).json();
      const stored = [...withIgnore];
      let currentRevision = baseline.revision;
      expect(baseline).toMatchObject({ remaining: 3, extendedPurposesAvailable: false });
      await verifyPreview(currentRevision);

      expect(
        (
          await PUT(
            v2('', {
              connectionId,
              revision: currentRevision,
              choices: [
                ...stored,
                { id: purposeSources[0].id, purpose: purposeSources[0].purpose },
              ],
            }),
          )
        ).status,
      ).toBe(409);

      vi.stubEnv('GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED', 'true');
      resetConfigForTest();
      expect(await (await GET(v2())).json()).toMatchObject({
        remaining: 3,
        extendedPurposesAvailable: true,
      });
      expect(
        (
          await PUT(
            request('', {
              connectionId,
              revision: currentRevision,
              choices: [
                ...stored,
                { id: purposeSources[0].id, purpose: purposeSources[0].purpose },
              ],
            }),
          )
        ).status,
      ).toBe(409);
      for (const [index, { id, purpose }] of purposeSources.entries()) {
        expect(
          (
            await PUT(
              v2('', {
                connectionId,
                revision: currentRevision,
                choices: [...choices, { id: other, purpose }],
              }),
            )
          ).status,
        ).toBe(409);
        stored.push({ id, purpose });
        const saved = await PUT(
          v2('', { connectionId, revision: currentRevision, choices: stored }),
        );
        expect(saved.status).toBe(200);
        const next = await saved.json();
        expect(next).toMatchObject({ remaining: 2 - index });
        currentRevision = next.revision;
        const reopened = await (await GET(v2())).json();
        expect(reopened).toMatchObject({ revision: currentRevision, remaining: 2 - index });
        expect(reopened.calendars).toContainEqual(expect.objectContaining({ id, purpose }));
      }

      async function checkExtendedPreview(ids: readonly string[], complete = true) {
        providerCalls.length = 0;
        const preview = await (await GET(v2(window(currentRevision)))).json();
        expect(preview.complete).toBe(complete);
        const expectedSources = purposeSources.filter(({ id }) => ids.includes(id));
        expect(preview.rows).toMatchObject([
          { calendar: 'Family', title: 'Family appointment' },
          ...expectedSources.map(({ summary, title }) => ({
            calendar: summary,
            title,
            start: '2026-11-19T18:00:00.000Z',
            end: '2026-11-19T19:00:00.000Z',
          })),
          { calendar: 'Work', title: 'Busy', start: '2026-11-19T20:00:00.000Z' },
        ]);
        expect(JSON.stringify(preview)).not.toContain('Private work title');
        expect(providerCalls).toEqual([
          'roster',
          `events:${family}`,
          ...expectedSources.map(({ id }) => `events:${id}`),
          `busy:${work}`,
        ]);
      }

      await checkExtendedPreview(purposeSources.map(({ id }) => id));
      const preserved = (await repository.get(owner))?.household;
      expect(preserved).toEqual({ revision: currentRevision, choices: stored });
      const legacySetup = await (await GET(request())).json();
      expect(legacySetup).toMatchObject({
        state: 'incomplete',
        remaining: null,
        extendedPurposesAvailable: false,
      });
      for (const { id } of purposeSources)
        expect(legacySetup.calendars).toContainEqual(
          expect.objectContaining({ id, purpose: null }),
        );
      providerCalls.length = 0;
      const legacyPreview = await (await GET(request(window(currentRevision)))).json();
      expect(legacyPreview).toMatchObject({
        complete: false,
        rows: [
          { calendar: 'Family', title: 'Family appointment' },
          { calendar: 'Work', title: 'Busy' },
        ],
      });
      expect(providerCalls).toEqual(['roster', `events:${family}`, `busy:${work}`]);
      expect(
        (await PUT(request('', { connectionId, revision: currentRevision, choices: [] }))).status,
      ).toBe(409);
      expect(
        (await PUT(v2('', { connectionId, revision: baseline.revision, choices: [] }))).status,
      ).toBe(409);
      expect(
        (await PUT(v2('', { connectionId: randomUUID(), revision: currentRevision, choices: [] })))
          .status,
      ).toBe(409);

      rosterMode = 'unavailable';
      expect((await GET(v2())).status).toBe(503);
      expect((await repository.get(owner))?.household).toEqual(preserved);
      rosterMode = 'ready';
      omittedSource = purposeSources[0].id;
      expect(await (await GET(v2())).json()).toMatchObject({
        state: 'incomplete',
        remaining: null,
        revision: currentRevision,
      });
      await checkExtendedPreview(
        purposeSources.slice(1).map(({ id }) => id),
        false,
      );
      const partialSave = await PUT(
        v2('', {
          connectionId,
          revision: currentRevision,
          choices: stored.filter(({ id }) => id !== omittedSource),
        }),
      );
      expect(partialSave.status).toBe(200);
      currentRevision = (await partialSave.json()).revision;
      expect((await repository.get(owner))?.household?.choices).toEqual(
        expect.arrayContaining(stored),
      );
      omittedSource = undefined;

      vi.stubEnv('GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED', 'false');
      resetConfigForTest();
      for (const [index, { id }] of purposeSources.entries()) {
        stored[withIgnore.length + index] = { id, purpose: 'ignore' };
        const result = await PUT(
          v2('', { connectionId, revision: currentRevision, choices: stored }),
        );
        expect(result.status).toBe(200);
        currentRevision = (await result.json()).revision;
        const reopened = await (await GET(v2())).json();
        expect(reopened.calendars).toContainEqual(
          expect.objectContaining({ id, purpose: 'ignore' }),
        );
        await checkExtendedPreview(purposeSources.slice(index + 1).map(({ id }) => id));
      }

      expect(await (await GET(request())).json()).toMatchObject({ remaining: 0 });
      await repository.disconnect(owner);
      expect((await repository.get(owner))?.household).toBeUndefined();
      expect((await GET(request())).status).toBe(503);
    },
    30_000,
  );
});
