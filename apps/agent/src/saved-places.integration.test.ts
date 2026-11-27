import { randomUUID } from 'node:crypto';
import { forgetLongTermMemoryWithRepository } from '@assistant/application/profile';
import { updateSavedPlace } from '@assistant/application/saved-places';
import {
  agents,
  assertPostgresInstallationOwner,
  createPostgresHomeWeatherRepository,
  createPostgresPrivacyErasureRepository,
  createPostgresSavedPlacesRepository,
  savedPlaces,
} from '@assistant/db';
import {
  createFirestoreSavedPlacesRepository,
  FirestoreOwnerContextRepository,
  FirestorePrivacyErasureRepository,
} from '@assistant/firestore';
import type {
  SavedPlaceDetails,
  SavedPlacesRepository,
  SavedPlaceWrite,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { exportWorkspaceSnapshot } from '../../../packages/db/src/workspace-migration.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { importWorkspaceBundle } from '../../../packages/firestore/src/workspace-migration.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const school = {
  category: 'school',
  label: 'Harbor School',
  address: '1 Example Lane, Juniper Bay, EX 10001, Exampleland',
} satisfies SavedPlaceDetails;
const work = {
  category: 'work',
  label: 'Workshop',
  address: '2 Example Lane, Juniper Bay, EX 10001, Exampleland',
} satisfies SavedPlaceDetails;
const firstVenue = {
  category: 'venue',
  label: 'Community Hall',
  address: '3 Example Lane, Juniper Bay, EX 10001, Exampleland',
} satisfies SavedPlaceDetails;
const secondVenue = {
  ...firstVenue,
  address: '4 Example Lane, Juniper Bay, EX 10001, Exampleland',
};
const home = { city: 'Juniper Bay', revision: randomUUID(), enabled: true, lat: 38.5, lng: -120.5 };

function create(details: SavedPlaceDetails, generation: string | null = null): SavedPlaceWrite {
  return { id: randomUUID(), revision: randomUUID(), expectedRevision: null, details, generation };
}

function change(previous: SavedPlaceWrite, details: SavedPlaceDetails | null): SavedPlaceWrite {
  return { ...previous, expectedRevision: previous.revision, revision: randomUUID(), details };
}

interface Fixture {
  agentId: string;
  settings(): SavedPlacesRepository;
  foreign(agentId: string): Promise<() => Promise<unknown>>;
  saveHome(): Promise<unknown>;
  readHome(): Promise<unknown>;
  erase(): Promise<unknown>;
  rawPlaces(): Promise<unknown[]>;
  close(): Promise<void>;
}

function owner(id: string) {
  return { id, name: 'Synthetic owner', email: `${id}@example.test`, workspacePrefix: 'synthetic' };
}

async function postgresFixture(): Promise<Fixture> {
  const { db, close } = await createIsolatedTestDatabase();
  const agentId = await assertPostgresInstallationOwner(db);
  const weather = createPostgresHomeWeatherRepository(db);
  return {
    agentId,
    close,
    settings: () => createPostgresSavedPlacesRepository(db),
    async foreign(id) {
      await db.insert(agents).values(owner(id));
      return async () => db.delete(agents).where(eq(agents.id, id));
    },
    saveHome: () => weather.setHomeWeather(agentId, home),
    readHome: () => weather.getHomeWeather(agentId),
    erase: () => forgetLongTermMemoryWithRepository(createPostgresPrivacyErasureRepository(db)),
    rawPlaces: () => db.select().from(savedPlaces).where(eq(savedPlaces.agentId, agentId)),
  };
}

async function firestoreFixture(): Promise<Fixture> {
  const store = emulatorStore();
  const agentId = randomUUID();
  const weather = new FirestoreOwnerContextRepository(store);
  await store.doc('agents', agentId).set(owner(agentId));
  return {
    agentId,
    close: () => disposeStore(store),
    settings: () => createFirestoreSavedPlacesRepository(store),
    async foreign(id) {
      const ref = store.doc('agents', id);
      await ref.set(owner(id));
      return async () => ref.delete();
    },
    saveHome: () => weather.setHomeWeather(agentId, home),
    readHome: () => weather.getHomeWeather(agentId),
    erase: () =>
      forgetLongTermMemoryWithRepository(new FirestorePrivacyErasureRepository(store, agentId)),
    rawPlaces: async () =>
      (await store.collection('savedPlaces').where('agentId', '==', agentId).get()).docs,
  };
}

describe.each([
  { driver: 'PostgreSQL', open: postgresFixture, skip: false },
  { driver: 'Firestore', open: firestoreFixture, skip: !process.env.FIRESTORE_EMULATOR_HOST },
])('$driver Saved places', ({ open, skip }) => {
  it.skipIf(skip)(
    'reopens, edits and removes exact owner-confirmed records and fences stale commands',
    async () => {
      const store = await open();
      const { agentId } = store;
      try {
        const save = (command: SavedPlaceWrite, ownerId = agentId) =>
          updateSavedPlace(store.settings(), ownerId, command);
        expect(await store.settings().list(agentId)).toEqual({ generation: null, places: [] });
        expect(await store.saveHome()).toBe(true);
        const venue = create(firstVenue);
        const other = create(secondVenue);
        for (const command of [create(school), create(work), venue, other])
          expect(await save(command)).toHaveProperty('snapshot');

        expect(await save(venue)).toHaveProperty('snapshot'); // same request after a lost response
        expect((await store.settings().list(agentId)).places).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ details: school }),
            expect.objectContaining({ details: work }),
            { id: venue.id, revision: venue.revision, details: firstVenue },
            { id: other.id, revision: other.revision, details: secondVenue },
          ]),
        );
        const edit = change(venue, {
          ...firstVenue,
          address: '5 Example Lane, Juniper Bay, EX 10001, Exampleland',
        });
        const competingEdit = change(venue, { ...firstVenue, label: 'Stale label' });
        expect(await save(edit)).toHaveProperty('snapshot');
        expect(await save(competingEdit)).toHaveProperty('error');
        expect(await store.settings().read(agentId, edit.id, null)).toEqual({
          id: venue.id,
          agentId,
          revision: edit.revision,
          details: edit.details,
        });

        const foreignId = randomUUID();
        const dropOtherOwner = await store.foreign(foreignId);
        try {
          expect(await store.settings().read(foreignId, venue.id, null)).toBeNull();
          expect(await store.settings().list(foreignId)).toEqual({ generation: null, places: [] });
          expect(await save(change(edit, null), foreignId)).toHaveProperty('error');
          expect(await store.settings().read(agentId, edit.id, null)).toMatchObject({
            revision: edit.revision,
          });
        } finally {
          await dropOtherOwner();
        }

        const removal = change(edit, null);
        expect(await save(removal)).toHaveProperty('snapshot');
        expect(await save(removal)).toHaveProperty('snapshot');
        expect(await save(venue)).toHaveProperty('error');
        expect(await save(edit)).toHaveProperty('error');
        expect((await store.settings().list(agentId)).places.map(({ id }) => id)).not.toContain(
          venue.id,
        );
        expect(await store.settings().read(agentId, other.id, null)).toMatchObject({
          details: secondVenue,
        });
        expect(await store.settings().read(agentId, removal.id, null)).toMatchObject({
          details: null,
          revision: removal.revision,
        });
        expect(await store.readHome()).toEqual(home);

        const delayed = create(school);
        await store.erase();
        expect(await store.rawPlaces()).toEqual([]);
        expect(await store.readHome()).toBeNull();
        const erased = await store.settings().list(agentId);
        expect(erased.places).toEqual([]);
        expect(erased.generation).toBeTruthy();
        expect(await save(delayed)).toHaveProperty('error');
        expect(await save(create(work, erased.generation))).toHaveProperty('snapshot');
      } finally {
        await store.close();
      }
    },
    55_000,
  );
});

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'transfers Home, disambiguated addresses and content-free removals',
  async () => {
    const source = await createIsolatedTestDatabase();
    const destination = emulatorStore();
    try {
      const ownerId = await assertPostgresInstallationOwner(source.db);
      const pg = createPostgresSavedPlacesRepository(source.db);
      const weather = createPostgresHomeWeatherRepository(source.db);
      const fs = createFirestoreSavedPlacesRepository(destination);
      const venue = create(firstVenue);
      const duplicate = create(secondVenue);
      const removed = create({
        ...firstVenue,
        address: '9 Example Lane, Juniper Bay, EX 10001, Exampleland',
      });
      await weather.setHomeWeather(ownerId, home);
      for (const command of [venue, duplicate, removed])
        expect(await updateSavedPlace(pg, ownerId, command)).toHaveProperty('snapshot');
      expect(await updateSavedPlace(pg, ownerId, change(removed, null))).toHaveProperty('snapshot');
      const target = {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: destination.installationId,
      };
      const bundle = await exportWorkspaceSnapshot({
        databaseUrl: source.databaseUrl,
        agentId: ownerId,
        target,
        tables: ['agents', 'saved_places'],
      });
      const removedRecord = bundle.records.find(({ id }) => id === removed.id);
      expect(removedRecord?.data.details).toBeNull();
      expect(JSON.stringify(bundle)).not.toContain(removed.details?.address);
      await importWorkspaceBundle(destination, bundle, {
        sourceAgentId: ownerId,
        target,
        mode: 'write',
      });
      expect((await fs.list(ownerId)).places).toEqual(
        expect.arrayContaining((await pg.list(ownerId)).places),
      );
      expect((await fs.list(ownerId)).places).toHaveLength(2);
      expect(
        await new FirestoreOwnerContextRepository(destination).getHomeWeather(ownerId),
      ).toEqual(home);
      expect(await updateSavedPlace(fs, ownerId, removed)).toHaveProperty('error');
    } finally {
      await disposeStore(destination);
      await source.close();
    }
  },
  55_000,
);
