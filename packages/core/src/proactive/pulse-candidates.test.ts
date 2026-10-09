import { randomUUID } from 'node:crypto';
import {
  agents,
  commitments,
  conversations,
  createDb,
  createPostgresEmailSyncRepository,
  type Db,
  emailIngest,
  proactiveMoments,
  tasks as taskTable,
} from '@assistant/db';
import { FirestoreEmailSyncRepository, FirestorePulseRepository } from '@assistant/firestore';
import { commitmentDueMomentKey, type PulseRepository } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../firestore/src/test-store.js';
import { postgresPulseRepository } from './pulse.js';

const now = new Date('2026-10-07T12:00:00.000Z');
const hour = 3_600_000;
const dueAt = new Date(now.getTime() + hour);

for (const backend of ['postgres', 'firestore'] as const) {
  describe.skipIf(backend === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${backend} pulse candidate recovery`,
    () => {
      let agentId: string;
      let conversationId: string;
      let db: Db | undefined;
      let store: InstallationStore | undefined;
      let repo: PulseRepository;
      let emailRepo:
        | ReturnType<typeof createPostgresEmailSyncRepository>
        | FirestoreEmailSyncRepository;

      beforeEach(async () => {
        agentId = randomUUID();
        conversationId = randomUUID();
        if (backend === 'postgres') {
          const databaseUrl = process.env.TEST_DATABASE_URL;
          if (!databaseUrl) throw new Error('An allocated test database is required');
          db = createDb(databaseUrl);
          await db.insert(agents).values({
            id: agentId,
            name: 'Pulse fixture',
            email: `${agentId}@example.test`,
            workspacePrefix: `pulse/${agentId}`,
          });
          await db
            .insert(conversations)
            .values({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
          repo = postgresPulseRepository(db);
          emailRepo = createPostgresEmailSyncRepository(db, agentId);
        } else {
          store = emulatorStore();
          repo = new FirestorePulseRepository(store);
          await store.doc('agents', agentId).set(
            encodeRecord({
              id: agentId,
              name: 'Pulse fixture',
              email: `${agentId}@example.test`,
            }),
          );
          emailRepo = new FirestoreEmailSyncRepository(store, agentId);
        }
      });
      afterEach(async () => {
        if (store) {
          await disposeStore(store);
          store = undefined;
        }
        if (db) {
          await db.delete(taskTable).where(eq(taskTable.agentId, agentId));
          await db.delete(emailIngest).where(eq(emailIngest.agentId, agentId));
          await db.delete(commitments).where(eq(commitments.agentId, agentId));
          await db.delete(proactiveMoments).where(eq(proactiveMoments.agentId, agentId));
          await db.delete(conversations).where(eq(conversations.id, conversationId));
          await db.delete(agents).where(eq(agents.id, agentId));
          await db.$client.end();
          db = undefined;
        }
      });
      async function said(key: string) {
        const row = {
          id: randomUUID(),
          agentId,
          kind: key.startsWith('mail') ? 'mail-action' : 'commitment-due',
          momentKey: key,
          summary: 'Already admitted',
          pinged: false,
          deliveredAt: new Date(now.getTime() - 2 * hour),
        };
        if (db) await db.insert(proactiveMoments).values(row);
        else if (store) await store.doc('proactiveMoments', row.id).set(encodeRecord(row));
      }
      async function mail(index: number, admitted = false, importance = 5) {
        const row = {
          id: randomUUID(),
          agentId,
          conversationId,
          channelMessageId: `${agentId}:gmail:${index}`,
          providerMessageId: `provider-${index}`,
          providerThreadId: `thread-${index}`,
          providerReceivedAt: new Date(now.getTime() - 2 * hour),
          obligationStatus: 'unknown',
          obligationVersion: 0,
          fromEmail: 'sender@example.test',
          fromName: 'Sender',
          subject: `Action ${index}`,
          category: 'personal',
          importance,
          actionable: true,
          pipelineStage: 'complete',
          createdAt: new Date(now.getTime() - 2 * hour),
          updatedAt: now,
        };
        if (db) await db.insert(emailIngest).values(row);
        else if (store) await store.doc('emailIngest', row.id).set(encodeRecord(row));
        if (admitted) await said(`mail-action:${row.channelMessageId}`);
        return row;
      }
      async function lifecycleMail(messageId: string, threadId: string, receivedAt: Date) {
        const row = {
          agentId,
          conversationId,
          channelMessageId: `gmail:${messageId}`,
          mailbox: `${agentId}@example.test`,
          providerMessageId: messageId,
          providerThreadId: threadId,
          providerReceivedAt: receivedAt,
          fromEmail: 'sender@example.test',
          fromName: 'Sender',
          subject: `Subject ${messageId}`,
          contentTrust: 'known',
          authenticated: true,
          category: 'personal',
          importance: 5,
          actionable: true,
          reason: 'classifier candidate',
          dates: [],
          pipelineStage: 'complete',
          scoreStatus: 'prepared',
          cardCandidate: false,
          messagePersisted: true,
        } as const;
        const id = await emailRepo.recordIngest(row);
        if (db) {
          await db
            .update(emailIngest)
            .set({ createdAt: receivedAt })
            .where(eq(emailIngest.channelMessageId, row.channelMessageId));
        } else if (store && id) {
          await store.doc('emailIngest', id).update({ createdAt: receivedAt });
        }
        return row;
      }
      async function obligation(
        index: number,
        admitted = false,
        snoozed = false,
        extra: Record<string, unknown> = {},
      ) {
        const row = {
          id: randomUUID(),
          agentId,
          conversationId,
          kind: 'promise',
          title: `Promise ${index}`,
          nextAction: 'Review',
          contentHash: randomUUID(),
          status: snoozed ? 'snoozed' : 'open',
          snoozedUntil: snoozed ? new Date(now.getTime() - hour) : null,
          resolvedAt: null,
          dueAt,
          updatedAt: now,
          ...extra,
        };
        if (db) await db.insert(commitments).values(row);
        else if (store) await store.doc('commitments', row.id).set(encodeRecord(row));
        if (admitted) await said(commitmentDueMomentKey(row.id, row.dueAt));
        return row;
      }
      const mailWindow = {
        since: new Date(now.getTime() - 24 * hour),
        until: new Date(now.getTime() - hour),
        now,
        minImportance: 3,
        limit: 5,
      };
      const dueWindow = { now, until: new Date(now.getTime() + 2 * hour), limit: 5 };

      it('finds the sixth unannounced mail after five admitted higher-value items', async () => {
        for (let i = 0; i < 5; i++) await mail(i, true, 5);
        const fresh = await mail(5, false, 4);
        expect(await repo.actionableMail(agentId, mailWindow)).toMatchObject([
          { channelMessageId: fresh.channelMessageId },
        ]);
      });
      it('uses deterministic value and identity order, independent of insertion order', async () => {
        const rows = await Promise.all([mail(1), mail(2), mail(3, false, 4)]);
        const sorted = rows.sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
        expect(
          (await repo.actionableMail(agentId, mailWindow)).map((r) => r.channelMessageId),
        ).toEqual(sorted.map((r) => r.channelMessageId));
      });
      it('finds an elapsed snooze beyond previously admitted deadlines and admits a rescheduled occurrence', async () => {
        for (let i = 0; i < 5; i++) await obligation(i, true);
        const fresh = await obligation(5, false, true);
        expect((await repo.dueCommitments(agentId, dueWindow)).map((r) => r.id)).toEqual([
          fresh.id,
        ]);
        await said(commitmentDueMomentKey(fresh.id, fresh.dueAt));
        expect(await repo.dueCommitments(agentId, dueWindow)).toEqual([]);
        const changed = new Date(dueAt.getTime() + 1_234);
        if (db)
          await db.update(commitments).set({ dueAt: changed }).where(eq(commitments.id, fresh.id));
        else if (store) await store.doc('commitments', fresh.id).update({ dueAt: changed });
        expect(await repo.dueCommitments(agentId, dueWindow)).toMatchObject([
          { id: fresh.id, dueAt: changed },
        ]);
      });
      it('continues past a page of already announced mail', async () => {
        for (let i = 0; i < 101; i++) await mail(i, true);
        const fresh = await mail(102, false, 4);
        expect(
          (await repo.actionableMail(agentId, mailWindow)).map((r) => r.channelMessageId),
        ).toEqual([fresh.channelMessageId]);
      }, 60_000);
      it('does not interpret a completed triage task as resolution of the email obligation', async () => {
        const source = await mail(103, false, 5);
        const task = {
          id: randomUUID(),
          agentId,
          type: 'adhoc',
          status: 'done',
          externalEventId: source.channelMessageId,
          createdAt: now,
          updatedAt: now,
        };
        if (db) await db.insert(taskTable).values(task);
        else if (store) await store.doc('tasks', task.id).set(encodeRecord(task));

        expect(await repo.actionableMail(agentId, mailWindow)).toMatchObject([
          { channelMessageId: source.channelMessageId },
        ]);
      });
      it('keeps the source obligation independent of task status and fences owner actions by source and revision', async () => {
        const source = await lifecycleMail('hc09-a', 'thread-a', new Date(now.getTime() - hour));
        const ownerDecision = await emailRepo.decideEmailObligation({
          channelMessageId: source.channelMessageId,
          expectedVersion: 0,
          decision: 'confirm_open',
          now,
        });
        expect(ownerDecision).toBe(true);
        expect(
          await emailRepo.decideEmailObligation({
            channelMessageId: source.channelMessageId,
            expectedVersion: 0,
            decision: 'resolve',
            now,
          }),
        ).toBe(false);
        expect(
          (await emailRepo.listEmailObligations(now)).map((row) => row.obligationStatus),
        ).toEqual(['open']);

        const triageTask = {
          id: randomUUID(),
          agentId,
          type: 'email_triage',
          status: 'done',
          externalEventId: source.channelMessageId,
          createdAt: now,
          updatedAt: now,
        };
        if (db) await db.insert(taskTable).values(triageTask);
        else if (store) await store.doc('tasks', triageTask.id).set(encodeRecord(triageTask));
        expect(
          (await emailRepo.listEmailObligations(now)).map((row) => row.obligationStatus),
        ).toEqual(['open']);

        const resolved = await emailRepo.decideEmailObligation({
          channelMessageId: source.channelMessageId,
          expectedVersion: 1,
          decision: 'resolve',
          now,
        });
        expect(resolved).toBe(true);
        expect(await emailRepo.listEmailObligations(now)).toMatchObject([
          { obligationStatus: 'resolved' },
        ]);
        expect(
          await emailRepo.decideEmailObligation({
            channelMessageId: source.channelMessageId,
            expectedVersion: 1,
            decision: 'reopen',
            now,
          }),
        ).toBe(false);
        expect(
          await emailRepo.decideEmailObligation({
            channelMessageId: source.channelMessageId,
            expectedVersion: 2,
            decision: 'reopen',
            now,
          }),
        ).toBe(true);
        expect(await emailRepo.listEmailObligations(now)).toMatchObject([
          { obligationStatus: 'open' },
        ]);
      });
      it('supersedes the old message when a newer source arrives in the same thread', async () => {
        const old = await lifecycleMail(
          'hc09-old',
          'thread-current',
          new Date(now.getTime() - 2 * hour),
        );
        expect(
          await emailRepo.decideEmailObligation({
            channelMessageId: old.channelMessageId,
            expectedVersion: 0,
            decision: 'confirm_open',
            now,
          }),
        ).toBe(true);
        const current = await lifecycleMail(
          'hc09-current',
          'thread-current',
          new Date(now.getTime() - hour),
        );
        expect(
          await emailRepo.decideEmailObligation({
            channelMessageId: old.channelMessageId,
            expectedVersion: 1,
            decision: 'resolve',
            now,
          }),
        ).toBe(false);
        expect(await emailRepo.listEmailObligations(now)).toMatchObject([
          { channelMessageId: current.channelMessageId, obligationStatus: 'unknown' },
        ]);
      });
      it('keeps an owner snooze quiet until its deadline, then makes it reviewable again', async () => {
        const source = await lifecycleMail(
          'hc09-snooze',
          'thread-snooze',
          new Date(now.getTime() - hour),
        );
        const later = new Date(now.getTime() + hour);
        expect(
          await emailRepo.decideEmailObligation({
            channelMessageId: source.channelMessageId,
            expectedVersion: 0,
            decision: 'snooze',
            now,
            snoozedUntil: later,
          }),
        ).toBe(true);
        const window = {
          since: new Date(now.getTime() - 24 * hour),
          until: now,
          now,
          minImportance: 3,
          limit: 5,
        };
        expect(await repo.actionableMail(agentId, window)).toEqual([]);
        expect(
          await repo.actionableMail(agentId, { ...window, until: later, now: later }),
        ).toMatchObject([
          { channelMessageId: source.channelMessageId, obligationStatus: 'snoozed' },
        ]);
      });
      it('uses the commitment source lifecycle, not its originating task status', async () => {
        const completedTask = {
          id: randomUUID(),
          agentId,
          type: 'adhoc',
          status: 'done',
          createdAt: now,
          updatedAt: now,
        };
        const staleTask = {
          ...completedTask,
          id: randomUUID(),
          status: 'running',
        };
        if (db) {
          await db.insert(taskTable).values([completedTask, staleTask]);
        } else if (store) {
          await Promise.all(
            [completedTask, staleTask].map((row) =>
              store?.doc('tasks', row.id).set(encodeRecord(row)),
            ),
          );
        }
        const stillOwed = await obligation(6, false, false, { sourceTaskId: completedTask.id });
        await obligation(7, false, false, {
          sourceTaskId: staleTask.id,
          status: 'resolved',
          resolvedAt: now,
        });

        expect((await repo.dueCommitments(agentId, dueWindow)).map((row) => row.id)).toEqual([
          stillOwed.id,
        ]);
      });
    },
  );
}
