import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner, authMode: 'google' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'assistant.test', 'x-forwarded-proto': 'https' }),
}));

const emulator = /^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Home weather in owner Settings', () => {
  it('checks owner authority, saves the explicit Home choice and reads it after reopening', async () => {
    const installationId = `home-weather-${randomUUID()}`;
    const agentId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    try {
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Fixture assistant',
        email: 'owner@example.test',
        calendarId: null,
        phoneE164: null,
        avatarUrl: null,
        signature: '',
        timezone: 'UTC',
        locale: 'en-US',
        workspacePrefix: 'synthetic',
        browserProfilePath: null,
        credentialRefs: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const page = await import('./page.js');
      const { updateHomeWeather } = await import('./home-weather-action.js');
      const state = { message: '', error: false };
      const before = renderToStaticMarkup(await page.default());
      expect(before).toContain('Home city');
      expect(before).not.toMatch(/<input[^>]+name="enabled"[^>]*checked=""/);

      const weatherProvider = vi.fn(async (input: string | URL) => {
        expect(String(input)).toMatch(/^https:\/\/geocoding-api\.open-meteo\.com\//);
        return Response.json({
          results: [{ name: 'Juniper Bay', latitude: 38.5, longitude: -120.5 }],
        });
      });
      vi.stubGlobal('fetch', weatherProvider);
      const form = new FormData();
      form.set('city', 'Juniper Bay');
      form.set('enabled', 'on');
      auth.owner.mockRejectedValueOnce(new Error('Unauthenticated fixture'));
      await expect(updateHomeWeather(state, form)).rejects.toThrow('Unauthenticated fixture');
      expect(weatherProvider).not.toHaveBeenCalled();

      expect(await updateHomeWeather(state, form)).toEqual({
        message: 'Home weather settings saved.',
        error: false,
      });
      const reopened = renderToStaticMarkup(await page.default());
      expect(reopened).toContain('value="Juniper Bay"');
      expect(reopened).toMatch(/<input[^>]+name="enabled"[^>]*checked=""/);
      expect(reopened).not.toContain('-120.5');
      expect((await store.doc('agents', agentId).get()).get('homeWeather.enabled')).toBe(true);

      const { savePlace } = await import('./saved-places-action.js');
      const school = {
        id: randomUUID(),
        revision: randomUUID(),
        expectedRevision: null,
        generation: null,
        details: {
          category: 'school',
          label: 'Harbor School',
          address: '1 Example Lane, Juniper Bay, Exampleland',
        },
      };
      auth.owner.mockRejectedValueOnce(new Error('Unauthenticated fixture'));
      await expect(savePlace(school)).rejects.toThrow('Unauthenticated fixture');
      expect(await savePlace({ ...school, agentId: randomUUID() })).toHaveProperty('error');
      expect(await savePlace(school)).toHaveProperty('snapshot');
      const withSchool = renderToStaticMarkup(await page.default());
      expect(withSchool).toContain('Saved places');
      expect(withSchool).toContain('Harbor School');
      expect(withSchool).toContain('1 Example Lane, Juniper Bay, Exampleland');
      expect(withSchool).toContain('value="Juniper Bay"');
      expect(weatherProvider).toHaveBeenCalledTimes(1);

      form.delete('enabled');
      expect((await updateHomeWeather(state, form)).error).toBe(false);
      const disabled = renderToStaticMarkup(await page.default());
      expect(disabled).toContain('value="Juniper Bay"');
      expect(disabled).not.toMatch(/<input[^>]+name="enabled"[^>]*checked=""/);
      expect(weatherProvider).toHaveBeenCalledTimes(1);

      form.set('city', '');
      expect(await updateHomeWeather(state, form)).toEqual({
        message: 'Home removed.',
        error: false,
      });
      expect((await store.doc('agents', agentId).get()).get('homeWeather')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      resetConfigForTest();
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
    }
  }, 25_000);
});
