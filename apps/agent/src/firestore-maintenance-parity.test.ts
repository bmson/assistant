import { randomUUID } from 'node:crypto';
import { expireStaleSuggestions, purgeAgedHistory, purgeExpired } from '@assistant/core';
import {
  agents,
  approvals,
  conversationSegments,
  conversations,
  costEvents,
  createDb,
  type Db,
  dreamNotes,
  locationPings,
  memories,
  messages,
  modelCallAudit,
  modelCalls,
  proactivePings,
  recallFeedback,
  suggestions,
  tasks,
  toolCache,
  toolCalls,
} from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const DAY = 86_400_000;
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * The same rows, seeded into PostgreSQL and Firestore, run through each
 * driver's retention and expiry path. Both must keep and delete exactly the
 * same rows, class by class.
 */
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST || !DATABASE_URL)(
  'maintenance retention parity between PostgreSQL and Firestore',
  () => {
    let db: Db;
    let store: InstallationStore;
    let agentId: string;
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * DAY);
    const id = () => randomUUID();
    const ids = {
      conversation: id(),
      task: id(),
      suggestions: { pending: id(), snoozed: id(), future: id(), accepted: id() },
      cache: { expired: `parity:${id()}`, fresh: `parity:${id()}` },
      memories: { expired: id(), fresh: id(), permanent: id() },
      locations: { old: id(), recent: id() },
      dreamNotes: { expired: id(), fresh: id() },
      pings: { old: id(), recent: id() },
      audit: { old: id(), recent: id(), cascaded: id() },
      messages: { anchorStart: id(), anchorEnd: id(), plain: id(), recent: id() },
      segment: id(),
      feedback: id(),
      toolCalls: { approved: id(), costed: id(), freed: id(), plain: id(), recent: id() },
      approval: id(),
      costEvents: { aged: id(), kept: id() },
      modelCalls: { aged: id(), recent: id() },
    };

    type Row = Record<string, unknown> & { id: string };
    const seeds: Array<{ collection: string; table: unknown; row: Row; firestoreId?: string }> = [];
    const seed = (collection: string, table: unknown, row: Row, firestoreId?: string) =>
      seeds.push({ collection, table, row, firestoreId });

    beforeAll(async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      db = createDb(DATABASE_URL as string);
      const [agent] = await db.select().from(agents).limit(1);
      if (!agent) throw new Error('Seed the test database');
      agentId = agent.id;
      store = emulatorStore(() => new Date());

      seed('conversations', conversations, {
        id: ids.conversation,
        agentId,
        channel: 'chat',
        trust: 'owner',
      });
      seed('tasks', tasks, {
        id: ids.task,
        agentId,
        type: 'adhoc',
        trust: 'owner',
        status: 'done',
        trigger: {},
        // A missing execution state is malformed recovery metadata, so the
        // Firestore retention path correctly preserves its tool-call receipts.
        state: {},
        // Tool-call retention deliberately requires the parent task to be
        // terminal and itself older than the history cutoff. Keep the fixture
        // on the safe aged side of both conditions instead of relaxing the
        // production retention guard to make this row eligible.
        updatedAt: ago(31),
      });
      const suggestion = (key: keyof typeof ids.suggestions, status: string, expiresAt: Date) =>
        seed('suggestions', suggestions, {
          id: ids.suggestions[key],
          agentId,
          status,
          expiresAt,
          summary: 'parity',
          proposedAction: 'parity',
          sourceRef: `parity:${ids.suggestions[key]}`,
          origin: 'watch',
        });
      suggestion('pending', 'pending', ago(0.01));
      suggestion('snoozed', 'snoozed', ago(1));
      suggestion('future', 'pending', ago(-1));
      suggestion('accepted', 'accepted', ago(1));
      for (const [key, expiresAt] of [
        ['expired', ago(0.01)],
        ['fresh', ago(-1)],
      ] as const)
        seed(
          'toolCache',
          toolCache,
          {
            id: ids.cache[key],
            cacheKey: ids.cache[key],
            toolName: 'parity',
            result: {},
            expiresAt,
          },
          ids.cache[key],
        );
      for (const [key, expiresAt] of [
        ['expired', ago(0.01)],
        ['fresh', ago(-1)],
        ['permanent', null],
      ] as const)
        seed('memories', memories, {
          id: ids.memories[key],
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: 'parity',
          contentHash: `parity-${ids.memories[key]}`,
          originTrust: 'owner',
          expiresAt,
        });
      for (const [key, days] of [
        ['old', 4],
        ['recent', 1],
      ] as const)
        seed('locationPings', locationPings, {
          id: ids.locations[key],
          agentId,
          lat: '64.1',
          lng: '-21.9',
          source: 'app',
          capturedAt: ago(days),
        });
      for (const [key, expiresAt] of [
        ['expired', ago(0.01)],
        ['fresh', ago(-1)],
      ] as const)
        seed('dreamNotes', dreamNotes, {
          id: ids.dreamNotes[key],
          agentId,
          kind: 'insight',
          content: 'parity',
          expiresAt,
        });
      for (const [key, days] of [
        ['old', 91],
        ['recent', 89],
      ] as const)
        seed('proactivePings', proactivePings, {
          id: ids.pings[key],
          agentId,
          urgency: 'ambient',
          channel: 'push',
          delivered: true,
          createdAt: ago(days),
        });
      seed('modelCalls', modelCalls, {
        id: ids.modelCalls.aged,
        role: 'chat',
        model: 'parity',
        createdAt: ago(31),
      });
      seed('modelCalls', modelCalls, {
        id: ids.modelCalls.recent,
        role: 'chat',
        model: 'parity',
        createdAt: ago(1),
      });
      for (const [key, days, modelCallId] of [
        ['old', 15, null],
        ['recent', 13, null],
        ['cascaded', 1, ids.modelCalls.aged],
      ] as const)
        seed('modelCallAudit', modelCallAudit, {
          id: ids.audit[key],
          modelCallId,
          role: 'chat',
          model: 'parity',
          method: 'generate',
          capture: 'full',
          createdAt: ago(days),
        });
      for (const [key, days] of [
        ['anchorStart', 33],
        ['anchorEnd', 32],
        ['plain', 31],
        ['recent', 1],
      ] as const)
        seed('messages', messages, {
          id: ids.messages[key],
          conversationId: ids.conversation,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: 'parity',
          channelMessageId: null,
          createdAt: ago(days),
        });
      seed('conversationSegments', conversationSegments, {
        id: ids.segment,
        agentId,
        conversationId: ids.conversation,
        startMessageId: ids.messages.anchorStart,
        endMessageId: ids.messages.anchorEnd,
        summary: 'parity',
        messageCount: 2,
        startedAt: ago(33),
        endedAt: ago(32),
      });
      seed('recallFeedback', recallFeedback, {
        id: ids.feedback,
        agentId,
        messageId: ids.messages.plain,
        verdict: 'helpful',
        sourceCount: 1,
      });
      for (const [key, days] of [
        ['approved', 31],
        ['costed', 31],
        ['freed', 31],
        ['plain', 31],
        ['recent', 1],
      ] as const)
        seed('toolCalls', toolCalls, {
          id: ids.toolCalls[key],
          taskId: ids.task,
          step: 1,
          toolName: 'parity.tool',
          risk: 'autonomous',
          status: 'succeeded',
          idempotencyKey: null,
          createdAt: ago(days),
        });
      seed('approvals', approvals, {
        id: ids.approval,
        taskId: ids.task,
        toolCallId: ids.toolCalls.approved,
        shortCode: 'P1',
        summary: 'parity',
        status: 'approved',
        expiresAt: ago(30),
        requestedAt: ago(31),
      });
      seed('costEvents', costEvents, {
        id: ids.costEvents.aged,
        toolCallId: ids.toolCalls.freed,
        source: 'model',
        usd: '0.010000',
        createdAt: ago(61),
      });
      seed('costEvents', costEvents, {
        id: ids.costEvents.kept,
        toolCallId: ids.toolCalls.costed,
        source: 'model',
        usd: '0.010000',
        createdAt: ago(10),
      });

      for (const { collection, table, row, firestoreId } of seeds) {
        await db.insert(table as typeof tasks).values(row as never);
        await store.doc(collection, firestoreId ?? row.id).set(encodeRecord(row));
      }
    });

    afterAll(async () => {
      const remove = async (table: unknown, column: unknown, values: string[]) =>
        db
          .delete(table as typeof tasks)
          .where(inArray(column as typeof tasks.id, values))
          .catch(() => {});
      if (db) {
        await remove(approvals, approvals.id, [ids.approval]);
        await remove(costEvents, costEvents.id, Object.values(ids.costEvents));
        await remove(toolCalls, toolCalls.id, Object.values(ids.toolCalls));
        await remove(recallFeedback, recallFeedback.id, [ids.feedback]);
        await remove(conversationSegments, conversationSegments.id, [ids.segment]);
        await remove(messages, messages.id, Object.values(ids.messages));
        await remove(modelCallAudit, modelCallAudit.id, Object.values(ids.audit));
        await remove(modelCalls, modelCalls.id, Object.values(ids.modelCalls));
        await remove(proactivePings, proactivePings.id, Object.values(ids.pings));
        await remove(dreamNotes, dreamNotes.id, Object.values(ids.dreamNotes));
        await remove(locationPings, locationPings.id, Object.values(ids.locations));
        await remove(memories, memories.id, Object.values(ids.memories));
        await remove(toolCache, toolCache.cacheKey, Object.values(ids.cache));
        await remove(suggestions, suggestions.id, Object.values(ids.suggestions));
        await remove(tasks, tasks.id, [ids.task]);
        await remove(conversations, conversations.id, [ids.conversation]);
        await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
      }
      if (store) await disposeStore(store);
      vi.unstubAllEnvs();
    });

    /** Which seeded rows each driver still holds, and suggestion statuses. */
    async function survivors() {
      const pg: string[] = [];
      const fs: string[] = [];
      for (const { collection, table, row, firestoreId } of seeds) {
        const key = `${collection}:${firestoreId ?? row.id}`;
        const column = collection === 'toolCache' ? toolCache.cacheKey : (table as typeof tasks).id;
        const [present] = await db
          .select()
          .from(table as typeof tasks)
          .where(inArray(column as typeof tasks.id, [firestoreId ?? row.id]));
        if (present)
          pg.push(
            collection === 'suggestions'
              ? `${key}:${(present as unknown as { status: string }).status}`
              : key,
          );
        const snapshot = await store.doc(collection, firestoreId ?? row.id).get();
        if (snapshot.exists)
          fs.push(collection === 'suggestions' ? `${key}:${snapshot.get('status')}` : key);
      }
      return { pg, fs };
    }

    it('keeps and deletes the same rows in every data class', async () => {
      const persistence = createFirestoreExecutionPersistence(store, agentId, {
        provider: 'synthetic',
        model: 'parity',
        dimensions: 1536,
        revision: '1',
      });
      const history = { historyDays: 30, costDays: 60, batch: 1000 };

      await expireStaleSuggestions(db);
      await purgeExpired(db);
      await purgeAgedHistory(db, history);
      await expireStaleSuggestions(persistence.maintenance);
      await purgeExpired(persistence);
      await purgeAgedHistory(persistence.maintenance, history);

      const { pg, fs } = await survivors();
      expect(fs).toEqual(pg);
      // The retained set is the policy, not an accident of either driver.
      expect(pg).toEqual(
        expect.arrayContaining([
          `suggestions:${ids.suggestions.pending}:expired`,
          `suggestions:${ids.suggestions.snoozed}:expired`,
          `suggestions:${ids.suggestions.future}:pending`,
          `suggestions:${ids.suggestions.accepted}:accepted`,
          `messages:${ids.messages.anchorStart}`,
          `messages:${ids.messages.anchorEnd}`,
          `toolCalls:${ids.toolCalls.approved}`,
          `toolCalls:${ids.toolCalls.costed}`,
        ]),
      );
      for (const gone of [
        `toolCache:${ids.cache.expired}`,
        `memories:${ids.memories.expired}`,
        `locationPings:${ids.locations.old}`,
        `dreamNotes:${ids.dreamNotes.expired}`,
        `proactivePings:${ids.pings.old}`,
        `modelCallAudit:${ids.audit.old}`,
        `modelCallAudit:${ids.audit.cascaded}`,
        `messages:${ids.messages.plain}`,
        `recallFeedback:${ids.feedback}`,
        `toolCalls:${ids.toolCalls.freed}`,
        `toolCalls:${ids.toolCalls.plain}`,
        `costEvents:${ids.costEvents.aged}`,
        `modelCalls:${ids.modelCalls.aged}`,
      ])
        expect(pg).not.toContain(gone);
    });
  },
);
