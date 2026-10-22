import {
  type PhoneCalendarSharingState,
  phoneCalendarCacheKey,
  phoneCalendarCoverage,
  readPhoneCalendars,
  savePhoneCalendars,
  transitionPhoneCalendarSharing,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { FirestorePrivacyExportRepository } from './privacy-export.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';

const ownerId = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-22T18:00:00.000Z');
const legacy = {
  timeMin: now.toISOString(),
  timeMax: '2026-10-23T18:00:00.000Z',
  timeZone: 'UTC',
  calendars: [{ id: 'work', name: 'Work' }],
  events: [],
};
const enabled: PhoneCalendarSharingState = {
  version: 1,
  ownerId,
  publisherId: 'private-publisher',
  generation: 4,
  enabled: true,
  consentVersion: 1,
  calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
  updatedAt: now.toISOString(),
  capturedAt: now.toISOString(),
  receivedAt: now.toISOString(),
  timeMin: legacy.timeMin,
  timeMax: legacy.timeMax,
  complete: true,
};
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore rollback sharing bridge', () => {
  let store: InstallationStore;
  beforeEach(async () => {
    store = emulatorStore(() => now);
    await store.doc('agents', ownerId).set({ id: ownerId, name: 'Owner' });
  });
  afterEach(async () => disposeStore(store));
  it('keeps absent-protocol legacy reads, but fences a replaced publisher state and exports only consent metadata', async () => {
    const cache = new FirestoreToolExecutionRepository(store);
    await expect(savePhoneCalendars(cache, ownerId, legacy, now)).rejects.toThrow(
      'Legacy calendar writes',
    );
    await savePhoneCalendars(
      { cacheGet: cache.cacheGet.bind(cache), cachePut: cache.cachePut.bind(cache) },
      ownerId,
      legacy,
      now,
    );
    expect((await readPhoneCalendars(cache, ownerId))?.calendars).toEqual(legacy.calendars);
    await store.doc('phoneCalendarSharing', ownerId).set(
      encodeRecord({
        id: ownerId,
        agentId: ownerId,
        state: { ...enabled, publisherId: 'replacement-publisher' },
        updatedAt: now,
      }),
    );
    const read = await readPhoneCalendars(cache, ownerId);
    expect(read).toMatchObject({ events: [], complete: false, calendars: [{ id: 'work' }] });
    if (!read) throw new Error('Missing selected-source coverage');
    expect(phoneCalendarCoverage(read, legacy.timeMin, legacy.timeMax, now).complete).toBe(false);
    await expect(savePhoneCalendars(cache, ownerId, legacy, now)).rejects.toThrow(
      'Legacy calendar writes',
    );
    await expect(savePhoneCalendars(cache, ownerId, null, now)).rejects.toThrow(
      'Legacy calendar writes',
    );
    const exported = (await new FirestorePrivacyExportRepository(store).exportOwnerData())
      .phoneCalendarSharing;
    expect(exported?.state?.calendars).toEqual(enabled.calendars);
    expect(JSON.stringify(exported)).not.toMatch(/replacement-publisher|private-publisher|events/);
    await new FirestorePrivacyErasureRepository(store).erase();
    await new FirestorePrivacyErasureRepository(store).complete();
    const record = decodeRecord<{ state: PhoneCalendarSharingState }>(
      (await store.doc('phoneCalendarSharing', ownerId).get()).data(),
    );
    expect(record.state).toMatchObject({
      generation: 5,
      publisherId: null,
      enabled: false,
      calendars: [],
    });
    expect((await store.doc('toolCache', phoneCalendarCacheKey(ownerId)).get()).exists).toBe(false);
    expect(await readPhoneCalendars(cache, ownerId)).toBeNull();
    expect(
      transitionPhoneCalendarSharing(ownerId, record.state, {
        command: 'enable',
        publisherId: 'private-publisher',
        expectedGeneration: 0,
        consentVersion: 1,
        mutationId: 'delayed-initial-enable',
        calendars: [],
      }).result.ok,
    ).toBe(false);
    await new FirestorePrivacyErasureRepository(store).erase();
    await new FirestorePrivacyErasureRepository(store).complete();
    expect((await cache.phoneCalendarCompatibility.read(ownerId)).state?.generation).toBe(5);
  });
  it('creates an opaque erasure tombstone even before an initial publisher consent arrives', async () => {
    await new FirestorePrivacyErasureRepository(store).erase();
    await new FirestorePrivacyErasureRepository(store).complete();
    const state = (
      await new FirestoreToolExecutionRepository(store).phoneCalendarCompatibility.read(ownerId)
    ).state;
    expect(state).toMatchObject({
      generation: 1,
      enabled: false,
      calendars: [],
      publisherId: null,
    });
    expect(JSON.stringify(state)).not.toContain('Work');
  });
  it('rejects a state document bound to another owner', async () => {
    await store
      .doc('phoneCalendarSharing', ownerId)
      .set({ id: ownerId, agentId: 'foreign', state: enabled });
    await expect(
      readPhoneCalendars(new FirestoreToolExecutionRepository(store), ownerId),
    ).rejects.toThrow('ownership or state');
  });
});
