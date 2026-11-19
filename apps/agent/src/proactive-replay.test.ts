import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { runBriefing } from '@assistant/core';
import {
  agents,
  createPostgresEmailSyncRepository,
  createPostgresExecutionPersistence,
  type Db,
  emailIngest,
  messages,
  proactiveMoments,
} from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import {
  type ExecutionPersistence,
  emailIngestReadable,
  notificationLeg,
  practiceChangeFromMail,
  type Records,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { runPulse } from '../../../packages/core/src/proactive/pulse.js';
import {
  decodeRecord,
  encodeRecord,
  type InstallationStore,
} from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import {
  type EmailSyncDeps,
  processMessage,
} from '../../../packages/modules/src/google/email-sync.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const RECEIVED = new Date('2026-11-18T23:01:00Z');
const at = (minutes: number) => new Date(RECEIVED.getTime() + minutes * 60_000);
const BODY =
  'Thursday, November 19 practice has moved from 4:30 PM at South Field to 5:30 PM at North Field.';
const SENDER = 'coach@example.test';
const SUBJECT = 'Thursday practice update';
const SPACE = { provider: 'synthetic', model: 'proactive-replay', dimensions: 1536, revision: '1' };

function forbidden<T>(name: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`Replay attempted ${name}`);
      },
    },
  ) as T;
}

