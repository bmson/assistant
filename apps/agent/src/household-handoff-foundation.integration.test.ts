import { randomUUID } from 'node:crypto';
import { createHouseholdHandoffSettings } from '@assistant/application/household-handoff';
import { resetConfigForTest } from '@assistant/config';
import {
  agents,
  assertPostgresInstallationOwner,
  createPostgresHouseholdHandoffRepository,
  createPostgresPrivacyErasureRepository,
} from '@assistant/db';
import { exportWorkspaceSnapshot } from '@assistant/db/workspace-migration';
import {
  createFirestoreHouseholdHandoffRepository,
  FirestorePrivacyErasureRepository,
} from '@assistant/firestore';
import { importWorkspaceBundle } from '@assistant/firestore/workspace-migration';
import {
  checksumV3,
  type HouseholdHandoffRepository,
  migrationBundleChecksum,
  serializeMigrationValueV3,
  validateMigrationReferences,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const localFirestore = /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');
const day = '2030-11-19';
const sealKey = 'b'.repeat(64);
const adultEmail = 'fixture-adult@example.test';
const adultOrigin = '42 Participant Fixture Road';
const settings = {
  connectionId: randomUUID(),
  ownerContactId: 'fixture-owner',
  recipientId: 'fixture-adult',
  recipientEmail: adultEmail,
  recipientPhone: '+12025550101',
  ownerCalendarIds: ['fixture-work@example.test'],
  ownerOrigin: '11 Owner Fixture Lane',
  keeps: {
    calendarId: 'fixture-household',
    eventId: 'clinic',
    subjectId: 'fixture-child-a',
    start: `${day}T22:50:00Z`,
    end: `${day}T23:20:00Z`,
    destination: '100 Fixture Clinic Way',
  },
  currentlyCovers: {
    calendarId: 'fixture-household',
    eventId: 'school',
    subjectId: 'fixture-child-b',
    start: `${day}T23:10:00Z`,
    end: `${day}T23:30:00Z`,
    destination: '200 Fixture School Way',
  },
  availabilityStart: `${day}T22:30:00Z`,
  availabilityEnd: `${day}T23:50:00Z`,
};

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigForTest();
});

