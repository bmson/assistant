import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allowedUrl,
  collectInventory,
  createReadOnlyGet,
  DATABASE,
  listPages,
  recoveryPoint,
  serviceFacts,
  verifyManifest,
  verifyWifEnvironment,
} from './owner-editor-release-inventory.js';

const manifest = readFileSync(
  new URL('./fixtures/owner-editor-release-indexes.json', import.meta.url),
);
const now = Date.parse('2026-10-26T17:00:00Z');
const db = {
  name: DATABASE,
  uid: '11111111-1111-4111-8111-111111111111',
  locationId: 'us-west1',
  pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
  earliestVersionTime: '2026-10-20T17:00:00Z',
  versionRetentionPeriod: '604800s',
};
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_REPOSITORY: 'bmson/assistant',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1',
  GCP_PROJECT: 'bmson-assistant',
  GITHUB_WORKSPACE: '/workspace',
  RUNNER_TEMP: '/runner',
  GCP_DEPLOY_SERVICE_ACCOUNT: 'deployer@bmson-assistant.iam.gserviceaccount.com',
  GCP_WORKLOAD_IDENTITY_PROVIDER:
    'projects/123/locations/global/workloadIdentityPools/pool/providers/provider',
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/workspace/gha-creds-file.json',
  GOOGLE_APPLICATION_CREDENTIALS: '/workspace/gha-creds-file.json',
};
const credential = {
  type: 'external_account',
  audience: `//iam.googleapis.com/${env.GCP_WORKLOAD_IDENTITY_PROVIDER}`,
  token_url: 'https://sts.googleapis.com/v1/token',
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GCP_DEPLOY_SERVICE_ACCOUNT}:generateAccessToken`,
};
function service() {
  const values = {
    PERSISTENCE_DRIVER: 'firestore',
    FIRESTORE_DATABASE_ID: 'assistant-production',
    ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
    ASSISTANT_RELEASE_SCHEMA_MIN: '1',
    ASSISTANT_RELEASE_SCHEMA_MAX: '1',
    ASSISTANT_RELEASE_API_CONTRACT: '1',
  };
  return {
    name: 'projects/bmson-assistant/locations/us-west1/services/assistant-agent',
    template: {
      serviceAccount: env.GCP_DEPLOY_SERVICE_ACCOUNT,
      containers: [
        {
          image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:${'a'.repeat(64)}`,
          env: [
            ...Object.entries(values).map(([name, value]) => ({ name, value })),
            { name: 'PRIVATE_VALUE', value: 'secret-do-not-retain' },
          ],
        },
      ],
    },
    trafficStatuses: [{ revision: 'assistant-agent-00001-abc', percent: 100 }],
  };
}
describe('protected read-only release inventory', () => {
  it('pins manifest bytes and rejects pre-auth source drift', () => {
    expect(verifyManifest(manifest).groups).toContain('ownerEditorOperations');
    expect(() => verifyManifest(Buffer.concat([manifest, Buffer.from(' ')]))).toThrow();
  });
  it.each([
    `http://firestore.googleapis.com/v1/${DATABASE}`,
    `https://evil.example/v1/${DATABASE}`,
    'https://firestore.googleapis.com/v1/projects/other/databases/assistant-production',
    `https://firestore.googleapis.com/v1/${DATABASE}/documents/private`,
    'https://run.googleapis.com/v2/projects/bmson-assistant/locations/us-west1/services/assistant-web?alt=media',
    `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/fields`,
  ])('rejects target %s before dispatch', (url) => expect(() => allowedUrl(url)).toThrow());
  it.each([
    String.fromCharCode(0),
    String.fromCharCode(9),
    ' ',
    String.fromCharCode(31),
    String.fromCharCode(32),
    String.fromCharCode(127),
    'a'.repeat(2049),
  ])('rejects bounded/control page tokens before dispatch', (token) => {
    const url = new URL(
      `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
    );
    url.searchParams.set('pageToken', token);
    expect(() => allowedUrl(url.href)).toThrow();
  });
  it('requires complete pagination and rejects repeated tokens', async () => {
    let calls = 0;
    await expect(
      listPages(
        async () => {
          calls++;
          return { indexes: [], nextPageToken: 'again' };
        },
        `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
        'indexes',
      ),
    ).rejects.toThrow('repeated');
    expect(calls).toBe(2);
  });
  it('rejects omitted or malformed page identities and unexpected page data', async () => {
    await expect(
      listPages(
        async () => ({ indexes: {}, nextPageToken: '' }),
        `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
        'indexes',
      ),
    ).rejects.toThrow();
    await expect(
      listPages(
        async () => ({ indexes: [], unexpected: 'secret' }),
        `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
        'indexes',
      ),
    ).rejects.toThrow();
  });
  it('accepts explicit WIF configuration without claiming caller provenance', () =>
    expect(verifyWifEnvironment(env, () => credential).principal).toBe(
      env.GCP_DEPLOY_SERVICE_ACCOUNT,
    ));
  it.each([
    { ...env, GITHUB_RUN_ATTEMPT: '2' },
    { ...env, GITHUB_REF: 'refs/heads/topic' },
    { ...env, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/home/default.json' },
    { ...env, GOOGLE_APPLICATION_CREDENTIALS: '/different.json' },
  ])('rejects default/untrusted credential context', (input) =>
    expect(() => verifyWifEnvironment(input, () => credential)).toThrow(),
  );
  it('rejects wrong WIF audience or impersonated account', () => {
    expect(() =>
      verifyWifEnvironment(env, () => ({ ...credential, audience: '//wrong' })),
    ).toThrow();
    expect(() =>
      verifyWifEnvironment(env, () => ({
        ...credential,
        service_account_impersonation_url: 'https://evil/token',
      })),
    ).toThrow();
  });
  it('requires known PITR retention and valid coverage', () => {
    expect(recoveryPoint(db, [], now)).toMatchObject({ kind: 'pitr', restorationProven: false });
    expect(() => recoveryPoint({ ...db, earliestVersionTime: 'unknown' }, [], now)).toThrow();
    expect(() => recoveryPoint({ ...db, versionRetentionPeriod: undefined }, [], now)).toThrow();
    expect(() => recoveryPoint({ ...db, name: `${DATABASE}other` }, [], now)).toThrow();
  });
  it('reports backup uncovered interval and rejects stale or foreign backups', () => {
    const backup = {
      name: 'projects/bmson-assistant/locations/us-west1/backups/b1',
      database: DATABASE,
      databaseUid: db.uid,
      state: 'READY',
      snapshotTime: '2026-10-26T16:00:00Z',
      expireTime: '2026-10-27T00:00:00Z',
    };
    expect(
      recoveryPoint(
        { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' },
        [backup],
        now,
      ),
    ).toMatchObject({
      kind: 'backup',
      uncoveredWriteIntervalSeconds: 3600,
      restorationProven: false,
    });
    expect(() =>
      recoveryPoint(
        { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' },
        [{ ...backup, database: 'foreign' }],
        now,
      ),
    ).toThrow();
    expect(() =>
      recoveryPoint(
        { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' },
        [{ ...backup, snapshotTime: '2026-10-20T16:00:00Z' }],
        now,
      ),
    ).toThrow();
  });
  it('binds recovery observations to the current database incarnation', () => {
    const disabled = { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' };
    const backup = {
      name: 'projects/bmson-assistant/locations/us-west1/backups/b1',
      database: DATABASE,
      databaseUid: db.uid,
      state: 'READY',
      snapshotTime: '2026-10-26T16:00:00Z',
      expireTime: '2026-10-27T00:00:00Z',
    };
    expect(recoveryPoint(disabled, [backup], now).databaseUid).toBe(db.uid);
    expect(() =>
      recoveryPoint(
        disabled,
        [{ ...backup, databaseUid: '22222222-2222-4222-8222-222222222222' }],
        now,
      ),
    ).toThrow('incarnation');
    expect(() => recoveryPoint(disabled, [{ ...backup, databaseUid: undefined }], now)).toThrow();
    expect(() => recoveryPoint({ ...disabled, uid: undefined }, [backup], now)).toThrow();
    expect(() => recoveryPoint({ ...db, uid: 'not-a-uuid' }, [], now)).toThrow();
  });
  it('keeps PITR observation time separate from an unqualified whole-minute proposal', () => {
    const result = recoveryPoint(db, [], now + 12345);
    expect(result).toMatchObject({
      kind: 'pitr',
      observedAt: '2026-10-26T17:00:12.345Z',
      operationCheckpoint: null,
      operationCheckpointQualified: false,
      proposedWholeMinuteSnapshot: '2026-10-26T17:00:00.000Z',
      roundingMilliseconds: 12345,
      uncoveredWriteIntervalMilliseconds: 12345,
      expiryGuaranteed: false,
      restorationProven: false,
    });
    const boundary = recoveryPoint(
      { ...db, earliestVersionTime: '2026-10-26T17:00:00.001Z' },
      [],
      now + 12345,
    );
    expect(boundary).toMatchObject({
      proposedWholeMinuteSnapshot: null,
      checkpointLimitation: 'rounded_minute_outside_observed_coverage',
      operationCheckpoint: null,
      operationCheckpointQualified: false,
    });
    expect(() =>
      recoveryPoint({ ...db, earliestVersionTime: '2026-10-26T17:01:00Z' }, [], now + 12345),
    ).toThrow();
  });
  it.each(['2026-10-26T17:00:00.000000001Z', '2026-10-26T17:00:00.000999999Z'])(
    'preserves sub-millisecond coverage bound %s and refuses the preceding minute',
    (earliestVersionTime) => {
      expect(recoveryPoint({ ...db, earliestVersionTime }, [], now + 12345)).toMatchObject({
        earliestVersionTime,
        earliestComparisonUpperBound: '2026-10-26T17:00:00.001Z',
        proposedWholeMinuteSnapshot: null,
        operationCheckpoint: null,
        operationCheckpointQualified: false,
        checkpointLimitation: 'rounded_minute_outside_observed_coverage',
      });
    },
  );
  it('accepts an exactly representable minute without moving the coverage lower bound', () => {
    expect(
      recoveryPoint(
        { ...db, earliestVersionTime: '2026-10-26T17:00:00.000000000Z' },
        [],
        now + 12345,
      ),
    ).toMatchObject({
      earliestVersionTime: '2026-10-26T17:00:00.000000000Z',
      earliestComparisonUpperBound: '2026-10-26T17:00:00.000Z',
      proposedWholeMinuteSnapshot: '2026-10-26T17:00:00.000Z',
      operationCheckpointQualified: false,
    });
  });
  it('uses conservative directional backup time bounds and preserves wire facts', () => {
    const disabled = { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' };
    const backup = {
      name: 'projects/bmson-assistant/locations/us-west1/backups/b1',
      database: DATABASE,
      databaseUid: db.uid,
      state: 'READY',
      snapshotTime: '2026-10-25T15:00:00.000000000Z',
      expireTime: '2026-10-27T00:00:00.000000001Z',
    };
    expect(recoveryPoint(disabled, [backup], now)).toMatchObject({
      kind: 'backup',
      snapshotTime: backup.snapshotTime,
      checkpoint: backup.snapshotTime,
      expiresAt: backup.expireTime,
      snapshotAgeComparisonLowerBound: '2026-10-25T15:00:00.000Z',
      snapshotFutureComparisonUpperBound: '2026-10-25T15:00:00.000Z',
      expiryComparisonLowerBound: '2026-10-27T00:00:00.000Z',
      operationCheckpointQualified: false,
    });
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, snapshotTime: '2026-10-25T14:59:59.999999999Z' }], now),
    ).toThrow();
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, snapshotTime: '2026-10-26T17:00:00.000000001Z' }], now),
    ).toThrow();
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, expireTime: '2026-10-26T17:00:00.000000001Z' }], now),
    ).toThrow();
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, expireTime: '2026-10-26T17:00:00.000000000Z' }], now),
    ).toThrow();
    expect(
      recoveryPoint(disabled, [{ ...backup, expireTime: '2026-10-26T17:00:00.001000000Z' }], now),
    ).toMatchObject({ kind: 'backup', expiresAt: '2026-10-26T17:00:00.001000000Z' });
  });
  it('retains only approved release fields and hashes the private configuration', () => {
    const facts = serviceFacts(service(), 'agent');
    expect(JSON.stringify(facts)).not.toContain('secret-do-not-retain');
    expect(facts.servingRevisionVerified).toBe(false);
    expect(() => serviceFacts({ ...service(), trafficStatuses: [] }, 'agent')).toThrow();
  });
  it('dispatches GET only, rejects redirect mode changes and limits body bytes', async () => {
    const calls: RequestInit[] = [];
    const fake = (async (_url: unknown, options: RequestInit) => {
      calls.push(options);
      return new Response('{}');
    }) as typeof fetch;
    await createReadOnlyGet(
      'a'.repeat(30),
      Date.now() + 1000,
      fake,
    )(`https://firestore.googleapis.com/v1/${DATABASE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', redirect: 'error' });
    const huge = (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch;
    await expect(
      createReadOnlyGet(
        'a'.repeat(30),
        Date.now() + 1000,
        huge,
      )(`https://firestore.googleapis.com/v1/${DATABASE}`),
    ).rejects.toThrow('bound');
  });
  it('does not dispatch after deadline or invalid target', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch;
    const read = createReadOnlyGet('a'.repeat(30), Date.now() - 1, fake);
    await expect(read(`https://firestore.googleapis.com/v1/${DATABASE}`)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('collects the complete fake wire path without issuing traffic or maintenance authority', async () => {
    const spec = JSON.parse(manifest.toString()) as {
      indexes: Array<{
        collectionGroup: string;
        queryScope: string;
        fields: Array<Record<string, unknown>>;
      }>;
      fieldOverrides: Array<{ collectionGroup: string; fieldPath: string }>;
    };
    const prefix = `${DATABASE}/collectionGroups/`;
    const composites = spec.indexes.map((index, n) => {
      const fields = index.fields.map((field) => ({ ...field }));
      if (!fields.some((field) => field.fieldPath === '__name__')) {
        const position = fields.findIndex((field) => field.vectorConfig !== undefined);
        const name = {
          fieldPath: '__name__',
          order: fields.at(-1)?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
        };
        if (position >= 0) fields.splice(position, 0, name);
        else fields.push(name);
      }
      return {
        name: `${prefix}${index.collectionGroup}/indexes/i${n}`,
        fields,
        queryScope: index.queryScope,
        state: 'READY',
      };
    });
    const fields = spec.fieldOverrides.map((field) => ({
      name: `${prefix}${field.collectionGroup}/fields/${field.fieldPath}`,
      indexConfig: {},
    }));
    const calls: string[] = [];
    const read = async (url: string) => {
      calls.push(url);
      if (url === `https://firestore.googleapis.com/v1/${DATABASE}`) return db;
      const component = url.includes('assistant-web') ? 'web' : 'agent';
      const svc = JSON.parse(
        JSON.stringify(service())
          .replaceAll('assistant-agent', `assistant-${component}`)
          .replaceAll('/agent@', `/${component}@`),
      ) as ReturnType<typeof service>;
      const traffic = svc.trafficStatuses[0];
      if (!traffic) throw new Error('missing fake traffic fixture');
      if (url.includes('/revisions/'))
        return {
          name: `${svc.name}/revisions/${traffic.revision}`,
          ...svc.template,
        };
      return svc;
    };
    const result = await collectInventory(read, manifest, now, {
      composites,
      fields,
      evidence: 'pinned-gcloud-576-complete-lists',
    });
    expect(result.indexes.status).toBe('exact_manifest_parity');
    expect(result).toMatchObject({
      trafficAuthorized: false,
      maintenanceAuthorized: false,
      mutationAuthorized: false,
      recoveryPairQualified: false,
    });
    expect(result.services.every((item) => item.servingRevisionVerified)).toBe(true);
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('secret-do-not-retain');
    await expect(
      collectInventory(
        async (url) => (url.includes('/revisions/') ? { name: 'wrong' } : read(url)),
        manifest,
        now,
        { composites, fields, evidence: 'pinned-gcloud-576-complete-lists' },
      ),
    ).rejects.toThrow();
  });
  it('fails closed without promoting a partial collector to authority', async () => {
    await expect(
      collectInventory(async () => ({ unexpected: 'do-not-retain' }), manifest, now),
    ).rejects.toThrow();
  });
});
