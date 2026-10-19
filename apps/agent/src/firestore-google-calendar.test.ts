import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { calendarModule, installModules } from '@assistant/modules';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, describe, expect, it } from 'vitest';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore Google Calendar module', () => {
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: `calendar-${randomUUID()}`,
  });

  afterEach(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  it('installs only read tools with PostgreSQL access unavailable', async () => {
    await store.doc('agents', randomUUID()).set({ name: 'Firestore owner' });
    const registry = new ToolRegistry();
    const context = {
      config: loadConfig({
        ASSISTANT_MODULES: 'calendar',
        GOOGLE_OAUTH_CLIENT_ID: 'test-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
        BOT_GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
      }),
      // Any attempt to use the SQL dependency makes this portable module fail.
      db: new Proxy(
        {},
        {
          get: () => {
            throw new Error('calendar module accessed PostgreSQL');
          },
        },
      ),
      registry,
    } as never;

    const installed = installModules([calendarModule], context);

    expect(installed.installed).toEqual(['calendar']);
    expect(
      registry
        .all()
        .map(({ tool }) => tool.name)
        .sort(),
    ).toEqual(['calendar.availability', 'calendar.list_calendars', 'calendar.list_events']);
  });
});
