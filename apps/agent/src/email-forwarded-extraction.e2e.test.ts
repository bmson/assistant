import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import {
  agents,
  assertPostgresInstallationOwner,
  createPostgresEmailSyncRepository,
  createPostgresExecutionPersistence,
  type Db,
  emailIngest,
  memories,
} from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { type EmailSyncDeps, processMessage } from '@assistant/modules';
import {
  type ExecutionPersistence,
  embeddingSpaceIdentityKey,
  taskActivityDiagnostics,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import {
  mailHealthWindow,
  sqlMailHealthCounts,
} from '../../../packages/core/src/proactive/pipeline-health.js';
import { runAssistantHealthMonitor } from '../../../packages/core/src/workflow/health-monitor.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const SPACE = {
  provider: 'synthetic',
  model: 'forwarded-fixture',
  dimensions: 1536,
  revision: '1',
};
const HOUR = 3_600_000;

function noSql(): Db {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
      },
    },
  ) as Db;
}

for (const driver of ['postgres', 'firestore'] as const) {
  it.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${driver}: forwarded mail reaches scheduled extraction, and unfinished intake alerts once per day`,
    async () => {
      const id = randomUUID();
      const channelMessageId = `gmail:${id}`;
      const agentEmail = 'assistant@example.test';
      const installation = driver === 'postgres' ? await createIsolatedTestDatabase() : undefined;
      const db = installation?.db ?? noSql();
      const store = driver === 'firestore' ? emulatorStore() : undefined;
      try {
        const agentId = store ? randomUUID() : await assertPostgresInstallationOwner(db);
        let persistence: ExecutionPersistence;
        if (store) {
          persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
          await store
            .doc('agents', agentId)
            .set({ id: agentId, email: agentEmail, name: 'Synthetic assistant', timezone: 'UTC' });
        } else {
          persistence = {
            ...createPostgresExecutionPersistence(db),
            emailSync: createPostgresEmailSyncRepository(db, agentId),
          };
          await db
            .update(agents)
            .set({ email: agentEmail, timezone: 'UTC' })
            .where(eq(agents.id, agentId));
        }

        const syntheticBody =
          'Booking QX42 is confirmed. The shuttle leaves the test station at 08:15 UTC on 3 April 2027.';
        const extractedFact = `Synthetic booking ${id} leaves the test station at 08:15 UTC.`;
        const object = vi.fn(
          async (role: string, input: { schema: { parse(value: unknown): unknown } }) => ({
            ok: true,
            modelId: 'fixture',
            degraded: false,
            object: input.schema.parse(
              role === 'extract'
                ? {
                    facts: [
                      {
                        content: extractedFact,
                        kind: 'fact',
                        category: 'knowledge',
                        subject: 'owner',
                        relationship: '',
                        importance: 4,
                        confidence: 0.95,
                        domain: 'other',
                        validFrom: '',
                      },
                    ],
                    occasions: [],
                  }
                : {
                    category: 'travel',
                    importance: 2,
                    actionable: false,
                    dates: [],
                    reason: 'Synthetic booking',
                  },
            ),
          }),
        );
        const router = {
          object,
          embeddingSpace: async () => SPACE,
          embeddingSpaceKey: async () => embeddingSpaceIdentityKey(SPACE),
          embed: async (texts: string[]) => texts.map(() => [1, ...new Array(1535).fill(0)]),
        } as unknown as ExecutorDeps['router'];
        const deps: ExecutorDeps = {
          db,
          router,
          dispatcher: {} as ExecutorDeps['dispatcher'],
          persistence,
        };
        const emailDeps: EmailSyncDeps = {
          ...(driver === 'postgres' ? { db } : {}),
          persistence,
          router,
          config: {
            ASSISTANT_MODULES: ['google'],
            GMAIL_SYNC_ENABLED: 'true',
            EMAIL_INGEST_MODE: 'forwarded',
            EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
            EMAIL_INGEST_NOTIFY_THRESHOLD: 5,
            EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
          } as EmailSyncDeps['config'],
          workspace: {} as EmailSyncDeps['workspace'],
          googleClient: {
            api: vi.fn(async () => ({
              id,
              threadId: `thread-${id}`,
              labelIds: [],
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'From', value: 'bookings@example.test' },
                  { name: 'Subject', value: 'Synthetic shuttle booking' },
                  { name: 'Message-ID', value: `<${id}@example.test>` },
                  {
                    name: 'Authentication-Results',
                    value: 'mx.google.com; dkim=pass header.d=example.test',
                  },
                ],
                body: { data: Buffer.from(syntheticBody).toString('base64url') },
              },
            })),
          } as unknown as EmailSyncDeps['googleClient'],
          notifyOwner: vi.fn(async () => ({ legs: [] })),
          observeInboundEmail: vi.fn(async () => {}),
        };

        const readIngest = async () =>
          store
            ? (
                await store
                  .collection('emailIngest')
                  .where('channelMessageId', '==', channelMessageId)
                  .get()
              ).docs[0]?.data()
            : (
                await db
                  .select()
                  .from(emailIngest)
                  .where(eq(emailIngest.channelMessageId, channelMessageId))
              )[0];
        const diagnosticTaskIds: string[] = [];
        const monitor = async (now: Date) => {
          const { task } = await persistence.tasks.createTask({
            agentId,
            type: 'scheduled',
            trust: 'assistant',
            trigger: { source: 'schedule', payload: { job: 'health.monitor' } },
          });
          diagnosticTaskIds.push(task.id);
          return runAssistantHealthMonitor(
            {
              db,
              health: persistence.assistantHealth,
              graphSync: persistence.graphSync,
              saveDiagnostic: async (id, text) => {
                expect(
                  await persistence.tasks.appendActivityDiagnostic({
                    agentId,
                    taskId: task.id,
                    diagnostic: { id, text },
                  }),
                ).toBe(true);
              },
            },
            { agentId, now },
          );
        };
        expect(await monitor(new Date())).toMatchObject({ signals: [], notified: false });
        expect(await processMessage(emailDeps, agentId, agentEmail, new Map(), id)).toBe('skipped');
        expect(await readIngest()).toMatchObject({
          pipelineStage: 'complete',
          extractedAt: null,
          category: 'travel',
          importance: 2,
        });
        expect(emailDeps.notifyOwner).not.toHaveBeenCalled();

        async function runScheduled(job: 'email.extract' | 'health.monitor') {
          const { task } = await persistence.tasks.createTask({
            agentId,
            type: 'scheduled',
            trust: 'assistant',
            trigger: { source: 'schedule', payload: { job } },
          });
          return { ...(await executeTask(deps, task.id)), taskId: task.id };
        }

        expect(await runScheduled('email.extract')).toMatchObject({
          outcome: 'done',
          detail: expect.stringContaining('1 saved (1 recallable, 0 awaiting review)'),
        });
        expect(await readIngest()).toMatchObject({ extractedAt: expect.anything() });
        const saved = store
          ? (
              await store
                .collection('memories')
                .where('agentId', '==', agentId)
                .where('content', '==', extractedFact)
                .get()
            ).size
          : (
              await db
                .select()
                .from(memories)
                .where(and(eq(memories.agentId, agentId), eq(memories.content, extractedFact)))
            ).length;
        expect(saved).toBe(1);
        expect(await runScheduled('email.extract')).toMatchObject({
          outcome: 'done',
          detail: expect.stringContaining('from 0 message(s)'),
        });
        expect(object).toHaveBeenCalledTimes(2);

        const now = new Date();
        const counts = () => {
          const window = mailHealthWindow(now);
          return store
            ? persistence.assistantHealth?.observeMail?.(agentId, window)
            : sqlMailHealthCounts(db, agentId, window);
        };
        expect(await counts()).toMatchObject({
          mailEligibleIntake24h: 1,
          mailExtractionCompleted24h: 1,
          mailExtraction24hState: 'processed',
        });
        const stuck = {
          id: randomUUID(),
          agentId,
          channelMessageId: `gmail:stalled-${id}`,
          category: 'travel',
          importance: 1,
          fromEmail: 'private@example.test',
          subject: 'Synthetic private subject must never appear in alerts',
          pipelineStage: 'scoring',
          extractedAt: null as Date | null,
          createdAt: new Date(now.getTime() - 7 * HOUR),
        };
        async function updateStalledMail(patch: Partial<typeof stuck>) {
          if (store) await store.doc('emailIngest', stuck.id).update(patch);
          else await db.update(emailIngest).set(patch).where(eq(emailIngest.id, stuck.id));
        }
        const fresh = {
          ...stuck,
          id: randomUUID(),
          channelMessageId: `gmail:fresh-${id}`,
          pipelineStage: 'pending_score',
          createdAt: now,
        };
        const review = {
          ...stuck,
          id: randomUUID(),
          channelMessageId: `gmail:review-${id}`,
          pipelineStage: 'needs_attention',
        };
        if (store) {
          for (const row of [stuck, fresh, review]) await store.doc('emailIngest', row.id).set(row);
        } else {
          await db.insert(emailIngest).values([stuck, fresh, review]);
        }
        const completedOld = {
          ...stuck,
          id: randomUUID(),
          channelMessageId: `gmail:old-completed-${id}`,
          pipelineStage: 'complete',
          createdAt: new Date(now.getTime() - 8 * 24 * HOUR),
          extractedAt: now,
        };
        const bulk = {
          ...completedOld,
          id: randomUUID(),
          channelMessageId: `gmail:bulk-${id}`,
          category: 'bulk',
          importance: 5,
          createdAt: now,
        };
        if (store) {
          for (const row of [completedOld, bulk]) await store.doc('emailIngest', row.id).set(row);
        } else {
          await db.insert(emailIngest).values([completedOld, bulk]);
        }
        expect(await counts()).toMatchObject({
          mailEligibleIntake24h: 1,
          mailExtractionCompleted24h: 2,
          mailExtraction24hState: 'processed',
        });

        const stalledExtraction = await runScheduled('email.extract');
        expect(stalledExtraction.outcome).toBe('done');
        const recorded = await persistence.executionContext?.getTask(
          agentId,
          stalledExtraction.taskId,
        );
        expect(recorded).toMatchObject({
          status: 'done',
          progress: expect.stringContaining(
            '0 still pending extraction; recent intake (last 7 days): 1 stuck in scoring for over six hours, ' +
              '1 still in intake within six hours, 1 in intake awaiting review',
          ),
        });
        expect(recorded?.progress).not.toContain(stuck.subject);
        expect(recorded?.progress).not.toContain(stuck.fromEmail);
        expect(object).toHaveBeenCalledTimes(2);

        const warning = 'Mail processing has waited over six hours: 1 in scoring.';
        const scheduledHealth = await runScheduled('health.monitor');
        diagnosticTaskIds.push(scheduledHealth.taskId);
        expect(scheduledHealth).toMatchObject({
          outcome: 'done',
          detail: expect.stringMatching(/^health monitor: recorded [1-9]\d* signal/),
        });
        expect(await monitor(new Date(now.getTime() + HOUR))).toMatchObject({
          signals: [warning],
          notified: false,
        });
        await updateStalledMail({ pipelineStage: 'complete' });
        const extractionBacklog =
          'Mail processing has waited over six hours: 1 awaiting extraction.';
        expect(await monitor(new Date(now.getTime() + 2 * HOUR))).toMatchObject({
          signals: [extractionBacklog],
          notified: false,
        });
        await updateStalledMail({ extractedAt: now });
        expect(await monitor(new Date(now.getTime() + 3 * HOUR))).toMatchObject({
          signals: [],
          notified: false,
        });
        await updateStalledMail({ extractedAt: null });
        expect(await monitor(new Date(now.getTime() + 4 * HOUR))).toMatchObject({
          signals: [extractionBacklog],
          notified: false,
        });
        const nextDayBacklog =
          'Mail processing has waited over six hours: 1 in pending score, 1 awaiting extraction.';
        expect(await monitor(new Date(now.getTime() + 25 * HOUR))).toMatchObject({
          signals: [nextDayBacklog],
          notified: true,
        });
        const diagnosticTasks = await Promise.all(
          diagnosticTaskIds.map((id) => persistence.tasks.getTask(id)),
        );
        const notices = diagnosticTasks.flatMap((task) =>
          taskActivityDiagnostics(task?.state).map(({ text }) => text),
        );
        expect(notices.filter((text) => text.includes('Mail processing has waited'))).toHaveLength(
          2,
        );
        expect(notices).toEqual(
          expect.arrayContaining([
            expect.stringContaining(warning),
            expect.stringContaining(nextDayBacklog),
          ]),
        );
        expect(notices.join(' ')).not.toContain(stuck.subject);
        expect(notices.join(' ')).not.toContain(stuck.fromEmail);
        expect(notices.join(' ')).not.toContain(syntheticBody);

        if (store) {
          const legacyId = randomUUID();
          await store.doc('emailIngest', legacyId).set({
            id: legacyId,
            agentId,
            createdAt: now,
            pipelineStage: 'complete',
            category: 'travel',
            importance: 1,
          });
          expect(await counts()).toMatchObject({
            mailEligibleIntake24h: 3,
            mailExtractionCompleted24h: null,
            mailExtraction24hState: 'unavailable',
          });
        }
      } finally {
        if (store) await disposeStore(store);
        else await installation?.close();
      }
    },
    30_000,
  );
}
