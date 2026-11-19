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
  admittedBillEmailEvidence,
  type ExecutionPersistence,
  emailIngestReadable,
  notificationLeg,
  practiceChangeFromMail,
  type Records,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { postgresPulseRepository, runPulse } from '../../../packages/core/src/proactive/pulse.js';
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

describe('frozen proactive replay', () => {
  for (const driver of ['postgres', 'firestore'] as const) {
    it.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      `replays practice, cancellation, and paid bill on ${driver}`,
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
            const isolated = await createIsolatedTestDatabase();
            db = isolated.db;
            closeSql = isolated.close;
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
          const fixtureMail = new Map<
            string,
            {
              threadId: string;
              from: string;
              subject: string;
              body: string;
              at: Date;
            }
          >([
            [
              mailId,
              {
                threadId: 'practice-thread',
                from: SENDER,
                subject: SUBJECT,
                body: BODY,
                at: RECEIVED,
              },
            ],
          ]);
          const threadHeads = new Map([['practice-thread', mailId]]);
          const provider = vi.fn(async (path: string) => {
            const id = /\/messages\/([^?]+)\?/.exec(path)?.[1];
            const fixture = id && fixtureMail.get(id);
            if (!fixture) throw new Error('Unexpected provider message');
            const { threadId, from, subject, body, at } = fixture;
            return {
              id,
              threadId,
              internalDate: String(at.getTime()),
              labelIds: ['INBOX'],
              payload: {
                headers: [
                  { name: 'From', value: `Fixture Sender <${from}>` },
                  { name: 'Subject', value: subject },
                  {
                    name: 'Authentication-Results',
                    value: 'mx.google.com; dmarc=pass header.from=example.test',
                  },
                ],
                mimeType: 'text/plain',
                body: { data: Buffer.from(body).toString('base64url') },
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
          const issuer = 'billing@example.test';
          const known = new Map([
            [SENDER, 'known'],
            [issuer, 'known'],
          ] as const);
          const acceptMail = (id: string) => processMessage(deps, agentId, owner.email, known, id);
          const replayMail = () => acceptMail(mailId);
          const readIngest = async (key: string) => {
            const pointer = await persistence.emailSync?.ingestRecord(key);
            if (!pointer) throw new Error('No canonical ingest row');
            const row = store
              ? decodeRecord<Records['emailIngest']>(
                  (await store.doc('emailIngest', pointer.id).get()).data(),
                )
              : (await db.select().from(emailIngest).where(eq(emailIngest.id, pointer.id)))[0];
            if (!row) throw new Error('Missing native source fact');
            return row;
          };
          const setIngestClock = async (id: string, time: Date) => {
            if (store) await store.doc('emailIngest', id).update(encodeRecord({ createdAt: time }));
            else
              await db.update(emailIngest).set({ createdAt: time }).where(eq(emailIngest.id, id));
          };
          expect(await replayMail()).toBe('triaged');
          const ingest = await readIngest(sourceKey);
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
          await setIngestClock(ingest.id, RECEIVED);

          const notifyOwner = vi.fn(async () => notificationLeg('phone', 'delivered'));
          const pulseDeps = {
            db,
            ...(driver === 'firestore' ? { persistence } : {}),
            notifyOwner,
            emailThreadReader: async ({ threadId }: { threadId: string }) => {
              const latestMessageId = threadHeads.get(threadId);
              const fixture = latestMessageId && fixtureMail.get(latestMessageId);
              return fixture && latestMessageId
                ? { threadId, latestMessageId, latestReceivedAt: fixture.at }
                : null;
            },
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
          let calendarEvent = {
            calendarId: 'synthetic-calendar',
            eventId: 'separate-cancelled-practice',
            calendar: 'Team Calendar',
            summary: 'Thursday skills session',
            allDay: false,
            start: '2026-11-19T22:00:00Z',
            end: '2026-11-19T23:00:00Z',
            status: 'confirmed',
          };
          const calendarReader = async () => ({ complete: true, events: [calendarEvent] });
          clock = at(90);
          expect(
            await runPulse({ ...pulseDeps, calendarReader }, { agentId, now: clock }),
          ).toMatchObject({
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

          const cancelledAt = at(16 * 60 + 1);
          calendarEvent = { ...calendarEvent, status: 'cancelled' };
          clock = at(16 * 60 + 20);
          expect(
            await runPulse({ ...pulseDeps, calendarReader }, { agentId, now: clock }),
          ).toMatchObject({
            candidates: 1,
            delivered: 'calendar-cancelled',
            pinged: true,
          });
          expect(clock.getTime() - cancelledAt.getTime()).toBeLessThanOrEqual(20 * 60_000);
          expect(notifyOwner).toHaveBeenCalledTimes(2);
          expect(await readParts()).toEqual(
            expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({
                  type: 'data-card',
                  data: expect.objectContaining({
                    urgencyLabel: 'Cancelled',
                    title: 'Thursday skills session',
                  }),
                }),
              ]),
            ]),
          );
          const addBillMail = async (body: string, receivedAt: Date) => {
            const id = randomUUID();
            const threadId = `billing-${id}`;
            fixtureMail.set(id, {
              threadId,
              from: issuer,
              subject: 'Fixture utility account',
              body,
              at: receivedAt,
            });
            threadHeads.set(threadId, id);
            expect(await acceptMail(id)).toBe('triaged');
            const key = `gmail:${id}`;
            const row = await readIngest(key);
            await setIngestClock(row.id, receivedAt);
            return { id, key, fact: admittedBillEmailEvidence(row) };
          };
          const activePulse = store ? persistence.pulse : postgresPulseRepository(db);
          const billStatus = activePulse?.billStatus?.bind(activePulse);
          if (!billStatus) throw new Error('Missing native bill-state readback');

          const invoice = await addBillMail(
            'Invoice SYN-104: USD 42.15 is due on November 20, 2026.',
            at(18 * 60),
          );
          if (invoice.fact?.kind !== 'invoice') throw new Error('Invoice source evidence missing');
          expect(invoice.fact).toMatchObject({
            invoiceId: 'SYN-104',
            issuer,
            amountMinor: 4215,
            dueDate: '2026-11-20',
          });
          clock = at(22 * 60);
          expect(await billStatus(agentId, invoice.fact, clock)).toEqual({ kind: 'due' });
          expect(await runPulse(pulseDeps, { agentId, now: clock })).toMatchObject({
            candidates: 1,
            delivered: 'bill-due',
          });
          expect(await readParts()).toEqual(
            expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({
                  type: 'data-card',
                  data: expect.objectContaining({
                    title: 'Invoice SYN-104',
                    summary: '$42.15 due on November 20, 2026.',
                  }),
                }),
              ]),
            ]),
          );

          clock = at(22 * 60 + 5);
          await addBillMail(
            'Payment received in full for invoice SYN-105: USD 42.15. Balance due: USD 0.00.',
            clock,
          );
          expect(await billStatus(agentId, invoice.fact, clock)).toEqual({ kind: 'due' });
          const receipt = await addBillMail(
            'Payment received in full for invoice SYN-104: USD 42.15. Balance due: USD 0.00.',
            clock,
          );
          expect(receipt.fact).toMatchObject({
            kind: 'paid-in-full',
            identity: invoice.fact.identity,
          });
          expect(await acceptMail(receipt.id)).toBe('skipped');
          expect(await billStatus(agentId, invoice.fact, clock)).toEqual({
            kind: 'paid',
            sourceKey: receipt.key,
          });

          clock = at(23 * 60 + 20);
          expect(await runPulse(pulseDeps, { agentId, now: clock })).toMatchObject({
            candidates: 0,
            delivered: null,
            heldBy: 'no-candidates',
          });
          expect(notifyOwner).toHaveBeenCalledTimes(3);

          // The receipt is admitted first even though its source time is later.
          const earlyReceipt = await addBillMail(
            'Payment received in full for invoice SYN-106: USD 12.50. Balance due: USD 0.00.',
            at(24 * 60 + 10),
          );
          const lateInvoice = await addBillMail(
            'Invoice SYN-106: USD 12.50 is due on November 21, 2026.',
            at(24 * 60),
          );
          if (lateInvoice.fact?.kind !== 'invoice') throw new Error('Late invoice fact missing');
          clock = at(28 * 60 + 10);
          expect(await billStatus(agentId, lateInvoice.fact, clock)).toEqual({
            kind: 'paid',
            sourceKey: earlyReceipt.key,
          });
          expect(await runPulse(pulseDeps, { agentId, now: clock })).toMatchObject({
            candidates: 0,
            delivered: null,
          });
          expect(notifyOwner).toHaveBeenCalledTimes(3);

          const morningAfterPayment = await runBriefing(
            {
              db,
              ...(driver === 'firestore' ? { persistence } : {}),
              router: forbidden('post-payment model calls'),
              notifyOwner,
            },
            { agentId, now: clock },
          );
          expect(morningAfterPayment).toMatchObject({
            delivered: false,
            highlights: 0,
            upcoming: 0,
          });
          expect(notifyOwner).toHaveBeenCalledTimes(3);

          const racingInvoice = await addBillMail(
            'Invoice SYN-108: USD 24.50 is due on November 21, 2026.',
            at(29 * 60),
          );
          if (racingInvoice.fact?.kind !== 'invoice') throw new Error('Race invoice fact missing');
          clock = at(33 * 60);
          const race = await runPulse(
            {
              ...pulseDeps,
              emailThreadReader: async (input) => {
                const head = await pulseDeps.emailThreadReader(input);
                if (head?.latestMessageId === racingInvoice.id) {
                  await addBillMail(
                    'Payment received in full for invoice SYN-108: USD 24.50. Balance due: USD 0.00.',
                    clock,
                  );
                }
                return head;
              },
            },
            { agentId, now: clock },
          );
          expect(race).toMatchObject({ candidates: 1, delivered: null, heldBy: 'stale-source' });
          expect(await billStatus(agentId, racingInvoice.fact, clock)).toMatchObject({
            kind: 'paid',
          });
          expect(notifyOwner).toHaveBeenCalledTimes(3);

          // Suppressed invoices may outrank a live one. The candidate limit applies after
          // corroborating receipts, including when the next invoice is on another page.
          const next = await addBillMail(
            'Invoice SYN-109: USD 17.00 is due on November 21, 2026.',
            at(32 * 60),
          );
          if (!activePulse || next.fact?.kind !== 'invoice')
            throw new Error('Missing open invoice');
          const afterSuppressed = await activePulse.actionableMail(agentId, {
            since: at(17 * 60),
            until: at(34 * 60),
            now: at(35 * 60),
            minImportance: 4,
            limit: 1,
          });
          expect(afterSuppressed.map((candidate) => candidate.channelMessageId)).toEqual([
            next.key,
          ]);

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
