import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { runBriefing } from '@assistant/core';
import {
  agents,
  conversations,
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
  type BriefingRunOutcome,
  type ExecutionPersistence,
  emailIngestReadable,
  notificationLeg,
  practiceChangeFromMail,
  type Records,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
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
import {
  deliveryMail,
  replayCardGrounded,
  replayCases,
  teacherMessages,
} from './proactive-replay-cases.js';
import {
  type ReplayTick,
  scoreReplayCase,
  scoreReplayKinds,
  writeReplayEvidence,
} from './proactive-replay-score.js';

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
      `replays calendar, mail, and bill signals on ${driver}`,
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
        const evidence: Record<string, Record<string, string | number | boolean | null>> = {};
        const ticks = new Map<string, ReplayTick[]>();
        const scores = () =>
          Object.values(replayCases)
            .filter(({ id }) => id !== replayCases.delivery.id || evidence[id])
            .map((definition) =>
              scoreReplayCase(
                definition,
                ticks.get(definition.id) ?? [],
                evidence[definition.id] ?? {},
              ),
            );
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
              unread?: true;
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
          const threadHeads = new Map<string, string>([['practice-thread', mailId]]);
          const provider = vi.fn(async (path: string) => {
            const id = /\/messages\/([^?]+)\?/.exec(path)?.[1];
            const fixture = id && fixtureMail.get(id);
            if (!fixture) throw new Error('Unexpected provider message');
            const { threadId, from, subject, body, at, unread } = fixture;
            return {
              id,
              threadId,
              internalDate: String(at.getTime()),
              labelIds: unread ? ['INBOX', 'UNREAD'] : ['INBOX'],
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
          const known = new Map<string, 'known'>([
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

          const notifyOwner = vi.fn(async (_input: { conversationId: string | null }) =>
            notificationLeg('push', 'delivered'),
          );
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
          const readParts = async () => {
            const conversationId = notifyOwner.mock.calls.at(-1)?.[0].conversationId;
            if (!conversationId) return [];
            return store
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
          };
          const readMessageParts = async (id: string): Promise<unknown[]> => {
            if (store) return (await store.doc('messages', id).get()).get('parts') ?? [];
            const [row] = await db
              .select({ parts: messages.parts })
              .from(messages)
              .where(eq(messages.id, id));
            return Array.isArray(row?.parts) ? row.parts : [];
          };
          const readLedger = async () =>
            store
              ? (
                  await store.collection('proactiveMoments').where('agentId', '==', agentId).get()
                ).docs.map((doc) => decodeRecord<Records['proactiveMoments']>(doc.data()))
              : await db
                  .select()
                  .from(proactiveMoments)
                  .where(eq(proactiveMoments.agentId, agentId));
          const countOwnerNotices = async () => {
            const firestore = store;
            if (firestore) {
              const threads = await firestore
                .collection('conversations')
                .where('agentId', '==', agentId)
                .get();
              const counts = await Promise.all(
                threads.docs.map((thread) =>
                  firestore
                    .collection('messages')
                    .where('conversationId', '==', thread.get('id'))
                    .where('role', '==', 'assistant')
                    .count()
                    .get(),
                ),
              );
              return counts.reduce((total, count) => total + count.data().count, 0);
            }
            return (
              await db
                .select({ id: messages.id })
                .from(messages)
                .innerJoin(conversations, eq(messages.conversationId, conversations.id))
                .where(and(eq(conversations.agentId, agentId), eq(messages.role, 'assistant')))
            ).length;
          };
          const observe = async <
            T extends {
              delivered: string | null | boolean;
              pinged: boolean;
              outcome?: BriefingRunOutcome;
              mailScanned?: number;
            },
          >(
            caseId: string,
            name: string,
            sourceAt: Date,
            sourceMomentKey: string | null,
            producer: () => Promise<T>,
          ) => {
            const before = new Set((await readLedger()).map((moment) => moment.momentKey));
            const callCount = notifyOwner.mock.calls.length;
            const noticeCount = await countOwnerNotices();
            const result = await producer();
            const parts = (
              result.mailScanned === undefined
                ? (await readParts()).flat()
                : result.outcome?.kind === 'delivered'
                  ? await readMessageParts(result.outcome.messageId)
                  : []
            ) as Array<{
              type?: string;
              data?: Parameters<typeof replayCardGrounded>[1];
            }>;
            const elapsed = (at: Date) => (at.getTime() - sourceAt.getTime()) / 60_000;
            const observations = ticks.get(caseId) ?? [];
            observations.push({
              name,
              elapsedMinutes: elapsed(clock),
              ...(result.mailScanned !== undefined && {
                briefing: {
                  outcome: result.outcome?.kind ?? null,
                  mailScanned: result.mailScanned,
                },
              }),
              candidates:
                'candidates' in result && typeof result.candidates === 'number'
                  ? result.candidates
                  : null,
              selected:
                typeof result.delivered === 'string'
                  ? result.delivered
                  : result.delivered
                    ? 'briefing'
                    : null,
              reason:
                'heldBy' in result && typeof result.heldBy === 'string'
                  ? result.heldBy
                  : result.delivered === false
                    ? 'quiet-briefing'
                    : null,
              moments: (await readLedger())
                .filter((moment) => !before.has(moment.momentKey))
                .map((moment) => {
                  const card = parts.find(
                    (part) =>
                      part.type === 'data-card' &&
                      part.data?.kind === 'proactive-alert' &&
                      part.data.id === moment.momentKey,
                  )?.data;
                  return {
                    kind: moment.kind,
                    exactSource: moment.momentKey === sourceMomentKey,
                    elapsedMinutes: elapsed(moment.deliveredAt),
                    durableCard: card !== undefined,
                    durablePushAcknowledged: moment.pinged,
                    groundedCard: card !== undefined && replayCardGrounded(caseId, card, name),
                  };
                })
                .sort(
                  (a, b) => a.kind.localeCompare(b.kind) || a.elapsedMinutes - b.elapsedMinutes,
                ),
              ownerNotices: (await countOwnerNotices()) - noticeCount,
              pushSinkCalls: notifyOwner.mock.calls.length - callCount,
              pushAcknowledged: result.pinged,
            });
            ticks.set(caseId, observations);
            return result;
          };
          const practiceId = replayCases.practice.id;
          const cancellationId = replayCases.cancellation.id;
          const billId = replayCases.bill.id;
          const controlId = replayCases.control.id;
          const practice = practiceChangeFromMail(ingest);
          evidence[practiceId] = {
            eligible: emailIngestReadable(ingest),
            pipelineStage: ingest.pipelineStage,
            projectedStart: practice?.iso ?? null,
            projectedPreviousStart: practice?.previousIso ?? null,
            field: practice?.practiceField ?? null,
          };
          clock = at(19);
          expect(
            await observe(practiceId, 'change received', RECEIVED, `mail-action:${sourceKey}`, () =>
              runPulse(pulseDeps, { agentId, now: clock }),
            ),
          ).toMatchObject({
            candidates: 1,
            delivered: 'practice-change',
            pinged: true,
          });
          expect(clock.getTime() - RECEIVED.getTime()).toBeLessThanOrEqual(60 * 60_000);
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
          const replayAdmission = await replayMail();
          evidence[practiceId].replayAdmission = replayAdmission;
          expect(replayAdmission).toBe('skipped');
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
            await observe(practiceId, 'source replay', RECEIVED, null, () =>
              runPulse({ ...pulseDeps, calendarReader }, { agentId, now: clock }),
            ),
          ).toMatchObject({
            delivered: null,
            heldBy: 'no-candidates',
          });
          clock = at(16 * 60);
          const briefing = await observe(practiceId, 'morning briefing', RECEIVED, null, () =>
            runBriefing(
              {
                db,
                ...(driver === 'firestore' ? { persistence } : {}),
                router: forbidden('briefing model calls'),
                notifyOwner,
              },
              { agentId, now: clock },
            ),
          );
          expect(briefing).toMatchObject({ delivered: false, highlights: 0, upcoming: 0 });
          expect(notifyOwner).toHaveBeenCalledOnce();
          expect(await readParts()).toEqual(parts);

          const cancelledAt = at(16 * 60 + 1);
          calendarEvent = { ...calendarEvent, status: 'cancelled' };
          evidence[cancellationId] = { providerStatus: calendarEvent.status };
          clock = at(16 * 60 + 20);
          expect(
            await observe(
              cancellationId,
              'explicit calendar cancellation',
              cancelledAt,
              `calendar-cancelled:${calendarEvent.calendarId}:${calendarEvent.eventId}`,
              () => runPulse({ ...pulseDeps, calendarReader }, { agentId, now: clock }),
            ),
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
          const addBillMail = async (
            body: string,
            receivedAt: Date,
            subject = 'Fixture utility account',
          ) => {
            const id = randomUUID();
            const threadId = `billing-${id}`;
            fixtureMail.set(id, {
              threadId,
              from: issuer,
              subject,
              body,
              at: receivedAt,
            });
            threadHeads.set(threadId, id);
            expect(await acceptMail(id)).toBe('triaged');
            const key = `gmail:${id}`;
            const row = await readIngest(key);
            await setIngestClock(row.id, receivedAt);
            expect(row).toMatchObject({
              channelMessageId: key,
              providerMessageId: id,
              providerThreadId: threadId,
              providerReceivedAt: receivedAt,
            });
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
          const due = await billStatus(agentId, invoice.fact, clock);
          evidence[billId] = {
            beforePayment: due.kind,
            invoiceId: invoice.fact.invoiceId,
            amountMinor: invoice.fact.amountMinor,
          };
          expect(due).toEqual({ kind: 'due' });
          expect(
            await observe(
              billId,
              'bill due',
              at(18 * 60),
              `bill-due:${invoice.fact.identity}`,
              () => runPulse(pulseDeps, { agentId, now: clock }),
            ),
          ).toMatchObject({
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
          const afterWrongReceipt = await billStatus(agentId, invoice.fact, clock);
          evidence[billId].afterWrongReceipt = afterWrongReceipt.kind;
          expect(afterWrongReceipt).toEqual({ kind: 'due' });
          const receipt = await addBillMail(
            'Payment received in full for invoice SYN-104: USD 42.15. Balance due: USD 0.00.',
            clock,
          );
          expect(receipt.fact).toMatchObject({
            kind: 'paid-in-full',
            identity: invoice.fact.identity,
          });
          expect(await acceptMail(receipt.id)).toBe('skipped');
          const afterPayment = await billStatus(agentId, invoice.fact, clock);
          evidence[billId].afterPayment = afterPayment.kind;
          evidence[billId].exactReceipt =
            afterPayment.kind === 'paid' && afterPayment.sourceKey === receipt.key;
          expect(afterPayment).toEqual({
            kind: 'paid',
            sourceKey: receipt.key,
          });

          clock = at(23 * 60 + 20);
          expect(
            await observe(billId, 'paid pulse', at(22 * 60 + 5), null, () =>
              runPulse(pulseDeps, { agentId, now: clock }),
            ),
          ).toMatchObject({
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
          expect(
            await observe(billId, 'out-of-order paid pulse', at(24 * 60 + 10), null, () =>
              runPulse(pulseDeps, { agentId, now: clock }),
            ),
          ).toMatchObject({
            candidates: 0,
            delivered: null,
          });
          expect(notifyOwner).toHaveBeenCalledTimes(3);

          const morningAfterPayment = await observe(
            billId,
            'paid morning briefing',
            at(22 * 60 + 5),
            null,
            () =>
              runBriefing(
                {
                  db,
                  ...(driver === 'firestore' ? { persistence } : {}),
                  router: forbidden('post-payment model calls'),
                  notifyOwner,
                },
                { agentId, now: clock },
              ),
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
          const race = await observe(billId, 'payment wins admission race', at(29 * 60), null, () =>
            runPulse(
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
            ),
          );
          expect(race).toMatchObject({ candidates: 1, delivered: null, heldBy: 'stale-source' });
          expect(await billStatus(agentId, racingInvoice.fact, clock)).toMatchObject({
            kind: 'paid',
          });
          expect(notifyOwner).toHaveBeenCalledTimes(3);

          const genericId = randomUUID();
          const genericThread = 'generic-control-thread';
          const genericAt = at(33 * 60 + 1);
          fixtureMail.set(genericId, {
            threadId: genericThread,
            from: SENDER,
            subject: 'Confirm volunteer roster',
            body: 'Please confirm that you can staff the front desk this weekend.',
            at: genericAt,
          });
          threadHeads.set(genericThread, genericId);
          const scriptedScore = vi.fn(async () => ({
            ok: true,
            object: {
              category: 'personal',
              actionable: true,
              importance: 4,
              dates: [],
              reason: 'Synthetic control',
            },
          }));
          const genericDeps = {
            ...deps,
            router: { object: scriptedScore } as unknown as EmailSyncDeps['router'],
          };
          const ingestGeneric = () =>
            processMessage(genericDeps, agentId, owner.email, known, genericId);
          expect(await ingestGeneric()).toBe('triaged');
          const genericKey = `gmail:${genericId}`;
          const genericRow = await readIngest(genericKey);
          await setIngestClock(genericRow.id, genericAt);
          evidence[controlId] = {
            eligible: emailIngestReadable(genericRow),
            scriptedScores: scriptedScore.mock.calls.length,
          };
          clock = at(35 * 60);
          await observe(controlId, 'before minimum source age', genericAt, null, () =>
            runPulse(pulseDeps, { agentId, now: clock }),
          );
          clock = at(37 * 60);
          let wrongHeadReads = 0;
          await observe(controlId, 'wrong thread head', genericAt, null, () =>
            runPulse(
              {
                ...pulseDeps,
                emailThreadReader: async ({ threadId }) => {
                  if (threadId !== genericThread) return pulseDeps.emailThreadReader({ threadId });
                  wrongHeadReads++;
                  return {
                    threadId: 'unrelated-thread',
                    latestMessageId: genericId,
                    latestReceivedAt: genericAt,
                  };
                },
              },
              { agentId, now: clock },
            ),
          );
          evidence[controlId].wrongHeadReads = wrongHeadReads;
          await observe(
            controlId,
            'matching thread head',
            genericAt,
            `mail-action:${genericKey}`,
            () => runPulse(pulseDeps, { agentId, now: clock }),
          );
          expect(await ingestGeneric()).toBe('skipped');
          clock = at(39 * 60);
          await observe(controlId, 'generic source replay', genericAt, null, () =>
            runPulse(pulseDeps, { agentId, now: clock }),
          );

          // Existing paid sources must not block a different open invoice.
          const next = await addBillMail(
            'Invoice SYN-109: USD 17.00 is due on November 21, 2026.',
            at(32 * 60),
          );
          if (next.fact?.kind !== 'invoice') throw new Error('Missing open invoice');
          const openInvoiceKey = `bill-due:${next.fact.identity}`;
          expect(await runPulse(pulseDeps, { agentId, now: clock })).toMatchObject({
            delivered: 'bill-due',
            pinged: true,
          });
          expect(await readLedger()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: 'bill-due',
                momentKey: openInvoiceKey,
                pinged: true,
              }),
            ]),
          );
          expect((await readParts()).flat()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'data-card',
                data: expect.objectContaining({
                  id: openInvoiceKey,
                  title: 'Invoice SYN-109',
                  summary: '$17.00 due on November 21, 2026.',
                }),
              }),
            ]),
          );

          const teacherCase = replayCases.teachers.id;
          const teacherAt = at(55 * 60);
          clock = teacherAt;
          scriptedScore.mockClear();
          const teacherSources = [];
          for (const [index, teacher] of teacherMessages.entries()) {
            const id = `teacher-${index}-${randomUUID()}`;
            const threadId = `thread-${id}`;
            const from = `teacher-${index}@example.test`;
            known.set(from, 'known');
            fixtureMail.set(id, {
              threadId,
              from,
              subject: teacher.subject,
              body: `Please complete this school request: ${teacher.subject}.`,
              at: teacherAt,
              unread: true,
            });
            threadHeads.set(threadId, id);
            expect(await processMessage(genericDeps, agentId, owner.email, known, id)).toBe(
              'triaged',
            );
            const key = `gmail:${id}`;
            const row = await readIngest(key);
            expect(row).toMatchObject({
              providerMessageId: id,
              providerThreadId: threadId,
              providerReceivedAt: teacherAt,
              channelMessageId: key,
              subject: teacher.subject,
            });
            expect(emailIngestReadable(row)).toBe(true);
            await setIngestClock(row.id, teacherAt);
            teacherSources.push({ id, key, tick: teacher.tick });
          }
          evidence[teacherCase] = {
            unreadSourceCount: teacherSources.filter(({ id }) => fixtureMail.get(id)?.unread)
              .length,
            scriptedScores: scriptedScore.mock.calls.length,
          };
          clock = at(57 * 60);
          await observe(teacherCase, 'before the next morning', teacherAt, null, () =>
            runPulse(pulseDeps, { agentId, now: clock }),
          );
          for (const [index, source] of teacherSources.entries()) {
            clock = at(63 * 60 + 65 * index);
            await observe(teacherCase, source.tick, teacherAt, `mail-action:${source.key}`, () =>
              runPulse(pulseDeps, { agentId, now: clock }),
            );
            expect(await processMessage(genericDeps, agentId, owner.email, known, source.id)).toBe(
              'skipped',
            );
          }
          // The last source is younger than 12 hours and the 60-minute pulse gap has elapsed.
          clock = at(66 * 60 + 15);
          await observe(teacherCase, 'teacher mail replay', teacherAt, null, () =>
            runPulse(pulseDeps, { agentId, now: clock }),
          );

          const billLeadCase = replayCases.billLeadTime.id;
          const phoneAt = at(90 * 60);
          const tollAt = at(114 * 60);
          clock = phoneAt;
          const phone = await addBillMail(
            'Invoice SYN-PHONE: USD 39.00 is due on December 6, 2026.',
            phoneAt,
            'Phone bill ready',
          );
          if (phone.fact?.kind !== 'invoice') throw new Error('Missing phone bill source');
          clock = at(94 * 60);
          await observe(
            billLeadCase,
            'phone bill before the reminder day',
            phoneAt,
            `bill-due:${phone.fact.identity}`,
            () => runPulse(pulseDeps, { agentId, now: clock }),
          );
          clock = tollAt;
          const toll = await addBillMail(
            'Invoice SYN-TOLL: USD 11.00 is due on December 7, 2026.',
            tollAt,
            'Electronic toll statement',
          );
          if (toll.fact?.kind !== 'invoice') throw new Error('Missing toll statement source');
          clock = at(118 * 60);
          await observe(
            billLeadCase,
            'toll bill before the reminder day',
            tollAt,
            `bill-due:${toll.fact.identity}`,
            () => runPulse(pulseDeps, { agentId, now: clock }),
          );
          const observedBillFacts = {
            phoneInvoiceSource:
              phone.fact.invoiceId === 'SYN-PHONE' && phone.fact.dueDate === '2026-12-06',
            tollInvoiceSource:
              toll.fact.invoiceId === 'SYN-TOLL' && toll.fact.dueDate === '2026-12-07',
            phoneDueAtWindow: false,
            tollDueAtWindow: false,
            sameDayInvoiceSource: false,
          };
          const elevenDays = 11 * 24 * 60;
          clock = at(90 * 60 + elevenDays);
          observedBillFacts.phoneDueAtWindow =
            (await billStatus(agentId, phone.fact, clock)).kind === 'due';
          await observe(
            billLeadCase,
            'phone bill reminder at T-3',
            phoneAt,
            `bill-due:${phone.fact.identity}`,
            () => runPulse(pulseDeps, { agentId, now: clock }),
          );
          clock = at(114 * 60 + elevenDays);
          observedBillFacts.tollDueAtWindow =
            (await billStatus(agentId, toll.fact, clock)).kind === 'due';
          await observe(
            billLeadCase,
            'toll bill reminder at T-3',
            tollAt,
            `bill-due:${toll.fact.identity}`,
            () => runPulse(pulseDeps, { agentId, now: clock }),
          );
          const dueTodayAt = at(90 * 60 + 14 * 24 * 60);
          clock = dueTodayAt;
          const dueToday = await addBillMail(
            'Invoice SYN-TODAY: USD 28.00 is due on December 6, 2026.',
            dueTodayAt,
            'Bill due today',
          );
          if (dueToday.fact?.kind !== 'invoice') throw new Error('Missing same-day bill source');
          observedBillFacts.sameDayInvoiceSource =
            dueToday.fact.invoiceId === 'SYN-TODAY' && dueToday.fact.dueDate === '2026-12-06';
          evidence[billLeadCase] = observedBillFacts;
          expect(observedBillFacts).toEqual(replayCases.billLeadTime.facts);
          clock = new Date(dueTodayAt.getTime() + 4 * 60 * 60_000);
          await observe(
            billLeadCase,
            'late-arriving bill due today',
            dueTodayAt,
            `bill-due:${dueToday.fact.identity}`,
            () => runPulse(pulseDeps, { agentId, now: clock }),
          );
          // The same-day control must still work. S13's catalog-level lead-time outcome
          // remains a measurement so a fix can turn a recorded miss into a pass.
          const sameDay = scores().find(({ id }) => id === billLeadCase);
          expect(sameDay).toMatchObject({ setupExpected: 1, setupMatches: 1, setupDeliveries: 1 });
          expect(
            sameDay?.findings.filter((finding) => finding.startsWith('late-arriving bill')),
          ).toEqual([]);

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
          const deliveryId = replayCases.delivery.id;
          const deliveryScore = vi.fn(async () => ({
            ok: true,
            object: {
              category: 'transactional',
              actionable: false,
              importance: 3,
              dates: [],
              reason: 'Synthetic store delivery status',
            },
          }));
          const deliveryDeps = {
            ...deps,
            router: { object: deliveryScore } as unknown as EmailSyncDeps['router'],
          };
          known.set(deliveryMail.from, 'known');
          const admitDeliveryMail = async (mail: typeof deliveryMail.original) => {
            const id = randomUUID();
            const receivedAt = new Date(mail.receivedAt);
            clock = receivedAt;
            fixtureMail.set(id, {
              threadId: deliveryMail.threadId,
              from: deliveryMail.from,
              subject: mail.subject,
              body: mail.body,
              at: receivedAt,
            });
            threadHeads.set(deliveryMail.threadId, id);
            expect(await processMessage(deliveryDeps, agentId, owner.email, known, id)).toBe(
              'triaged',
            );
            const key = `gmail:${id}`;
            const row = await readIngest(key);
            expect(row).toMatchObject({
              agentId,
              channelMessageId: key,
              providerMessageId: id,
              providerThreadId: deliveryMail.threadId,
              providerReceivedAt: receivedAt,
              fromEmail: deliveryMail.from,
              subject: mail.subject,
              authenticated: true,
              ingestMode: 'direct',
              pipelineStage: 'message_persisted',
              scoreOutcome: 'model_prepared',
              messagePersisted: true,
              admittedSourceKind: 'message',
            });
            expect(emailIngestReadable(row)).toBe(true);
            if (!row.admittedSourceId) throw new Error('Missing canonical delivery mail message');
            const [part] = await readMessageParts(row.admittedSourceId);
            const sourceText = (part as { type?: string; text?: string } | undefined)?.text;
            expect(part).toEqual({ type: 'text', text: mail.body });
            await setIngestClock(row.id, receivedAt);
            return { ...row, sourceText };
          };
          const originalMail = await admitDeliveryMail(deliveryMail.original);
          const updatedMail = await admitDeliveryMail(deliveryMail.replacement);
          expect(originalMail.conversationId).toBeTruthy();
          expect(updatedMail.conversationId).toBe(originalMail.conversationId);
          expect(updatedMail.admittedSourceId).not.toBe(originalMail.admittedSourceId);
          expect(deliveryScore).toHaveBeenCalledTimes(2);
          const replacementReceivedAt = updatedMail.providerReceivedAt;
          if (!replacementReceivedAt || !originalMail.providerReceivedAt)
            throw new Error('Missing delivery mail receipt timestamp');
          expect(replacementReceivedAt.getTime()).toBeGreaterThan(
            originalMail.providerReceivedAt.getTime(),
          );
          expect(
            await pulseDeps.emailThreadReader({ threadId: deliveryMail.threadId }),
          ).toMatchObject({
            latestMessageId: updatedMail.providerMessageId,
            latestReceivedAt: replacementReceivedAt,
          });
          const sweepDeliveryMorning = (tick: string, sourceMomentKey: string | null) =>
            observe(deliveryId, tick, replacementReceivedAt, sourceMomentKey, () =>
              runBriefing(
                {
                  db,
                  ...(driver === 'firestore' ? { persistence } : {}),
                  router: {
                    object: async () => ({
                      ok: true,
                      object: { lead: "Here's your morning update." },
                    }),
                  } as unknown as Parameters<typeof runBriefing>[0]['router'],
                  notifyOwner,
                },
                { agentId, now: clock },
              ),
            );
          clock = new Date(deliveryMail.original.sweepAt);
          const originalSweepAt = clock.toISOString();
          const originalSweep = await sweepDeliveryMorning('original delivery date morning', null);
          clock = new Date(deliveryMail.replacement.sweepAt);
          const revisedSweepAt = clock.toISOString();
          const revisedSweep = await sweepDeliveryMorning(
            'revised delivery date morning',
            `delivery-today:${updatedMail.channelMessageId}`,
          );
          const ownerLocalTime = new Intl.DateTimeFormat('sv-SE', {
            timeZone: owner.timezone,
            dateStyle: 'short',
            timeStyle: 'short',
          });
          expect(ownerLocalTime.format(new Date(originalSweepAt))).toBe(
            `${deliveryMail.original.date} 08:05`,
          );
          expect(ownerLocalTime.format(new Date(revisedSweepAt))).toBe(
            `${deliveryMail.replacement.date} 08:05`,
          );
          for (const sweep of [originalSweep, revisedSweep])
            expect(['quiet', 'delivered']).toContain(sweep.outcome?.kind);
          const deliveryFacts = {
            originalReceivedAt: originalMail.providerReceivedAt.toISOString(),
            replacementReceivedAt: replacementReceivedAt.toISOString(),
            originalSweepAt,
            revisedSweepAt,
            originalMailScanned: originalSweep.mailScanned,
            revisedMailScanned: revisedSweep.mailScanned,
            authenticatedReplacement: updatedMail.authenticated,
            shipmentThread: updatedMail.providerThreadId,
            originalSourceText: originalMail.sourceText ?? null,
            replacementSourceText: updatedMail.sourceText ?? null,
          };
          expect(deliveryFacts).toEqual(replayCases.delivery.facts);
          evidence[deliveryId] = deliveryFacts;
          const scored = scores();
          expect(
            scored.filter(({ passed, id }) => !passed && id !== billLeadCase && id !== deliveryId),
          ).toEqual([]);
          expect(scoreReplayKinds(scored.filter(({ id }) => id === cancellationId))).toMatchObject([
            {
              kind: 'calendar-cancelled',
              expected: 1,
              delivered: 1,
              matched: 1,
              recall: 1,
              precision: 1,
              expectations: [{ earliestMinutes: 0, latestMinutes: 20, credit: 1 }],
              observedTiming: [{ elapsedMinutes: 19 }],
            },
          ]);
          const paid = scored.filter(({ id }) => id === billId);
          expect(scoreReplayKinds(paid)).toEqual([]);
          expect(paid).toMatchObject([
            {
              sourceEvidence: {
                beforePayment: 'due',
                afterWrongReceipt: 'due',
                afterPayment: 'paid',
                exactReceipt: true,
              },
              quietViolations: 0,
              quietChecks: [
                'paid pulse',
                'out-of-order paid pulse',
                'paid morning briefing',
                'payment wins admission race',
              ].map((tick) => ({ tick, observations: 1, violations: 0 })),
            },
          ]);
        } finally {
          try {
            writeReplayEvidence(driver, scores());
          } finally {
            if (store) await disposeStore(store);
            else await closeSql?.();
          }
        }
      },
      90_000,
    );
  }
});
