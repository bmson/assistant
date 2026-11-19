import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { agents, createDb, emailIngest } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { PENDING_MAIL_ADMISSION_STAGES } from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { disposeStore, emulatorStore } from '../packages/firestore/src/test-store.js';
import {
  mailCensusTarget,
  readFirestoreMailCensus,
  readPostgresMailCensus,
} from './mail-pipeline-census.js';

const asOf = new Date('2026-11-18T18:00:00.000Z');
const HOUR = 3_600_000;
const MAIL_BODY = 'Synthetic fixture body must never be returned by the census.';
const STAGES = [...PENDING_MAIL_ADMISSION_STAGES, 'complete', 'needs_attention'];

async function runLocalCli(driver: 'postgres' | 'firestore', env: NodeJS.ProcessEnv) {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./mail-pipeline-census.ts', import.meta.url)),
      '--local',
      '--read-only',
      '--driver',
      driver,
      '--limit',
      '1',
    ],
    { env: { ...process.env, ...env }, timeout: 15_000 },
  );
  expect(stderr).not.toContain(MAIL_BODY);
  expect(stdout).not.toContain(MAIL_BODY);
  return JSON.parse(stdout);
}

describe('mail census target selection', () => {
  const owner = randomUUID();
  const local = ['--read-only', '--local', '--driver', 'postgres'];
  const env = {
    MAIL_CENSUS_OWNER_ID: owner,
    MAIL_CENSUS_DATABASE_URL: 'postgres://user:fixture@127.0.0.1/census',
  };

  it('requires owner scope and explicit read-only target selection', () => {
    expect(() => mailCensusTarget([], env)).toThrow('--read-only');
    expect(() => mailCensusTarget(local, { ...env, MAIL_CENSUS_OWNER_ID: '' })).toThrow('scope');
    expect(() => mailCensusTarget([...local, '--limit', '10001'], env)).toThrow('row limit');
    expect(mailCensusTarget([...local, '--limit', '2'], env)).toMatchObject({
      driver: 'postgres',
      limit: 2,
      owner,
    });
  });

  it('keeps local runs on loopback and test invocations out of operator mode', () => {
    expect(() =>
      mailCensusTarget(local, {
        ...env,
        MAIL_CENSUS_DATABASE_URL: 'postgres://user@example.test/census',
      }),
    ).toThrow('loopback');
    expect(() =>
      mailCensusTarget(local, {
        ...env,
        MAIL_CENSUS_DATABASE_URL: 'postgres://user@127.0.0.1/census?host=example.test',
      }),
    ).toThrow('connection overrides');
    expect(() =>
      mailCensusTarget(['--read-only', '--operator', '--driver', 'postgres'], {
        ...env,
        NODE_ENV: 'test',
      }),
    ).toThrow('local census');
    const firestore = {
      ...env,
      GCP_PROJECT: 'demo-assistant-test',
      ASSISTANT_WORKSPACE_ID: 'mail-fixture',
      FIRESTORE_DATABASE_ID: '(default)',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8789',
    };
    expect(
      mailCensusTarget(['--read-only', '--local', '--driver', 'firestore'], firestore),
    ).toMatchObject({ driver: 'firestore', projectId: 'demo-assistant-test' });
    expect(() =>
      mailCensusTarget(['--read-only', '--local', '--driver', 'firestore'], {
        ...firestore,
        FIRESTORE_EMULATOR_HOST: 'remote.example.test:8789',
      }),
    ).toThrow('loopback emulator');
    expect(() =>
      mailCensusTarget(['--read-only', '--operator', '--driver', 'firestore'], firestore),
    ).toThrow('refuses an emulator');
  });
});

