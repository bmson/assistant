import { readPhoneCalendars, savePhoneCalendars } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore phone calendar snapshots', () => {
  let store: InstallationStore;
  const now = new Date('2026-10-19T12:00:00Z');
  beforeEach(() => {
    store = emulatorStore(() => now);
  });
  afterEach(async () => disposeStore(store));

  it('stores device events, scopes reads to the owner, and clears event details on revocation', async () => {
    const cache = new FirestoreToolExecutionRepository(store);
    const legacyCache = {
      cacheGet: cache.cacheGet.bind(cache),
      cachePut: cache.cachePut.bind(cache),
    };
    const input = {
      timeMin: '2026-10-01T00:00:00Z',
      timeMax: '2027-01-01T00:00:00Z',
      timeZone: 'America/Los_Angeles',
      calendars: [{ id: 'work', name: 'Work' }],
      events: [
        {
          eventId: 'device-event',
          calendarId: 'work',
          iCalUID: 'shared-invitation',
          summary: 'Team planning',
          location: 'Office',
          start: '2026-10-19T16:00:00Z',
          end: '2026-10-19T17:00:00Z',
          allDay: false,
          blocksTime: true,
          ownerResponse: 'accepted',
        },
      ],
    };
    await savePhoneCalendars(legacyCache, 'owner', input, now);
    expect(await readPhoneCalendars(cache, 'owner')).toBeNull();
    expect(await readPhoneCalendars(legacyCache, 'owner')).toEqual({
      ...input,
      syncedAt: now.toISOString(),
    });
    expect(await readPhoneCalendars(legacyCache, 'other-owner')).toBeNull();
    await savePhoneCalendars(legacyCache, 'owner', null, now);
    expect(await readPhoneCalendars(legacyCache, 'owner')).toBeNull();
    const document = await store.doc('toolCache', 'phone-calendars:v1:owner').get();
    expect(document.get('result')).toEqual({ disconnected: true });
    await savePhoneCalendars(legacyCache, 'owner', input, now);
    expect(await readPhoneCalendars(legacyCache, 'owner')).toEqual({
      ...input,
      syncedAt: now.toISOString(),
    });
  });
});