describe('practice-change mail replay', () => {
  for (const driver of ['postgres', 'firestore'] as const) {
    it.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      `admits and delivers the moved practice once on ${driver}`,
      async () => {
        if (!process.env.ASSISTANT_TEST_TARGET_TOKEN || process.env.NODE_ENV === 'production')
          throw new Error('Use pnpm test with an isolated target');
        const agentId = randomUUID();
        const mailId = randomUUID();
        const owner = {
          id: agentId,
          name: 'Replay Owner',
          email: `replay-${agentId}@example.test`,
          timezone: 'America/Los_Angeles',
          workspacePrefix: `replay/${agentId}`,
        };
        let clock = RECEIVED;
        let store: InstallationStore | undefined;
        let db = forbidden<Db>('SQL on Firestore');
        let closeSql: (() => Promise<void>) | undefined;
        let persistence: ExecutionPersistence;
        try {
          if (driver === 'postgres') {
            const database = await createIsolatedTestDatabase();
            db = database.db;
            closeSql = database.close;
            await db.insert(agents).values(owner);
            persistence = {
              ...createPostgresExecutionPersistence(db),
              emailSync: createPostgresEmailSyncRepository(db, agentId),
            };
          } else {
            store = emulatorStore(() => clock);
            await store.doc('agents', agentId).set(encodeRecord(owner));
            persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
          }
          const route = {
            key: 'google.direct-email-routing',
            version: 1,
            workClass: 'idempotent_db',
          } as const;
          const provider = vi.fn(async (path: string) => {
            expect(path).toContain(`/messages/${mailId}?`);
            return {
              id: mailId,
              threadId: 'practice-thread',
              internalDate: String(RECEIVED.getTime()),
              labelIds: ['INBOX'],
              payload: {
                headers: [
                  { name: 'From', value: `Coach <${SENDER}>` },
                  { name: 'Subject', value: SUBJECT },
                  {
                    name: 'Authentication-Results',
                    value: 'mx.google.com; dmarc=pass header.from=example.test',
                  },
                ],
                mimeType: 'text/plain',
                body: { data: Buffer.from(BODY).toString('base64url') },
              },
            };
          });
          const deps = {
            persistence,
            config: {
              ...loadConfig(),
              EMAIL_INGEST_MODE: 'direct',
              GMAIL_SYNC_ENABLED: 'true',
              ASSISTANT_MODULES: ['google'],
            },
            durableEmailObservers: [{ identity: route }],
            googleClient: { configured: () => true, api: provider },
            router: forbidden('model calls'),
            workspace: forbidden('attachment writes'),
            notifyOwner: async () => {
              throw new Error('Unexpected arrival notification');
            },
            observeInboundEmail: async () => {
              throw new Error('Unexpected legacy observer');
            },
            operationalReady: async () => true,
          } as unknown as EmailSyncDeps;
          const sourceKey = `gmail:${mailId}`;
          const replayMail = () =>
            processMessage(deps, agentId, owner.email, new Map([[SENDER, 'known']]), mailId);
          expect(await replayMail()).toBe('triaged');
          const pointer = await persistence.emailSync?.ingestRecord(sourceKey);
          if (!pointer) throw new Error('No canonical ingest row');
          const ingest = store
            ? decodeRecord<Records['emailIngest']>(
                (await store.doc('emailIngest', pointer.id).get()).data(),
              )
            : (await db.select().from(emailIngest).where(eq(emailIngest.id, pointer.id)))[0];
          expect(ingest).toMatchObject({
            authenticated: true,
            ingestMode: 'direct',
            pipelineStage: 'message_persisted',
            scoreStatus: 'prepared',
            messagePersisted: true,
            providerMessageId: mailId,
          });
          expect(emailIngestReadable(ingest ?? {})).toBe(true);
          expect(practiceChangeFromMail(ingest ?? {})).toMatchObject({
            previousIso: '2026-11-20T00:30:00.000Z',
            iso: '2026-11-20T01:30:00.000Z',
            practiceField: 'North Field',
            previousField: 'South Field',
            dateEvidence: BODY,
          });
          expect(emailIngestReadable({ ...ingest, ingestMode: 'forwarded' })).toBe(false);
          expect(emailIngestReadable({ pipelineStage: undefined })).toBe(true);
          expect(
            practiceChangeFromMail({
              ...ingest,
              ingestMode: 'forwarded',
              pipelineStage: 'complete',
            }),
          ).toBeNull();
          expect(practiceChangeFromMail({ ...ingest, pipelineStage: 'score_prepared' })).toBeNull();

          // Align the SQL server's write timestamp with the replay clock. The
          // provider receipt and every subsequent tick are frozen independently.
          if (ingest && driver === 'postgres')
            await db
              .update(emailIngest)
              .set({ createdAt: RECEIVED })
              .where(eq(emailIngest.id, ingest.id));
          if (ingest && store)
            await store.doc('emailIngest', ingest.id).update(encodeRecord({ createdAt: RECEIVED }));

          const notifyOwner = vi.fn(async () => notificationLeg('phone', 'delivered'));
          const pulseDeps = {
            db,
            ...(driver === 'firestore' ? { persistence } : {}),
            notifyOwner,
            emailThreadReader: async ({ threadId }: { threadId: string }) => ({
              threadId,
              latestMessageId: mailId,
              latestReceivedAt: RECEIVED,
            }),
          };
          clock = at(19);
          expect(await runPulse(pulseDeps, { agentId, now: clock })).toMatchObject({
            candidates: 1,
            delivered: 'practice-change',
            pinged: true,
          });
          expect(clock.getTime() - RECEIVED.getTime()).toBeLessThanOrEqual(60 * 60_000);
          const notifyArgs = notifyOwner.mock.calls[0] as unknown as [{ conversationId: string }];
          const conversationId = notifyArgs[0].conversationId;
          const readParts = async () =>
            store
              ? (
                  await store
                    .collection('messages')
                    .where('conversationId', '==', conversationId)
                    .get()
                ).docs.map((doc) => doc.get('parts'))
              : (
                  await db
                    .select({ parts: messages.parts })
                    .from(messages)
                    .where(eq(messages.conversationId, conversationId))
                ).map((row) => row.parts);
          const parts = await readParts();
          expect(parts).toHaveLength(1);
          expect(parts[0]).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'data-card',
                data: expect.objectContaining({
                  kind: 'proactive-alert',
                  startsAt: '2026-11-20T01:30:00.000Z',
                  summary:
                    'Was Tomorrow 4:30 PM at South Field, now Tomorrow 5:30 PM at North Field.',
                  details: [
                    { label: 'Field', value: 'North Field' },
                    { label: 'Source', value: `${SENDER} · ${SUBJECT}` },
                    { label: 'Next step', value: 'Use the updated time and field for your trip.' },
                  ],
                }),
              }),
            ]),
          );
          expect(await replayMail()).toBe('skipped');
          expect(provider).toHaveBeenCalledOnce();
          clock = at(90);
          expect(await runPulse(pulseDeps, { agentId, now: clock })).toMatchObject({
            delivered: null,
            heldBy: 'no-candidates',
          });
          clock = at(16 * 60);
          const briefing = await runBriefing(
            {
              db,
              ...(driver === 'firestore' ? { persistence } : {}),
              router: forbidden('briefing model calls'),
              notifyOwner,
            },
            { agentId, now: clock },
          );
          expect(briefing).toMatchObject({ delivered: false, highlights: 0, upcoming: 0 });
          expect(notifyOwner).toHaveBeenCalledOnce();
          expect(await readParts()).toEqual(parts);

          if (driver === 'postgres') {
            const ledger = await db
              .select()
              .from(proactiveMoments)
              .where(eq(proactiveMoments.agentId, agentId));
            expect(ledger).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  kind: 'practice-change',
                  momentKey: `mail-action:${sourceKey}`,
                  deliveredAt: at(19),
                }),
              ]),
            );
          }
        } finally {
          if (store) await disposeStore(store);
          else await closeSql?.();
        }
      },
      90_000,
    );
  }
});
