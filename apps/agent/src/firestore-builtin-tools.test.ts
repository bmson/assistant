import { randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import type { Db } from '@assistant/db';
import {
  embeddingSpaceKey,
  FirestoreAuditInvestigationRepository,
  FirestoreContactLookupRepository,
  FirestoreConversationSearchRepository,
  FirestoreGraphRecallRepository,
  FirestoreMemoryRepository,
  FirestoreOccasionToolRepository,
  FirestoreProfileOccasionCommandRepository,
  FirestoreSituationToolRepository,
  FirestoreToolExecutionRepository,
} from '@assistant/firestore';
import {
  conversationMessageSourceRevision,
  type EmbeddingSpace,
  type Records,
} from '@assistant/persistence';
import {
  registerAuditTools,
  registerPortableContactLookupTool,
  registerPortableConversationSearchTool,
  registerPortableGraphSnapshotTool,
  registerPortableOccasionTools,
  registerPortableReadResultTool,
  registerSituationTools,
} from '@assistant/tools/builtin';
import { ToolRegistry } from '@assistant/tools/registry';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const AGENT = 'owner-agent';
const now = new Date('2026-09-25T12:00:00.000Z');
const earlier = new Date('2026-09-20T12:00:00.000Z');
const space: EmbeddingSpace = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  revision: '1',
};
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore built-in record tools without PostgreSQL',
  () => {
    let store: InstallationStore;
    let sqlAccesses: string[];
    let registry: ToolRegistry;

    function context(overrides: { taskId?: string; trust?: string; agentId?: string } = {}) {
      return {
        taskId: overrides.taskId ?? 'task',
        agentId: overrides.agentId ?? AGENT,
        trust: overrides.trust ?? 'owner',
        tainted: false,
        db: new Proxy(
          {},
          {
            get: (_target, property) => {
              sqlAccesses.push(String(property));
              throw new Error(`Unexpected SQL access: ${String(property)}`);
            },
          },
        ) as Db,
        now: () => now,
        signal: new AbortController().signal,
        log: async () => {},
      } as never;
    }

    async function run(
      name: string,
      args: Record<string, unknown>,
      ctx: Parameters<typeof context>[0] = {},
    ) {
      const tool = registry.get(name)?.tool;
      if (!tool) throw new Error(`${name} was not registered`);
      return tool.execute(tool.inputSchema.parse(args), context(ctx)) as Promise<
        Record<string, unknown>
      >;
    }

    beforeEach(async () => {
      store = emulatorStore(() => now);
      sqlAccesses = [];
      const embed = async (texts: string[]) => texts.map(() => vector);
      registry = new ToolRegistry();
      registerAuditTools(registry, new FirestoreAuditInvestigationRepository(store));
      registerPortableGraphSnapshotTool(registry, {
        embed,
        graph: new FirestoreGraphRecallRepository(store, space),
      });
      const conversations = new FirestoreConversationSearchRepository(store, space);
      registerPortableReadResultTool(registry, {
        toolExecution: new FirestoreToolExecutionRepository(store),
        conversations,
      });
      registerPortableOccasionTools(registry, new FirestoreOccasionToolRepository(store, AGENT));
      registerPortableContactLookupTool(
        registry,
        new FirestoreContactLookupRepository(store, AGENT),
      );
      registerPortableConversationSearchTool(registry, {
        embed: async (texts) => ({
          embeddings: await embed(texts),
          embeddingSpaceKey: embeddingSpaceKey(space),
        }),
        conversations,
      });
      registerSituationTools(registry, new FirestoreSituationToolRepository(store, AGENT));
      await store.doc('agents', AGENT).set({ id: AGENT, name: 'Owner', timezone: 'UTC' });
    });

    afterEach(async () => {
      expect(sqlAccesses).toEqual([]);
      await disposeStore(store);
    });

    it('reads a failed task and the rest of its model input through the bot audit tools without SQL', async () => {
      const taskId = randomUUID();
      const entryId = randomUUID();
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId: AGENT,
        createdAt: now,
        title: 'Failed send',
        attempt: 3,
        state: { callbackToken: 'private-token' },
      });
      await store.doc('modelCallAudit', entryId).set({
        id: entryId,
        taskId,
        createdAt: now,
        input: 'x'.repeat(14000),
        output: '[audit:provider-error] Invalid request',
        capture: 'redacted',
      });
      const report = await run('audit.read', { taskId, section: 'modelCallAudit' });
      expect(JSON.stringify(report)).toContain('Invalid request');
      expect(JSON.stringify(report)).not.toContain('private-token');
      const field = await run('audit.read_field', {
        taskId,
        section: 'modelCallAudit',
        entryId,
        field: 'input',
        offset: 12000,
      });
      expect(field).toMatchObject({
        offset: 12000,
        totalChars: 14000,
        text: 'x'.repeat(2000),
        hasMore: false,
      });
      expect(await run('audit.read', { taskId }, { agentId: 'another-owner' })).toEqual({
        error: 'Audit record not found.',
      });
      expect(registry.toolsForTask('unknown').map((tool) => tool.name)).not.toContain('audit.read');
    });

    async function contact(
      id: string,
      fields: Partial<Records['contacts']> & { agentId?: string },
    ) {
      await store.doc('contacts', id).set({
        id,
        name: id,
        createdAt: earlier,
        updatedAt: earlier,
        trust: 'known',
        aliases: [],
        emails: [],
        phones: [],
        relationship: '',
        notes: '',
        ...fields,
      });
    }

    async function graphFact(id: string, options: { space?: EmbeddingSpace } = {}) {
      const memory: Records['memories'] = {
        id,
        agentId: AGENT,
        content: `Anna works at ${id}`,
        contentHash: `hash-${id}`,
        createdAt: earlier,
        expiresAt: null,
        embedding: vector,
        embeddingSpaceKey: embeddingSpaceKey(options.space ?? space),
        sourceTaskId: null,
        kind: 'fact',
        confidence: '0.90',
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        importance: 3,
        quarantined: false,
        subjectContactId: null,
        domain: null,
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: false,
        source: 'chat',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      };
      await new FirestoreMemoryRepository(store, options.space ?? space).save(memory);
      await store.doc('knowledgeGraphEntities', `anna-${id}`).set({
        id: `anna-${id}`,
        agentId: AGENT,
        kind: 'person',
        label: 'anna',
        preferredLabel: 'Anna',
      });
      await store.doc('knowledgeGraphEntities', `org-${id}`).set({
        id: `org-${id}`,
        agentId: AGENT,
        kind: 'organization',
        label: id,
        preferredLabel: null,
      });
      await store.doc('knowledgeGraphSources', id).set({
        memoryId: id,
        status: 'ready',
        contentHash: memory.contentHash,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      });
      await store.doc('knowledgeGraphRelations', `relation-${id}`).set({
        id: `relation-${id}`,
        agentId: AGENT,
        sourceMemoryId: id,
        subjectEntityId: `anna-${id}`,
        objectEntityId: `org-${id}`,
        predicate: 'works_at',
        evidenceQuote: `works at ${id}`,
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
        confidence: '0.80',
        reviewStatus: 'pending',
        validFrom: null,
        validUntil: null,
        createdAt: earlier,
      });
    }

    it('reads a source-backed graph snapshot in the configured embedding space', async () => {
      await graphFact('acme');
      await graphFact('elsewhere', { space: { ...space, revision: '2' } });
      const result = await run('memory.graph_snapshot', { query: 'where does Anna work' });
      expect(result.complete).toBe(true);
      expect(result.relationships).toEqual([
        expect.objectContaining({
          id: 'relation-acme',
          subjectLabel: 'Anna',
          subjectKind: 'person',
          predicate: 'works_at',
          objectLabel: 'acme',
          objectKind: 'organization',
          sourceMemoryId: 'acme',
          sourceMemory: 'Anna works at acme',
          source: 'chat',
          evidenceQuote: 'works at acme',
          relationshipConfidence: '0.80',
          unconfirmed: false,
        }),
      ]);
    });

    it('pages a stored result only for the calling task and owner', async () => {
      const taskId = randomUUID();
      const otherTaskId = randomUUID();
      const callId = randomUUID();
      const otherCallId = randomUUID();
      await store.doc('tasks', taskId).set({ id: taskId, agentId: AGENT, status: 'running' });
      await store.doc('tasks', otherTaskId).set({ id: otherTaskId, agentId: AGENT });
      const result = { text: 'x'.repeat(40_000) };
      for (const [id, task] of [
        [callId, taskId],
        [otherCallId, otherTaskId],
      ] as const)
        await store.doc('toolCalls', id).set({
          id,
          taskId: task,
          toolName: 'web.fetch',
          status: 'succeeded',
          approvalId: null,
          result,
        });

      const first = await run('tools.read_result', { toolCallId: callId }, { taskId });
      expect(first).toMatchObject({ offset: 0, hasMore: true });
      expect(first.totalChars).toBe(JSON.stringify(result).length);
      expect(String(first.chunk)).toHaveLength(30_000);
      const rest = await run(
        'tools.read_result',
        { toolCallId: callId, offset: 30_000 },
        { taskId },
      );
      expect(rest.hasMore).toBe(false);
      expect(await run('tools.read_result', { toolCallId: otherCallId }, { taskId })).toEqual({
        error: 'no such tool call in this task',
      });
      expect(
        await run('tools.read_result', { toolCallId: callId }, { taskId, agentId: 'foreign' }),
      ).toEqual({ error: 'no such tool call in this task' });
    });

    it('saves occasions with tool provenance and lists only reviewed upcoming dates', async () => {
      await contact('owner-contact', { name: 'Olivia Owner', trust: 'owner' });
      await contact('anna', { name: 'Anna Jónsdóttir' });

      expect(
        await run('occasions.save', {
          subject: 'Anna',
          kind: 'birthday',
          month: 10,
          day: 1,
          notes: 'Likes tea',
        }),
      ).toEqual({ saved: true, updated: false, quarantined: false, person: 'Anna' });
      expect(
        await run('occasions.save', {
          subject: 'anna jónsdóttir',
          kind: 'birthday',
          month: 10,
          day: 1,
          year: 1990,
          notes: 'Books',
        }),
      ).toEqual({ saved: false, updated: true, quarantined: false, person: 'anna jónsdóttir' });
      expect(
        await run(
          'occasions.save',
          { subject: 'Bob Stranger', kind: 'anniversary', month: 9, day: 27 },
          { trust: 'unknown' },
        ),
      ).toEqual({ saved: true, updated: false, quarantined: true, person: 'Bob Stranger' });
      expect(
        await run('occasions.save', { subject: 'assistant', kind: 'birthday', month: 1, day: 1 }),
      ).toEqual({ saved: false, note: 'could not resolve who this occasion is about' });

      const rows = (await store.collection('occasions').get()).docs.map((doc) => doc.data());
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.contactId === 'anna')).toMatchObject({
        agentId: AGENT,
        notes: 'Likes tea; Books',
        year: 1990,
        originTrust: 'owner',
        quarantined: false,
        ownerConfirmed: false,
        source: 'occasions.save',
      });
      expect(rows.find((row) => row.contactId !== 'anna')).toMatchObject({
        originTrust: 'unknown',
        quarantined: true,
        ownerConfirmed: false,
      });
      const bob = (await store.collection('contacts').where('name', '==', 'Bob Stranger').get())
        .docs[0];
      expect(bob?.get('trust')).toBe('unknown');

      await store.doc('occasions', 'foreign').set({
        id: 'foreign',
        agentId: 'foreign',
        contactId: 'anna',
        kind: 'birthday',
        label: '',
        month: 9,
        day: 26,
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        notes: '',
        quarantined: false,
      });
      expect(await run('occasions.list', { withinDays: 30 })).toEqual({
        occasions: [
          {
            person: 'Anna Jónsdóttir',
            kind: 'birthday',
            date: '2026-10-01',
            daysUntil: 6,
            notes: 'Likes tea; Books',
          },
        ],
      });
      expect(await run('occasions.list', { withinDays: 3 })).toEqual({ occasions: [] });
      await expect(
        run('occasions.list', { withinDays: 30 }, { agentId: 'foreign' }),
      ).rejects.toThrow('outside the configured Firestore agent');
    });

    it('routes occasion tools through the stable identity marker after an owner date edit', async () => {
      await contact('owner-contact', { name: 'Olivia Owner', trust: 'owner' });
      await contact('anna', { name: 'Anna Jónsdóttir' });
      await run('occasions.save', {
        subject: 'Anna',
        kind: 'birthday',
        month: 4,
        day: 12,
        notes: 'Initial source',
      });
      const original = (await store.collection('occasions').where('contactId', '==', 'anna').get())
        .docs[0];
      if (!original) throw new Error('Expected the tool occasion');
      const originalId = String(original.get('id'));
      await new FirestoreProfileOccasionCommandRepository(store, AGENT).update(originalId, {
        kind: 'birthday',
        label: 'Birthday',
        month: 4,
        day: 13,
        year: null,
        leadDays: 7,
        notes: 'Owner correction',
      });

      expect(
        await run('occasions.save', {
          subject: 'Anna',
          kind: 'birthday',
          month: 4,
          day: 12,
          notes: 'Old email date',
        }),
      ).toMatchObject({ saved: false, updated: true });
      expect(
        await run('occasions.save', {
          subject: 'Anna',
          kind: 'birthday',
          month: 4,
          day: 13,
          notes: 'Later source',
        }),
      ).toMatchObject({ saved: false, updated: true });
      const rows = await store.collection('occasions').where('contactId', '==', 'anna').get();
      expect(rows.size).toBe(1);
      expect(rows.docs.find((row) => row.get('id') === originalId)?.data()).toMatchObject({
        id: originalId,
        day: 13,
        notes: 'Owner correction; Later source',
        ownerConfirmed: true,
      });
      expect(rows.docs.find((row) => row.get('day') === 12)).toBeUndefined();
    });

    it('looks up saved addresses by name and alias without creating contacts', async () => {
      await contact('anna', {
        name: 'Anna Jónsdóttir',
        aliases: ['Annie'],
        emails: ['anna@example.com', 'not an email'],
        phones: ['+1 555 0100'],
        relationship: 'sister',
      });
      await contact('foreign', { name: 'Anna Foreign', agentId: 'foreign', emails: ['x@y.z'] });
      const expected = {
        query: 'Anna',
        contacts: [
          {
            name: 'Anna Jónsdóttir',
            emails: ['anna@example.com'],
            phones: ['+1 555 0100'],
            relationship: 'sister',
          },
        ],
      };
      expect(await run('contacts.lookup', { name: 'Anna' })).toEqual(expected);
      expect(await run('contacts.lookup', { name: 'Annie' })).toEqual({
        ...expected,
        query: 'Annie',
      });
      expect(await run('contacts.lookup', { name: 'Nobody' })).toEqual({
        query: 'Nobody',
        contacts: [],
      });
      expect((await store.collection('contacts').get()).size).toBe(2);
    });

    async function conversation(id: string, agentId = AGENT) {
      await store.doc('conversations', id).set({ id, agentId, trust: 'owner' });
    }
    async function message(
      id: string,
      conversationId: string,
      text: string,
      options: { embedded?: boolean; revision?: string; createdAt?: Date } = {},
    ) {
      await store.doc('messages', id).set({
        id,
        conversationId,
        role: 'user',
        text,
        createdAt: options.createdAt ?? earlier,
        ...(options.embedded === false
          ? { embedding: null }
          : {
              embedding: FieldValue.vector(vector),
              embeddingSpace: embeddingSpaceKey({ ...space, revision: options.revision ?? '1' }),
            }),
      });
    }

    it('searches owned conversations in the configured embedding space', async () => {
      await conversation('mine');
      await conversation('theirs', 'foreign');
      await message('owned', 'mine', 'We discussed the kitchen remodel');
      await message('foreign', 'theirs', 'Foreign kitchen remodel');
      await message('old-space', 'mine', 'Old kitchen vectors', { revision: '2' });
      const result = await run('conversations.search', { query: 'kitchen', limit: 5 });
      expect(result.mode).toBe('semantic');
      expect(result.matches).toEqual([
        expect.objectContaining({
          conversationId: 'mine',
          text: 'We discussed the kitchen remodel',
          createdAt: earlier,
        }),
      ]);

      // A full candidate page with too few owned matches fails instead of truncating.
      for (const id of ['f1', 'f2', 'f3']) await message(id, 'theirs', 'Foreign');
      await store.doc('conversations', 'mine').update({ agentId: 'foreign' });
      await expect(run('conversations.search', { query: 'kitchen', limit: 1 })).rejects.toThrow(
        'Conversation search candidate bound reached',
      );
    });

    it('pages an unchanged Firestore search whose persisted dates remain Date objects', async () => {
      const taskId = randomUUID();
      const callId = randomUUID();
      const sourceConversationId = randomUUID();
      const currentConversationId = randomUUID();
      const marker = `persisted date search ${randomUUID()}`;
      await store.doc('tasks', taskId).set({ id: taskId, agentId: AGENT, status: 'running' });
      await conversation(sourceConversationId);
      await conversation(currentConversationId);
      const firstId = randomUUID();
      const secondId = randomUUID();
      const firstText = `${marker} ${'first source passage '.repeat(1_000)}`;
      const secondText = `${marker} ${'second source passage '.repeat(1_000)}`;
      await message(firstId, sourceConversationId, firstText, {
        embedded: false,
        createdAt: earlier,
      });
      await message(secondId, sourceConversationId, secondText, {
        embedded: false,
        createdAt: now,
      });
      const repository = new FirestoreConversationSearchRepository(store, space);
      const matches = await repository.text({
        agentId: AGENT,
        query: marker,
        limit: 5,
        currentConversationId,
      });
      expect(matches.map((match) => match.messageId)).toEqual([secondId, firstId]);
      expect(matches.every((match) => match.createdAt instanceof Date)).toBe(true);
      const result = { mode: 'text', matches };
      expect(JSON.stringify(result).length).toBeGreaterThan(30_000);
      await store.doc('toolCalls', callId).set({
        id: callId,
        taskId,
        toolName: 'conversations.search',
        status: 'succeeded',
        approvalId: null,
        args: { query: marker, limit: 5 },
        result,
      });
      const storedBefore = (await store.doc('toolCalls', callId).get()).get('result');
      const first = await run('tools.read_result', { toolCallId: callId }, { taskId });
      expect(first).toMatchObject({ offset: 0, hasMore: true });
      const second = await run(
        'tools.read_result',
        { toolCallId: callId, offset: 30_000 },
        { taskId },
      );
      expect(second).toMatchObject({ offset: 30_000, hasMore: false });
      expect(`${String(first.chunk)}${String(second.chunk)}`).toBe(JSON.stringify(result));
      const storedAfter = (await store.doc('toolCalls', callId).get()).get('result');
      expect(JSON.stringify(storedAfter)).toEqual(JSON.stringify(storedBefore));
    });

    it.each(['corrected', 'hidden', 'erased'] as const)(
      'refuses an oversized conversation-search result after its source is %s',
      async (change) => {
        const taskId = randomUUID();
        const callId = randomUUID();
        const conversationId = randomUUID();
        const currentConversationId = randomUUID();
        const messageId = randomUUID();
        const body = `newsletter privacy marker ${'old private body '.repeat(800)}`;
        await store.doc('tasks', taskId).set({
          id: taskId,
          agentId: AGENT,
          status: 'running',
        });
        await store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId: AGENT,
        });
        await store.doc('conversations', currentConversationId).set({
          id: currentConversationId,
          agentId: AGENT,
        });
        await store.doc('messages', messageId).set({
          id: messageId,
          conversationId,
          role: 'user',
          text: body,
          createdAt: earlier,
          hiddenAt: null,
        });
        const conversations = new FirestoreConversationSearchRepository(store, space);
        const matches = await conversations.text({
          agentId: AGENT,
          query: 'privacy marker',
          limit: 5,
          currentConversationId,
        });
        expect(matches).toHaveLength(1);
        const result = {
          mode: 'semantic',
          matches: matches.map((match) => ({ ...match, similarity: 0.9 })),
        };
        expect(JSON.stringify(result).length).toBeGreaterThan(8_000);
        await store.doc('toolCalls', callId).set({
          id: callId,
          taskId,
          toolName: 'conversations.search',
          status: 'succeeded',
          approvalId: null,
          args: { query: 'privacy marker', limit: 5 },
          result,
        });
        const storedResultBefore = (await store.doc('toolCalls', callId).get()).get('result');

        if (change === 'corrected') {
          await store.doc('messages', messageId).update({
            text: 'Owner correction: the old private body was withdrawn.',
          });
        } else if (change === 'hidden') {
          await store.doc('messages', messageId).update({ hiddenAt: now });
        } else {
          // This completed marker models the committed erasure generation; the
          // source predates it and is outside the current task conversation.
          await store.doc('privacyErasureJobs', AGENT).set({
            agentId: AGENT,
            status: 'complete',
            generation: randomUUID(),
          });
        }

        const page = await run('tools.read_result', { toolCallId: callId }, { taskId });
        expect(page).toEqual({
          error:
            'This stored conversation search changed. Run a fresh conversations.search before using its results.',
        });
        expect(JSON.stringify(page)).not.toContain(body);
        const storedResultAfter = (await store.doc('toolCalls', callId).get()).get('result');
        expect(JSON.stringify(storedResultAfter)).toEqual(JSON.stringify(storedResultBefore));
      },
    );

    it('refuses a search result bound to a foreign owner conversation', async () => {
      const taskId = randomUUID();
      const callId = randomUUID();
      const foreignConversationId = randomUUID();
      const messageId = randomUUID();
      const body = `foreign private marker ${'foreign body '.repeat(900)}`;
      await store.doc('tasks', taskId).set({ id: taskId, agentId: AGENT, status: 'running' });
      await store.doc('conversations', foreignConversationId).set({
        id: foreignConversationId,
        agentId: 'another-owner',
      });
      await store.doc('messages', messageId).set({
        id: messageId,
        conversationId: foreignConversationId,
        role: 'user',
        text: body,
        createdAt: earlier,
        hiddenAt: null,
      });
      await store.doc('toolCalls', callId).set({
        id: callId,
        taskId,
        toolName: 'conversations.search',
        status: 'succeeded',
        approvalId: null,
        args: { query: 'foreign private marker', limit: 5 },
        result: {
          mode: 'semantic',
          matches: [
            {
              messageId,
              conversationId: foreignConversationId,
              sourceRevision: conversationMessageSourceRevision(messageId, body),
              text: body,
              createdAt: earlier,
              similarity: 0.9,
            },
          ],
        },
      });
      const page = await run('tools.read_result', { toolCallId: callId }, { taskId });
      expect(page).toEqual({
        error:
          'This stored conversation search changed. Run a fresh conversations.search before using its results.',
      });
      expect(JSON.stringify(page)).not.toContain(body);
    });

    it('falls back to an owned substring search when nothing is embedded', async () => {
      await conversation('mine');
      await conversation('theirs', 'foreign');
      await message('a', 'mine', 'The Kitchen tiles arrived', { embedded: false });
      await message('b', 'mine', 'kitchen quote', { embedded: false, createdAt: now });
      await message('c', 'theirs', 'kitchen secret', { embedded: false, createdAt: now });
      await message('d', 'mine', 'Unrelated', { embedded: false });
      const result = await run('conversations.search', { query: 'KITCHEN', limit: 5 });
      expect(result).toEqual({
        mode: 'text',
        matches: [
          {
            messageId: 'b',
            conversationId: 'mine',
            sourceRevision: conversationMessageSourceRevision('b', 'kitchen quote'),
            text: 'kitchen quote',
            createdAt: now,
          },
          {
            messageId: 'a',
            conversationId: 'mine',
            sourceRevision: conversationMessageSourceRevision('a', 'The Kitchen tiles arrived'),
            text: 'The Kitchen tiles arrived',
            createdAt: earlier,
          },
        ],
      });
    });

    it('reads, sources, and changes owner situation packs through the pack repositories', async () => {
      const commitmentId = randomUUID();
      await store.doc('commitments', commitmentId).set({
        id: commitmentId,
        agentId: AGENT,
        title: 'Hotel reply',
        status: 'open',
        kind: 'waiting_on',
        details: '',
        nextAction: '',
        dueAt: null,
        resolution: null,
        updatedAt: earlier,
      });
      const created = await run('situations.change', {
        action: 'create',
        title: 'Lisbon trip',
        creationKey: 'lisbon',
      });
      expect(created).toMatchObject({ ok: true });
      const packId = String(created.packId);
      expect(
        await run('situations.change', { action: 'create', title: 'Again', creationKey: 'lisbon' }),
      ).toEqual({ ok: true, packId });

      expect(await run('situations.sources', {})).toEqual({
        sources: [
          { kind: 'commitment', id: commitmentId, title: 'Hotel reply', lane: 'waiting_on' },
        ],
      });
      expect(
        await run('situations.change', {
          action: 'item',
          packId,
          version: 1,
          item: {
            id: 'hotel',
            title: 'Hotel',
            lane: 'waiting_on',
            source: { kind: 'commitment', id: commitmentId },
          },
        }),
      ).toEqual({ ok: true, packId });
      expect(
        await run('situations.change', {
          action: 'decision',
          packId,
          version: 2,
          decision: {
            id: 'no_hostel',
            option: 'Hostel Central',
            outcome: 'rejected',
            reason: 'Too noisy',
            scope: 'preference',
          },
        }),
      ).toEqual({
        ok: false,
        error:
          'A lasting preference needs explicit confirmation in the pack. Save it as a situation decision first.',
      });

      const read = (await run('situations.read', { packId })) as {
        pack: { title: string; version: number; data: { items: Array<{ id: string }> } };
      };
      expect(read.pack).toMatchObject({ title: 'Lisbon trip', version: 2 });
      expect(read.pack.data.items.map((item) => item.id)).toEqual(['hotel']);
      expect(((await run('situations.read', {})) as { packs: unknown[] }).packs).toHaveLength(1);
      expect(await run('situations.read', { packId: randomUUID() })).toEqual({ pack: null });

      // Owner-confirmed decisions (from the owner UI) are what the tool recalls.
      await store.doc('situationPacks', packId).update({
        'data.decisions': [
          {
            id: 'no_hostel',
            option: 'Hostel Central',
            outcome: 'rejected',
            reason: 'Too noisy at night',
            scope: 'situation',
            confirmed: true,
          },
        ],
      });
      expect(await run('situations.decisions', { query: 'noisy hotels', packId })).toEqual({
        decisions: [
          {
            id: 'no_hostel',
            option: 'Hostel Central',
            outcome: 'rejected',
            reason: 'Too noisy at night',
            scope: 'situation',
            confirmed: true,
            packId,
            packTitle: 'Lisbon trip',
          },
        ],
      });
      // Without the pack, a situation-scoped choice is not a lasting preference.
      expect(await run('situations.decisions', { query: 'noisy hotels' })).toEqual({
        decisions: [],
      });
      await expect(run('situations.read', {}, { agentId: 'foreign' })).rejects.toThrow(
        'outside the configured Firestore agent',
      );
    });
  },
);
