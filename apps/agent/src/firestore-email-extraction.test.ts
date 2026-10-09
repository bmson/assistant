import { createHash, randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreProfileOccasionCommandRepository,
} from '@assistant/firestore';
import { type ExecutionPersistence, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from '../../../packages/firestore/src/memory.js';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = { provider: 'synthetic', model: 'email-fixture', dimensions: 1536, revision: '1' };

function vector(): number[] {
  const values = new Array(1536).fill(0);
  values[0] = 1;
  return values;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore email extraction job',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: ExecutorDeps;
    let prompts: string[];

    beforeEach(async () => {
      store = emulatorStore();
      prompts = [];
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      const unavailable = (name: string) =>
        new Proxy(
          {},
          {
            get: (_target, property) => {
              throw new Error(`Unexpected ${name} access: ${String(property)}`);
            },
          },
        );
      const router = {
        async embeddingSpace() {
          return SPACE;
        },
        async embeddingSpaceKey() {
          return embeddingSpaceIdentityKey(SPACE);
        },
        async object(_role: string, input: { prompt: string }) {
          prompts.push(input.prompt);
          return {
            ok: true,
            modelId: 'fixture',
            degraded: false,
            object: {
              facts: [
                {
                  content: 'The owner flies to Oslo on 1 October 2026 at 08:00 on SK4321.',
                  kind: 'fact',
                  category: 'knowledge',
                  subject: 'owner',
                  relationship: '',
                  importance: 4,
                  confidence: 0.95,
                  domain: 'travel',
                  validFrom: '',
                },
                {
                  content: 'Grace is moving to Reykjavik.',
                  kind: 'person',
                  category: 'knowledge',
                  subject: 'Grace',
                  relationship: 'friend',
                  importance: 3,
                  confidence: 0.9,
                  domain: 'personal',
                  validFrom: '',
                },
                {
                  content: 'A forgotten fact.',
                  kind: 'fact',
                  category: 'knowledge',
                  subject: 'owner',
                  relationship: '',
                  importance: 3,
                  confidence: 0.9,
                  domain: 'travel',
                  validFrom: '',
                },
              ],
              occasions: [
                {
                  subject: 'Grace',
                  kind: 'birthday',
                  month: 5,
                  day: 4,
                  label: '',
                  year: null,
                  notes: '',
                },
              ],
            },
          };
        },
        async embed(texts: string[]) {
          return texts.map(() => vector());
        },
      };
      deps = {
        db: unavailable('db') as Db,
        router: router as unknown as ExecutorDeps['router'],
        dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
        persistence,
      };
      await store.doc('agents', agentId).set({ id: agentId, name: 'Ada', timezone: 'UTC' });
      const ownerId = randomUUID();
      await store
        .doc('contacts', ownerId)
        .set({ id: ownerId, agentId, name: 'Ada', trust: 'owner', aliases: [], emails: [] });
      await store
        .doc('memoryTombstones', createHash('sha256').update('A forgotten fact.').digest('hex'))
        .set({ agentId });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function ingest(
      channelMessageId: string,
      importance: number,
      text: string,
      minutesAgo: number,
    ) {
      const id = randomUUID();
      const at = new Date(Date.now() - minutesAgo * 60_000);
      await store.doc('emailIngest', id).set(
        encodeRecord({
          id,
          agentId,
          conversationId: null,
          channelMessageId,
          category: 'travel',
          importance,
          reason: 'fixture',
          fromEmail: 'airline@sk.test',
          fromName: 'SK',
          subject: 'Your booking',
          contentTrust: 'unknown',
          authenticated: true,
          actionable: true,
          dates: [],
          triaged: false,
          extractedAt: null,
          createdAt: at,
          updatedAt: at,
        }),
      );
      const messageId = randomUUID();
      await store.doc('messages', messageId).set(
        encodeRecord({
          id: messageId,
          conversationId: 'c',
          text,
          channelMessageId,
          role: 'user',
          createdAt: at,
        }),
      );
      await store
        .doc('messageChannelIds', channelMessageId)
        .set({ messageId, conversationId: 'c' });
      return id;
    }

    async function runJob() {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job: 'email.extract' } },
      });
      const result = await executeTask(deps, task.id);
      expect(result.outcome).toBe('done');
      return result.detail;
    }

    it('reads each ingested message once into memory, quarantining claims about people', async () => {
      const booking = await ingest(
        'gmail:b1',
        4,
        'Booking confirmed: SK4321 to Oslo on 1 October at 08:00, seat 12A.',
        20,
      );
      const routine = await ingest(
        'gmail:r1',
        2,
        'Weekly newsletter with nothing in it at all really.',
        10,
      );

      expect(await runJob()).toBe(
        'email extraction: 2 saved (1 recallable, 1 awaiting review), 0 duplicate, 1 occasion(s), ' +
          'from 2 message(s) (1 routine), 0 still pending',
      );
      expect(prompts).toHaveLength(1);
      const memories = await store.collection('memories').get();
      const byContent = new Map(memories.docs.map((doc) => [doc.get('content'), doc.data()]));
      const flight = byContent.get('The owner flies to Oslo on 1 October 2026 at 08:00 on SK4321.');
      expect([
        flight?.quarantined,
        flight?.originTrust,
        flight?.source,
        flight?.confidence,
      ]).toEqual([false, 'unknown', 'email-ingest', '0.80']);
      expect(flight?.embeddingSpace).toBe(embeddingSpaceKey(SPACE));
      expect(byContent.get('Grace is moving to Reykjavik.')?.quarantined).toBe(true);
      expect(byContent.has('A forgotten fact.')).toBe(false);
      const occasions = await store.collection('occasions').get();
      expect(
        occasions.docs.map((doc) => [doc.get('month'), doc.get('day'), doc.get('quarantined')]),
      ).toEqual([[5, 4, true]]);

      const occasionId = String(occasions.docs[0]?.get('id'));
      const contactId = String(occasions.docs[0]?.get('contactId'));
      await new FirestoreProfileOccasionCommandRepository(store, agentId).update(occasionId, {
        kind: 'birthday',
        label: 'Birthday',
        month: 5,
        day: 5,
        year: null,
        leadDays: 7,
        notes: 'Owner corrected the date',
      });
      await expect(
        persistence.emailExtraction?.saveOccasion({
          agentId,
          subject: 'Grace',
          kind: 'birthday',
          label: 'Birthday',
          month: 5,
          day: 4,
          year: null,
          notes: 'Historical email date',
        }),
      ).resolves.toBe(false);
      await persistence.emailExtraction?.saveOccasion({
        agentId,
        subject: 'Grace',
        kind: 'birthday',
        label: 'Birthday',
        month: 5,
        day: 5,
        year: null,
        notes: 'Later email detail',
      });
      const afterEmailReplay = await store
        .collection('occasions')
        .where('contactId', '==', contactId)
        .get();
      expect(afterEmailReplay.size).toBe(1);
      expect(
        afterEmailReplay.docs.find((doc) => doc.get('id') === occasionId)?.data(),
      ).toMatchObject({
        day: 5,
        notes: 'Owner corrected the date; Later email detail',
        ownerConfirmed: true,
      });
      expect(afterEmailReplay.docs.find((doc) => doc.get('day') === 4)).toBeUndefined();

      for (const id of [booking, routine])
        expect((await store.doc('emailIngest', id).get()).get('extractedAt')).toBeTruthy();
      expect(await persistence.emailExtraction?.pendingCount()).toBe(0);

      // Nothing is left to read, so the model is not asked again.
      await runJob();
      expect(prompts).toHaveLength(1);
    });
  },
);