it('counts each PostgreSQL stage without exposing private fields or another owner', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Allocated test database required.');
  assertAllocatedTestTarget({
    databaseUrl,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const db = createDb(databaseUrl);
  const owner = randomUUID();
  const other = randomUUID();
  const rows = [...STAGES, 'foreign-stage'].map((stage, index) => ({
    agentId: index === STAGES.length ? other : owner,
    channelMessageId: randomUUID(),
    fromEmail: 'fixture@example.test',
    subject: MAIL_BODY,
    importance: 1,
    category: 'other',
    pipelineStage: stage,
    ingestMode: index === 0 ? 'direct' : 'forwarded',
    scoreStatus: index === 0 ? 'in_progress' : 'prepared',
    admittedSourceKind: index === 0 ? 'automated_source' : null,
    admittedSourceId: index === 0 ? randomUUID() : null,
    createdAt: new Date(asOf.getTime() - index * 6 * HOUR),
    extractedAt: index === 0 ? asOf : null,
  }));

  try {
    for (const id of [owner, other])
      await db
        .insert(agents)
        .values({ id, name: 'Synthetic owner', email: `${id}@example.test`, workspacePrefix: id });
    await db.insert(emailIngest).values(rows);
    const full = await readPostgresMailCensus(db, { owner, asOf, limit: STAGES.length });
    expect(full.coverage).toMatchObject({ complete: true, scannedRows: STAGES.length });
    expect(full.missingFieldsSupported).toBe(false);
    expect(
      Object.fromEntries(STAGES.map((stage) => [stage, full.dimensions.pipelineStage[stage]])),
    ).toEqual(Object.fromEntries(STAGES.map((stage) => [stage, 1])));
    expect(full.dimensions).toMatchObject({
      admittedSourceKind: { automated_source: 1, null: STAGES.length - 1, missing: 0 },
      extractedAt: { set: 1, null: STAGES.length - 1, missing: 0 },
      age: { under6h: 1, '6hTo24h': 3, '1dTo7d': 4 },
    });
    expect(JSON.stringify(full)).not.toContain(owner);
    expect(JSON.stringify(full)).not.toContain(MAIL_BODY);
    expect(JSON.stringify(full)).not.toContain('fixture@example.test');
    expect(
      await runLocalCli('postgres', {
        MAIL_CENSUS_OWNER_ID: owner,
        MAIL_CENSUS_DATABASE_URL: databaseUrl,
      }),
    ).toMatchObject({ driver: 'postgres', coverage: { complete: false, scannedRows: 1 } });
    const partial = await readPostgresMailCensus(db, { owner, asOf, limit: 1 });
    expect(partial.coverage).toMatchObject({ complete: false, scannedRows: 1, limit: 1 });
    await expect(
      readPostgresMailCensus(db, { owner: randomUUID(), asOf, limit: 1 }),
    ).rejects.toThrow('owner was not found');
    expect(
      (
        await db
          .select({ id: emailIngest.id })
          .from(emailIngest)
          .where(eq(emailIngest.agentId, owner))
      ).length,
    ).toBe(STAGES.length);
  } finally {
    try {
      await db.delete(emailIngest).where(inArray(emailIngest.agentId, [owner, other]));
      await db.delete(agents).where(inArray(agents.id, [owner, other]));
    } finally {
      await db.$client.end();
    }
  }
}, 30_000);

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'counts Firestore pages and distinguishes missing, null and set fields',
  async () => {
    const store = emulatorStore();
    const owner = randomUUID();
    const other = randomUUID();
    try {
      const batch = store.db.batch();
      batch.set(store.doc('agents', owner), { id: owner });
      batch.set(store.doc('agents', other), { id: other });
      for (let index = 0; index < 251; index++) {
        const stage = STAGES[index];
        const row = {
          agentId: owner,
          subject: MAIL_BODY,
          body: MAIL_BODY,
          ...(stage ? { pipelineStage: stage } : {}),
          ...(index === 0
            ? {
                ingestMode: 'direct',
                admittedSourceKind: 'automated_source',
                scoreStatus: 'prepared',
                createdAt: new Date(asOf.getTime() + HOUR),
                extractedAt: asOf,
              }
            : {}),
          ...(index === 1
            ? {
                ingestMode: 'forwarded',
                admittedSourceKind: null,
                scoreStatus: 'in_progress',
                createdAt: new Date(asOf.getTime() - 168 * HOUR),
                extractedAt: null,
              }
            : {}),
          ...(index === 2 ? { scoreStatus: MAIL_BODY } : {}),
        };
        batch.set(store.doc('emailIngest', `mail-${String(index).padStart(3, '0')}`), row);
      }
      batch.set(store.doc('emailIngest', 'foreign'), { agentId: other, pipelineStage: 'complete' });
      await batch.commit();
      const full = await readFirestoreMailCensus(store, { owner, asOf, limit: 251 });
      expect(full.coverage).toMatchObject({ complete: true, scannedRows: 251 });
      expect(full.missingFieldsSupported).toBe(true);
      expect(
        Object.fromEntries(STAGES.map((stage) => [stage, full.dimensions.pipelineStage[stage]])),
      ).toEqual(Object.fromEntries(STAGES.map((stage) => [stage, 1])));
      expect(full.dimensions).toMatchObject({
        extractedAt: { set: 1, null: 1, missing: 249 },
        scoreStatus: { prepared: 1, in_progress: 1, unrecognized: 1, missing: 248 },
        age: { future: 1, '7dOrMore': 1, missing: 249 },
      });
      expect(JSON.stringify(full)).not.toContain(MAIL_BODY);
      expect(JSON.stringify(full)).not.toContain(owner);
      expect(JSON.stringify(full)).not.toContain('mail-000');
      expect(
        await runLocalCli('firestore', {
          MAIL_CENSUS_OWNER_ID: owner,
          GCP_PROJECT: 'demo-assistant-test',
          ASSISTANT_WORKSPACE_ID: store.installationId,
          FIRESTORE_DATABASE_ID: '(default)',
        }),
      ).toMatchObject({ driver: 'firestore', coverage: { complete: false, scannedRows: 1 } });
      const partial = await readFirestoreMailCensus(store, { owner, asOf, limit: 250 });
      expect(partial.coverage).toMatchObject({ complete: false, scannedRows: 250, limit: 250 });
      await expect(
        readFirestoreMailCensus(store, { owner: randomUUID(), asOf, limit: 1 }),
      ).rejects.toThrow('owner was not found');
      expect((await store.collection('emailIngest').get()).size).toBe(252);
    } finally {
      await disposeStore(store);
    }
  },
  30_000,
);
