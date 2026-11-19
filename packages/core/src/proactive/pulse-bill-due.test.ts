import { randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  type Db,
  emailIngest,
  messages,
  proactiveMoments,
  suggestions,
} from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { extractBillEmailEvidence } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../firestore/src/test-store.js';
import { buildEmailContentProvenance } from '../email-provenance.js';
import { type PulseDeps, runPulse } from './pulse.js';

const RECEIVED = new Date('2026-11-22T17:01:00Z');
const EARLY = new Date('2026-11-22T21:01:00Z');
const LOCAL_T_MINUS_THREE = new Date('2026-12-03T08:00:00Z');
const FIXTURE_ISSUER = 'bill@example.test';
const SPACE = { provider: 'synthetic', model: 'bill-due', dimensions: 1536, revision: '1' };

for (const driver of ['postgres', 'firestore'] as const) {
  describe.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${driver} bill due dates`,
    () => {
      let db: Db | undefined;
      let store: InstallationStore | undefined;
      let agentId: string;
      let conversationId: string;
      const threads = new Map<
        string,
        { threadId: string; latestMessageId: string; latestReceivedAt: Date }
      >();

      beforeEach(async () => {
        agentId = randomUUID();
        conversationId = randomUUID();
        threads.clear();
        const owner = {
          id: agentId,
          name: 'Bill fixture',
          email: `${agentId}@example.test`,
          workspacePrefix: `bill/${agentId}`,
          timezone: 'America/Los_Angeles',
        };
        if (driver === 'postgres') {
          const databaseUrl = process.env.TEST_DATABASE_URL;
          if (
            !databaseUrl ||
            !process.env.ASSISTANT_TEST_TARGET_TOKEN ||
            process.env.NODE_ENV === 'production'
          )
            throw new Error('A disposable PostgreSQL target is required');
          db = createDb(databaseUrl);
          await db.insert(agents).values(owner);
          await db.insert(conversations).values({
            id: conversationId,
            agentId,
            channel: 'chat',
            trust: 'owner',
            isPrimary: true,
          });
        } else {
          store = emulatorStore();
          await store.doc('agents', agentId).set(encodeRecord(owner));
        }
      });

      afterEach(async () => {
        if (store) {
          await disposeStore(store);
          store = undefined;
        }
        if (db) {
          await db.delete(suggestions).where(eq(suggestions.agentId, agentId));
          await db.delete(messages).where(eq(messages.conversationId, conversationId));
          await db.delete(emailIngest).where(eq(emailIngest.agentId, agentId));
          await db.delete(conversations).where(eq(conversations.id, conversationId));
          await db.delete(agents).where(eq(agents.id, agentId));
          await db.$client.end();
          db = undefined;
        }
      });

      async function mail(
        body: string,
        receivedAt = RECEIVED,
        overrides: Partial<typeof emailIngest.$inferInsert> = {},
      ) {
        const id = randomUUID();
        const threadId = `thread-${id}`;
        const provenance = buildEmailContentProvenance({
          subject: 'Synthetic billing mail',
          fullBody: body,
          storedBody: body,
          messagePrefix: '',
          mode: 'direct',
          authenticated: true,
          parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
        });
        const billEvidence = extractBillEmailEvidence({
          agentId,
          issuer: FIXTURE_ISSUER,
          body,
          provenance,
        });
        const row = {
          id,
          agentId,
          conversationId,
          channelMessageId: `gmail:${id}`,
          providerMessageId: id,
          providerThreadId: threadId,
          providerReceivedAt: receivedAt,
          fromEmail: FIXTURE_ISSUER,
          fromName: 'Billing fixture',
          subject: 'Synthetic billing mail',
          category: 'personal',
          importance: 5,
          actionable: true,
          contentTrust: 'known' as const,
          ingestMode: 'direct' as const,
          authenticated: true,
          admittedSourceKind: 'automated_source' as const,
          emailContentProvenance: provenance,
          admittedSourceId: `source-${id}`,
          hasExternalOrUnknown: false,
          billEvidence,
          obligationStatus: 'unknown',
          obligationVersion: 0,
          pipelineStage: 'complete',
          createdAt: receivedAt,
          updatedAt: receivedAt,
          ...overrides,
        };
        threads.set(threadId, { threadId, latestMessageId: id, latestReceivedAt: receivedAt });
        if (db) await db.insert(emailIngest).values(row);
        else if (store) await store.doc('emailIngest', id).set(encodeRecord(row));
        else throw new Error('Missing fixture store');
        return billEvidence;
      }

      function pulse(now: Date) {
        const emailThreadReader: NonNullable<PulseDeps['emailThreadReader']> = async ({
          threadId,
        }) => threads.get(threadId) ?? null;
        if (store) {
          return runPulse(
            {
              db: undefined as unknown as Db,
              persistence: createFirestoreExecutionPersistence(store, agentId, SPACE),
              emailThreadReader,
            },
            { agentId, now },
          );
        }
        if (!db) throw new Error('Missing fixture database');
        return runPulse({ db, emailThreadReader }, { agentId, now });
      }

      async function momentKeys() {
        if (db) {
          const rows = await db
            .select()
            .from(proactiveMoments)
            .where(eq(proactiveMoments.agentId, agentId));
          return rows.map((row) => row.momentKey);
        }
        if (!store) throw new Error('Missing fixture store');
        const rows = await store
          .collection('proactiveMoments')
          .where('agentId', '==', agentId)
          .get();
        return rows.docs.map((row) => row.get('momentKey'));
      }

      async function noticeParts() {
        if (db) {
          const rows = await db
            .select({ parts: messages.parts })
            .from(messages)
            .where(eq(messages.conversationId, conversationId));
          return rows.flatMap((row) => row.parts as unknown[]);
        }
        if (!store) throw new Error('Missing fixture store');
        const rows = await store.collection('messages').get();
        return rows.docs.flatMap((doc) => doc.get('parts') as unknown[]);
      }

      it('does not surface a far-future invoice through the ordinary mail window', async () => {
        await mail('Invoice EARLY-100: USD 42.15 is due on December 6, 2026.');
        expect(await pulse(EARLY)).toMatchObject({ delivered: null, candidates: 0 });
        expect(await momentKeys()).toEqual([]);
      });

      it('finds an older unpaid invoice on the owner local T−3 date and admits it once', async () => {
        const fact = await mail('Invoice OLD-100: USD 42.15 is due on December 6, 2026.');
        expect(fact).toMatchObject({ kind: 'invoice', dueDate: '2026-12-06' });
        expect(await pulse(new Date(LOCAL_T_MINUS_THREE.getTime() - 60_000))).toMatchObject({
          delivered: null,
          candidates: 0,
        });
        expect(await pulse(LOCAL_T_MINUS_THREE)).toMatchObject({
          delivered: 'bill-due',
          suggested: false,
        });
        expect(await noticeParts()).toContainEqual(
          expect.objectContaining({
            type: 'data-card',
            data: expect.objectContaining({ title: 'Invoice OLD-100', urgencyLabel: 'Bill due' }),
          }),
        );
        expect(await pulse(new Date(LOCAL_T_MINUS_THREE.getTime() + 2 * 3600_000))).toMatchObject({
          delivered: null,
          candidates: 0,
        });
        expect(await momentKeys()).toEqual([`bill-due:${fact?.identity}`]);
      });

      it('finds an invoice that arrives on its due day after the initial mail hold', async () => {
        const received = new Date('2026-12-06T17:01:00Z');
        await mail('Invoice DAY-100: USD 42.15 is due on December 6, 2026.', received);
        expect(await pulse(new Date('2026-12-06T19:01:00Z'))).toMatchObject({
          delivered: null,
          candidates: 0,
        });
        expect(await pulse(new Date('2026-12-06T21:01:00Z'))).toMatchObject({
          delivered: 'bill-due',
          suggested: false,
        });
      });

      it('discovers an overdue bill but stays quiet on closed, paid, muted, snoozed and conflicting records', async () => {
        const overdue = await mail('Invoice OLD-200: USD 12.34 is due on December 2, 2026.');
        await mail('Invoice OLD-201: USD 12.34 is due on December 2, 2026.', RECEIVED, {
          obligationStatus: 'resolved',
          obligationDecision: 'resolve',
        });
        await mail('Invoice OLD-202: USD 12.34 is due on December 2, 2026.');
        await mail(
          'Payment received in full for invoice OLD-202: USD 12.34. Balance due: USD 0.00.',
        );
        await mail('Invoice OLD-203: USD 12.34 is due on December 2, 2026.', RECEIVED, {
          actionable: false,
        });
        await mail('Invoice OLD-204: USD 12.34 is due on December 2, 2026.', RECEIVED, {
          obligationStatus: 'snoozed',
          obligationDecision: 'snooze',
          obligationSnoozedUntil: new Date('2026-12-08T08:00:00Z'),
        });
        await mail('Invoice OLD-205: USD 12.34 is due on December 2, 2026.');
        await mail(
          'Payment received in full for invoice OLD-205: USD 14.50. Balance due: USD 0.00.',
        );
        expect(await pulse(LOCAL_T_MINUS_THREE)).toMatchObject({
          delivered: 'bill-due',
          candidates: 1,
        });
        expect(await noticeParts()).toContainEqual(
          expect.objectContaining({
            type: 'data-card',
            data: expect.objectContaining({
              title: 'Invoice OLD-200',
              urgencyLabel: 'Bill overdue',
            }),
          }),
        );
        expect(await pulse(new Date(LOCAL_T_MINUS_THREE.getTime() + 2 * 3600_000))).toMatchObject({
          delivered: null,
          candidates: 0,
        });
        expect(await momentKeys()).toEqual([`bill-due:${overdue?.identity}`]);
      });

      it('preserves the three-to-twelve-hour window for ordinary actionable mail', async () => {
        await mail('No admitted bill evidence.', RECEIVED);
        expect(await pulse(new Date(RECEIVED.getTime() + 2 * 3600_000))).toMatchObject({
          delivered: null,
        });
        expect(await pulse(EARLY)).toMatchObject({ delivered: 'mail-action' });
        await mail('Another ordinary message.', RECEIVED);
        expect(await pulse(new Date(RECEIVED.getTime() + 13 * 3600_000))).toMatchObject({
          delivered: null,
          candidates: 0,
        });
      });
    },
  );
}
