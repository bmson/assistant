import { createHash, randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeDateLabel } from '../../../packages/core/src/memory/date-labels.js';
import { GRAPH_EXTRACTION_VERSION } from '../../../packages/core/src/memory/knowledge-graph.js';
import { deterministicUuid } from '../../../packages/firestore/src/stable-id.js';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = { provider: 'synthetic', model: 'graph-fixture', dimensions: 1536, revision: '1' };
const VECTOR = Array.from({ length: 1536 }, (_, i) => (i === 3 ? 1 : 0));
const EXTRACTION_VERSION = GRAPH_EXTRACTION_VERSION;

/** The id Firestore graph sync derives for an entity's canonical key. */
function entityId(agentId: string, canonicalKey: string): string {
  return deterministicUuid('knowledge-graph-entity', agentId, canonicalKey);
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore knowledge graph jobs',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: ExecutorDeps;

    beforeEach(async () => {
      resetConfigForTest();
      loadConfig({ GRAPH_RAG_ENABLED: 'true' });
      store = emulatorStore();
      const unavailable = (name: string) =>
        new Proxy(
          {},
          {
            get: (_target, property) => {
              throw new Error(`Unexpected ${name} access: ${String(property)}`);
            },
          },
        );
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      deps = {
        db: unavailable('db') as Db,
        router: unavailable('router') as ExecutorDeps['router'],
        dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
        persistence,
      };
      await store
        .doc('agents', agentId)
        .set({ id: agentId, name: 'Owner', timezone: 'UTC', locale: 'en' });
    });

    afterEach(async () => {
      await disposeStore(store);
      resetConfigForTest();
    });

    async function memory(
      content: string,
      createdAt: Date,
      input: { quarantined?: boolean; supersededById?: string } = {},
    ) {
      const id = randomUUID();
      const contentHash = createHash('sha256').update(content).digest('hex');
      await store.doc('memories', id).set(
        encodeRecord({
          id,
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content,
          contentHash,
          embedding: VECTOR,
          quarantined: input.quarantined ?? false,
          supersededById: input.supersededById ?? null,
          expiresAt: null,
          createdAt,
        }),
      );
      await store.doc('knowledgeGraphSources', id).set(
        encodeRecord({
          memoryId: id,
          agentId,
          status: 'ready',
          contentHash,
          extractionVersion: EXTRACTION_VERSION,
          subjectContactId: null,
          lastError: null,
          nextRetryAt: null,
          attempts: 1,
          createdAt,
          updatedAt: createdAt,
        }),
      );
      return id;
    }

    async function entity(input: {
      label: string;
      kind: string;
      canonicalKey: string;
      id?: string;
      contactId?: string | null;
    }) {
      const id = input.id ?? `entity-${randomUUID()}`;
      await store.doc('knowledgeGraphEntities', id).set(
        encodeRecord({
          id,
          agentId,
          kind: input.kind,
          label: input.label,
          preferredLabel: null,
          canonicalKey: input.canonicalKey,
          contactId: input.contactId ?? null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      return id;
    }

    async function relation(
      subjectEntityId: string,
      predicate: string,
      objectEntityId: string,
      sourceMemoryId: string,
    ) {
      const id = randomUUID();
      await store.doc('knowledgeGraphRelations', id).set(
        encodeRecord({
          id,
          agentId,
          subjectEntityId,
          predicate,
          objectEntityId,
          sourceMemoryId,
          sourceFingerprint: id,
          evidenceQuote: 'quoted',
          assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
          reviewStatus: 'confirmed',
          confidence: '0.90',
          validFrom: null,
          validUntil: null,
          ordinal: 0,
          reviewedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      return id;
    }

    async function runJob(job: string): Promise<string | undefined> {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job } },
      });
      const result = await executeTask(deps, task.id);
      expect(result.outcome).toBe('done');
      return result.detail;
    }

    it('asks about one gap of a well-connected person per run, never twice', async () => {
      const owner = await entity({ label: 'Owner', kind: 'person', canonicalKey: 'person:owner' });
      const coffee = await entity({ label: 'Coffee', kind: 'thing', canonicalKey: 'thing:coffee' });
      const anna = await entity({ label: 'Anna', kind: 'person', canonicalKey: 'person:anna' });
      const bo = await entity({ label: 'Bo', kind: 'person', canonicalKey: 'person:bo' });
      const one = await memory('Anna is my sister.', new Date('2026-09-01T00:00:00Z'));
      const two = await memory('Anna likes coffee.', new Date('2026-09-02T00:00:00Z'));
      const hidden = await memory('Bo is a friend.', new Date('2026-09-03T00:00:00Z'), {
        quarantined: true,
      });
      const replaced = await memory('Bo likes tea.', new Date('2026-09-03T00:00:00Z'), {
        supersededById: randomUUID(),
      });
      await relation(anna, 'sister_of', owner, one);
      await relation(anna, 'likes', coffee, two);
      // Bo's edges come from a quarantined and a superseded memory, so Bo is
      // not someone the active graph leans on.
      await relation(bo, 'friend_of', owner, hidden);
      await relation(bo, 'likes', coffee, replaced);

      expect(await runJob('graph.curiosity')).toBe(
        'curiosity: asked about a missing-predicate gap, 3 known',
      );
      expect(await runJob('graph.curiosity')).toBe(
        'curiosity: asked about a missing-predicate gap, 3 known',
      );
      expect(await runJob('graph.curiosity')).toBe(
        'curiosity: asked about a unlinked-person gap, 3 known',
      );
      expect(await runJob('graph.curiosity')).toBe('curiosity: nothing to ask (3 gap(s) known)');

      const ledger = await store.collection('suggestions').where('agentId', '==', agentId).get();
      expect(ledger.docs.map((doc) => [doc.get('sourceRef'), doc.get('status')]).sort()).toEqual([
        [`gap:missing:${anna}:lives_in`, 'dismissed'],
        [`gap:missing:${anna}:works_at`, 'dismissed'],
        [`gap:unlinked:${anna}`, 'dismissed'],
      ]);
      const open = await persistence.suggestions?.listOpen(agentId, new Date());
      expect(open).toEqual([]);

      const marker = await store.doc('notificationConversations', agentId).get();
      const notices = await store
        .collection('messages')
        .where('conversationId', '==', marker.get('conversationId'))
        .get();
      expect(notices.docs.map((doc) => doc.get('text')).sort()).toEqual([
        'I do not have current knowledge of where Anna lives. Would you like me to remember it?',
        'I do not have current knowledge of where Anna works. Would you like me to remember it?',
        'I have notes about Anna but no contact details. Do you want me to keep track of how to reach them?',
      ]);
    });

    it('canonicalizes date nodes for free, folding duplicates and leaving ambiguous wording', async () => {
      const march = new Date('2026-03-02T09:00:00Z');
      const april = new Date('2026-04-01T09:00:00Z');
      const trip = await entity({ label: 'Trip', kind: 'event', canonicalKey: 'event:trip' });
      const one = await memory('The trip is on 6 March 2026.', march);
      const two = await memory('The flight home is on 10 April 2026.', april);
      const vague = await memory('We should talk tomorrow about the trip.', april);

      const canonicalMarch = canonicalizeDateLabel('2026-03-06', march, 'UTC', 'en');
      expect(canonicalMarch?.key).toBe('2026-03-06');
      const held = await entity({
        id: entityId(agentId, 'date:2026-03-06'),
        label: '2026-03-06',
        kind: 'date',
        canonicalKey: 'date:2026-03-06',
      });
      const spelled = await entity({
        label: 'March 6, 2026',
        kind: 'date',
        canonicalKey: 'date:march-6-2026',
      });
      const april10 = await entity({
        label: '10 April 2026',
        kind: 'date',
        canonicalKey: 'date:10-april-2026',
      });
      const friday = await entity({ label: 'Friday', kind: 'date', canonicalKey: 'date:friday' });
      const someday = await entity({
        label: 'someday',
        kind: 'date',
        canonicalKey: 'date:someday',
      });
      await relation(trip, 'on', held, one);
      const moved = await relation(trip, 'starts_on', spelled, one);
      const rekeyed = await relation(trip, 'returns_on', april10, two);
      await relation(trip, 'mentioned_on', friday, one);
      await relation(trip, 'mentioned_on', friday, two);
      await relation(trip, 'maybe_on', someday, vague);

      const heldRelabeled = canonicalMarch?.label !== '2026-03-06' ? 1 : 0;
      expect(await runJob('memory.graph_date_backfill')).toBe(
        `knowledge graph dates: ${1 + heldRelabeled} canonicalized, 1 merged, ` +
          '2 unresolved of 5 scanned, 1 source(s) would need re-extraction',
      );

      // The spelled-out duplicate folded into the node that already held the date.
      expect((await store.doc('knowledgeGraphEntities', spelled).get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphRelations', moved).get()).get('objectEntityId')).toBe(
        held,
      );
      // The April node moved to the document its canonical key derives, with its edge.
      const target = entityId(agentId, 'date:2026-04-10');
      expect((await store.doc('knowledgeGraphEntities', april10).get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphEntities', target).get()).get('canonicalKey')).toBe(
        'date:2026-04-10',
      );
      expect(
        (await store.doc('knowledgeGraphRelations', rekeyed).get()).get('objectEntityId'),
      ).toBe(target);
      // The relative wording was never aliased to one day.
      const aliases = await store
        .collection('knowledgeGraphEntityAliases')
        .where('canonicalKey', 'in', ['date:10-april-2026', 'date:friday'])
        .get();
      expect(aliases.empty).toBe(true);
      // "Friday" means a different day to each citing memory, so it is left alone.
      expect((await store.doc('knowledgeGraphEntities', friday).get()).get('canonicalKey')).toBe(
        'date:friday',
      );

      expect(await runJob('memory.graph_date_backfill')).toBe(
        'knowledge graph dates: 0 canonicalized, 0 merged, ' +
          '2 unresolved of 4 scanned, 1 source(s) would need re-extraction',
      );
    });
  },
);