function consent(repository: HouseholdHandoffRepository) {
  vi.stubEnv('MCP_ENC_KEY', sealKey);
  resetConfigForTest();
  let identity = { sub: 'fixture-subject', email: adultEmail, email_verified: true, nonce: '' };
  let beforeVerification: (() => Promise<void>) | undefined;
  const fetcher = vi.fn(async (url, request) => {
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(request?.body).toBeInstanceOf(URLSearchParams);
    const form = request?.body as URLSearchParams;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return Response.json({
      id_token: 'fixture-id-token',
      access_token: 'fixture-token-not-persisted',
      token_type: 'Bearer',
    });
  });
  const service = createHouseholdHandoffSettings({
    repository,
    sealKey,
    now: () => new Date(`${day}T15:00:00Z`),
    config: {
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      callbackUrl: 'https://fixture.example.test/api/oauth/google-calendar/callback',
    },
    fetcher,
    verifyIdentity: async (token, audience) => {
      expect(token).toBe('fixture-id-token');
      expect(audience).toBe('fixture-client');
      await beforeVerification?.();
      return identity;
    },
  });
  const linkKey = (owner: string, planId: string) =>
    new URL(service.link(owner, planId)).searchParams.get('invite') ?? '';
  const begin = async (
    owner: string,
    key: string,
    origin: string | null,
    claims: Partial<typeof identity> = {},
  ) => {
    const attempt = await service.begin(owner, key, origin);
    const url = new URL(attempt.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(attempt.cookie).toContain('Secure; HttpOnly; SameSite=Lax');
    identity = {
      sub: 'fixture-subject',
      email: adultEmail,
      email_verified: true,
      nonce: url.searchParams.get('nonce') ?? '',
      ...claims,
    };
    return {
      state: url.searchParams.get('state') ?? '',
      code: 'fixture-code',
      cookieHeader: attempt.cookie.split(';')[0] ?? '',
    };
  };
  return {
    service,
    linkKey,
    begin,
    fetcher,
    pauseVerification: (pause: () => Promise<void>) => {
      beforeVerification = pause;
    },
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function exercise(
  repository: HouseholdHandoffRepository,
  owner: string,
  other: string,
  removeOther: () => Promise<void>,
  erase: () => Promise<unknown>,
  complete: () => Promise<unknown>,
) {
  const { service, linkKey, begin, fetcher, pauseVerification } = consent(repository);
  const saved = await service.save(owner, null, settings);
  const otherPlan = await service.save(other, null, settings);
  if (!saved.plan || !otherPlan.plan) throw new Error('Fixture plans missing');
  const key = linkKey(owner, saved.plan.id);
  await expect(service.begin(other, key, adultOrigin)).rejects.toThrow('sharing link');
  expect(await repository.read(other)).toEqual(otherPlan);
  expect(await repository.read(owner)).toEqual(saved);
  await expect(service.save(owner, null, settings)).rejects.toThrow('plan changed');

  for (const invalidClaims of [
    { email: 'fixture-owner@example.test' },
    { email_verified: false },
    { nonce: 'wrong-fixture-nonce' },
  ]) {
    const request = await begin(owner, key, adultOrigin, invalidClaims);
    await expect(service.finish(request)).rejects.toThrow('adult invited');
    expect(await repository.read(owner)).toEqual(saved);
  }
  const grant = await begin(owner, key, adultOrigin);
  const exchanges = fetcher.mock.calls.length;
  await expect(service.finish({ ...grant, state: 'wrong-state' })).rejects.toThrow('expired');
  expect(fetcher).toHaveBeenCalledTimes(exchanges);
  await expect(service.finish(grant)).resolves.toMatchObject({ active: true });
  const active = await repository.read(owner);
  expect(active?.plan?.sharing).toEqual({
    googleSubject: 'fixture-subject',
    tripOrigin: adultOrigin,
  });
  expect(JSON.stringify(active)).not.toContain('fixture-token-not-persisted');
  await expect(service.finish(grant)).rejects.toThrow('plan changed');
  await expect(service.remove(owner, saved.revision)).rejects.toThrow('plan changed');
  const wrongSubject = await begin(owner, key, null, { sub: 'another-google-subject' });
  await expect(service.finish(wrongSubject)).rejects.toThrow('adult invited');
  await expect(service.finish(await begin(owner, key, null))).resolves.toMatchObject({
    active: false,
  });
  expect((await repository.read(owner))?.plan?.sharing).toBeNull();
  await expect(service.finish(await begin(owner, key, adultOrigin))).resolves.toMatchObject({
    active: true,
  });

  await removeOther();
  const racing = await begin(owner, key, '45 Stale Callback Fixture Road');
  const reached = deferred();
  const release = deferred();
  pauseVerification(async () => {
    reached.resolve();
    await release.promise;
  });
  const callback = service.finish(racing);
  try {
    await Promise.race([
      reached.promise,
      callback.then(() => {
        throw new Error('Callback did not pause');
      }),
    ]);
    await erase();
    await expect(repository.read(owner)).rejects.toThrow(/erasure/i);
    await complete();
    expect(await repository.read(owner)).toBeNull();
  } finally {
    release.resolve();
  }
  await expect(callback).rejects.toThrow('plan changed');
  await expect(service.inspect(owner, key)).rejects.toThrow('sharing link');
  expect(await repository.read(owner)).toBeNull();
}

it('qualifies the dormant PostgreSQL adapter against consent and erasure races', async () => {
  const target = await createIsolatedTestDatabase();
  try {
    const owner = await assertPostgresInstallationOwner(target.db);
    const other = randomUUID();
    await target.db.insert(agents).values({
      id: other,
      name: 'Other fixture',
      email: 'other@example.test',
      workspacePrefix: 'fixture-other',
    });
    const erasure = createPostgresPrivacyErasureRepository(target.db);
    await exercise(
      createPostgresHouseholdHandoffRepository(target.db),
      owner,
      other,
      async () => {
        await target.db.delete(agents).where(eq(agents.id, other));
      },
      () => erasure.erase(),
      () => erasure.complete(),
    );
  } finally {
    await target.close();
  }
});

it.skipIf(!localFirestore)(
  'qualifies the dormant Firestore adapter against consent and erasure races',
  async () => {
    const store = emulatorStore();
    const owner = randomUUID();
    const other = randomUUID();
    try {
      await Promise.all([owner, other].map((id) => store.doc('agents', id).set({ id })));
      const erasure = new FirestorePrivacyErasureRepository(store, owner);
      await exercise(
        createFirestoreHouseholdHandoffRepository(store),
        owner,
        other,
        async () => {
          await store.doc('householdHandoffs', other).delete();
          await store.doc('agents', other).delete();
        },
        () => erasure.erase(),
        () => erasure.complete(),
      );
    } finally {
      await disposeStore(store);
    }
  },
);

it.skipIf(!localFirestore)(
  'keeps plan settings but strips active authority on PostgreSQL export and Firestore import',
  async () => {
    const source = await createIsolatedTestDatabase();
    const destination = emulatorStore();
    try {
      const owner = await assertPostgresInstallationOwner(source.db);
      const pg = createPostgresHouseholdHandoffRepository(source.db);
      const original = consent(pg);
      const saved = await original.service.save(owner, null, settings);
      if (!saved.plan) throw new Error('Fixture plan missing');
      const invite = original.linkKey(owner, saved.plan.id);
      await original.service.finish(await original.begin(owner, invite, adultOrigin));
      const pending = await original.begin(owner, invite, adultOrigin);
      const active = await pg.read(owner);
      expect(active?.plan?.sharing).toMatchObject({ tripOrigin: adultOrigin });
      if (!active?.plan) throw new Error('Fixture grant missing');
      const target = {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: destination.installationId,
      };
      const bundle = await exportWorkspaceSnapshot({
        databaseUrl: source.databaseUrl,
        agentId: owner,
        target,
      });
      const record = bundle.records.find(({ table }) => table === 'household_handoffs');
      expect(record?.data.plan).toMatchObject({ ...settings, sharing: null });
      expect(record?.data.revision).not.toBe(active.revision);
      expect(JSON.stringify(record)).not.toContain(adultOrigin);
      expect(await pg.read(owner)).toEqual(active);

      // Exercise the importer with a valid old snapshot that still carried
      // the active grant. Recalculate checksums exactly as the export does.
      if (!record) throw new Error('Missing exported record');
      const data = {
        agentId: owner,
        revision: active.revision,
        plan: serializeMigrationValueV3(active.plan),
      };
      record.data = data;
      record.checksum = checksumV3(data);
      const summary = bundle.manifest.tables.household_handoffs;
      if (!summary) throw new Error('Missing handoff table summary');
      summary.checksum = checksumV3([record]);
      bundle.manifest.bundleChecksum = migrationBundleChecksum(
        bundle.records,
        bundle.manifest.formatVersion,
        bundle.manifest.coverage.runtimeExclusions,
      );
      expect(() => validateMigrationReferences(bundle.records, randomUUID())).toThrow();
      const options = { sourceAgentId: owner, target };
      const imported = await importWorkspaceBundle(destination, bundle, {
        ...options,
        mode: 'write',
      });
      expect(imported.verified).toBe(true);
      const fs = createFirestoreHouseholdHandoffRepository(destination);
      const restored = await fs.read(owner);
      expect(restored?.plan).toMatchObject({ ...settings, sharing: null });
      expect(restored?.plan?.id).not.toBe(active.plan.id);
      expect(restored?.revision).not.toBe(active.revision);
      const consentOnTarget = consent(fs);
      await expect(consentOnTarget.service.inspect(owner, invite)).rejects.toThrow('sharing link');
      await expect(consentOnTarget.service.finish(pending)).rejects.toThrow('plan changed');
      expect(consentOnTarget.fetcher).not.toHaveBeenCalled();
      expect(
        (await importWorkspaceBundle(destination, bundle, { ...options, mode: 'verify' })).verified,
      ).toBe(true);
      expect(await fs.read(owner)).toEqual(restored);
    } finally {
      try {
        await disposeStore(destination);
      } finally {
        await source.close();
      }
    }
  },
  60_000,
);
