import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { getAgent } from '@assistant/core/chat';
import {
  createDb,
  createPostgresExecutionPersistence,
  type Db,
  emailObserverWork,
} from '@assistant/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { googleDurableEmailObservers } from '../../../../packages/modules/src/google/durable-email-observers.js';
import type { EmailSyncDeps } from '../../../../packages/modules/src/google/email-sync.js';
import { processMessage } from '../../../../packages/modules/src/google/email-sync.js';
import { googleModule } from '../../../../packages/modules/src/google/module.js';
import { createApp } from '../app.js';
import { buildDeps } from '../deps.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Run through the allocated pnpm test wrapper');

const touchedEnv = [
  'ASSISTANT_MODULES',
  'GMAIL_SYNC_ENABLED',
  'EMAIL_OBSERVER_WORKER_ENABLED',
  'EMAIL_INGEST_MODE',
  'INTERNAL_AUTH_MODE',
  'INTERNAL_API_SECRET',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'BOT_GOOGLE_REFRESH_TOKEN',
  'PERSISTENCE_DRIVER',
  'QUEUE_DRIVER',
  'DATABASE_URL',
] as const;
const previousEnv = new Map(touchedEnv.map((key) => [key, process.env[key]]));
const db = createDb(databaseUrl);
let routeDb: Db | undefined;

describe('authenticated internal sweep with admitted email observer work', {
  timeout: 30_000,
}, () => {
  beforeAll(() => {
    Object.assign(process.env, {
      ASSISTANT_MODULES: 'google',
      GMAIL_SYNC_ENABLED: 'true',
      EMAIL_OBSERVER_WORKER_ENABLED: 'false',
      EMAIL_INGEST_MODE: 'direct',
      INTERNAL_AUTH_MODE: 'shared-secret',
      INTERNAL_API_SECRET: 'route-test-secret',
      GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
      BOT_GOOGLE_REFRESH_TOKEN: 'synthetic-refresh-token',
      PERSISTENCE_DRIVER: 'postgres',
      QUEUE_DRIVER: 'inert',
      DATABASE_URL: databaseUrl,
    });
    resetConfigForTest();
  });

  afterAll(async () => {
    if (routeDb) await routeDb.$client.end();
    await db.$client.end();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigForTest();
  });

  it('admits synthetic source through the real ingress, authenticates the actual route, and leaves work unclaimed while disabled', async () => {
    const agentId = (await getAgent(db)).id;
    const id = `route-sweep-${randomUUID()}`;
    const from = 'synthetic-owner@example.test';
    const body = `Please reply to the sender. Synthetic acceptance case ${id}.`;
    const encode = (text: string) => ({ data: Buffer.from(text).toString('base64url') });
    const payload = {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: 'Synthetic source' },
        {
          name: 'Authentication-Results',
          value: 'mx.google.com; dmarc=pass header.from=example.test',
        },
      ],
      body: encode(body),
    };
    const emailSpace = {
      provider: 'synthetic',
      model: 'internal-sweep-route-test',
      dimensions: 1536,
      revision: '1',
    } as const;
    const admissionPersistence = createPostgresExecutionPersistence(db);
    const admissionDeps = {
      db,
      persistence: admissionPersistence,
      config: {
        ASSISTANT_MODULES: ['google'],
        GMAIL_SYNC_ENABLED: 'true',
        GENERATIVE_CARDS_ENABLED: false,
        EMAIL_INGEST_MODE: 'direct',
        EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
        EMAIL_INGEST_NOTIFY_THRESHOLD: 5,
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 100,
        EMAIL_OBSERVER_MAX_PAID_PER_DAY: 5,
        EMAIL_OBSERVER_WORKER_ENABLED: true,
      },
      router: {
        object: async () => ({
          ok: true,
          object: {
            category: 'other',
            importance: 3,
            actionable: true,
            dates: [],
            reason: 'Synthetic source',
          },
        }),
        embed: async () => [Array(1536).fill(0.1)],
        async embeddingSpace() {
          return emailSpace;
        },
      },
      workspace: {},
      googleClient: {
        configured: () => false,
        api: async () => ({ id, threadId: id, labelIds: ['INBOX'], payload }),
      },
      notifyOwner: async () => {},
      observeInboundEmail: async () => {},
    } as unknown as EmailSyncDeps;
    admissionDeps.durableEmailObservers = googleDurableEmailObservers(admissionDeps.googleClient);

    await processMessage(
      admissionDeps,
      agentId,
      'bot@example.test',
      new Map([[from, 'owner']]),
      id,
    );

    const sourceKey = `gmail:${id}`;
    const admittedRows = await db
      .select()
      .from(emailObserverWork)
      .where(
        and(eq(emailObserverWork.agentId, agentId), eq(emailObserverWork.sourceKey, sourceKey)),
      );
    expect(admittedRows.length).toBeGreaterThan(0);
    expect(admittedRows.every((row) => row.status === 'pending' && row.claimToken === null)).toBe(
      true,
    );

    const app = createApp();
    const denied = await app.request('/internal/sweep', { method: 'POST' });
    expect(denied.status).toBe(401);

    const unauthorizedBearer = await app.request('/internal/sweep', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    expect(unauthorizedBearer.status).toBe(401);

    const response = await app.request('/internal/sweep', {
      method: 'POST',
      headers: { authorization: 'Bearer route-test-secret' },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      emailObserverWorkClaimed?: number;
      failedSteps?: string[];
    };
    expect(result.emailObserverWorkClaimed).toBe(0);
    expect(Array.isArray(result.failedSteps)).toBe(true);
    expect(result.failedSteps).not.toContain('drainEmailObserverWork');

    const routeDeps = buildDeps();
    routeDb = routeDeps.db;
    expect(routeDeps.config.EMAIL_OBSERVER_WORKER_ENABLED).toBe(false);
    expect(routeDeps.modules.exportsOf(googleModule)?.configured()).toBe(true);
    expect(
      routeDeps.modules.durableEmailObservers.map((observer) => observer.identity.key),
    ).toEqual(
      expect.arrayContaining(['google.application-confirmation', 'google.direct-email-routing']),
    );
    expect(routeDeps.modules.sweepSteps.map((step) => step.name)).toContain(
      'drainEmailObserverWork',
    );

    const afterSweepRows = await db
      .select()
      .from(emailObserverWork)
      .where(
        and(eq(emailObserverWork.agentId, agentId), eq(emailObserverWork.sourceKey, sourceKey)),
      );
    expect(afterSweepRows).toEqual(admittedRows);
    expect(afterSweepRows.every((row) => row.status === 'pending' && row.claimToken === null)).toBe(
      true,
    );
  });
});
