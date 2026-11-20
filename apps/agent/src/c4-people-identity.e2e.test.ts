import { createHash, randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { executeTask, type ModelRouter } from '@assistant/core';
import {
  createOwnerKnowledgeGraphFact,
  createOwnerKnowledgeGraphFactWithRepository,
} from '@assistant/core/memory/knowledge-graph';
import { resetQueueNotifierForTest } from '@assistant/core/queue';
import {
  approvals,
  contacts,
  conversations,
  createDb,
  createPostgresApplicationChatPersistence,
  createPostgresExecutionPersistence,
  createPostgresMemoryToolRepository,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  memories,
  messages,
  recallSurfaces,
  tasks,
  toolCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import {
  createFirestoreExecutionPersistence,
  FirestoreApplicationChatPersistence,
  FirestoreOwnerKnowledgeGraphFactRepository,
} from '@assistant/firestore';
import {
  type EmbeddingSpace,
  type ExecutionPersistence,
  embeddingSpaceIdentityKey,
  type Records,
} from '@assistant/persistence';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { registerPortableMemoryTools } from '@assistant/tools/builtin';
import { Firestore } from '@google-cloud/firestore';
import { eq, inArray, or } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { contactNameRef } from '../../../packages/firestore/src/contact-lookup.js';
import { FirestoreMemoryRepository } from '../../../packages/firestore/src/memory.js';
import { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'c4',
  dimensions: 1536,
  revision: '1',
};
const embed = async (values: string[]) => values.map(() => [1, ...Array(1535).fill(0)]);
const modelId = 'synthetic/c4';
const daughterName = 'Avery Quinn';
const ownerName = 'Jordan Owner';
const duplicateLabel = "owner's child Avery Quinn";
const alias = 'Avery Q Junior';
const token = 'qa85p2';
const extractionToken = 'qa85p3';
const extractedName = 'Casey Reed';
const extractedLabel = "owner's child Casey Reed";
const sharedName = 'Robin Vale';
const sharedLabel = "owner's child Robin Vale";
const historicalFact = 'The child record includes a prior synthetic note about music lessons.';

const evidenceFor = (subject: string, canonicalName: string, quote: string, content: string) => ({
  subject,
  content,
  personEvidence: { canonicalName, quote },
});
const daughterEvidence = evidenceFor(
  duplicateLabel,
  daughterName,
  `The record "${duplicateLabel}" belongs to my daughter ${daughterName} (avery.child@example.test).`,
  'The retired Avery child record belongs to the daughter.',
);
const newAliasEvidence = evidenceFor(
  alias,
  daughterName,
  `${alias} is another name for my daughter ${daughterName} (avery.child@example.test).`,
  'The daughter also uses the name Avery Q Junior.',
);
const caseyEvidence = evidenceFor(
  extractedLabel,
  extractedName,
  `The record "${extractedLabel}" belongs to my child ${extractedName} (casey.reed@example.test).`,
  'The retired Casey child record belongs to Casey.',
);
const sharedEvidence = evidenceFor(
  sharedLabel,
  sharedName,
  `The record "${sharedLabel}" belongs to my child ${sharedName} (shared.household@example.test).`,
  'The shared address does not independently identify the person.',
);
const conflictEvidence = evidenceFor(
  'Avery Junior',
  daughterName,
  `Avery Junior is another name for my daughter ${daughterName} (avery.work@example.test).`,
  'An Avery identifier conflicts with the existing matching alias.',
);
const aliasCollision = evidenceFor(
  'Avery from work',
  daughterName,
  `Avery from work is another name for my daughter ${daughterName} (avery.child@example.test).`,
  'This claimed alias belongs to a different existing person.',
);
const unspokenClaim = evidenceFor(
  'Avery Orchard',
  daughterName,
  `Avery Orchard is another name for my daughter ${daughterName} (avery.child@example.test).`,
  'A model-supplied alias is unsupported by the chat.',
);
const hypotheticalClaim = evidenceFor(
  'Avery Station',
  daughterName,
  `Avery Station is another name for my daughter ${daughterName} (avery.child@example.test).`,
  'A hypothetical alias does not establish identity.',
);
const actualClaims = [sharedEvidence, conflictEvidence, aliasCollision];
const negativeCases = [...actualClaims, unspokenClaim, hypotheticalClaim];
const nonPersonSentence = 'The warehouse door is blue.';
const sentenceFact = { subject: nonPersonSentence, content: 'The warehouse has a blue door.' };
const existingAliasFact = {
  subject: 'Avery Junior',
  content: 'Avery Junior enjoys music lessons.',
};
const bareHomonymFact = {
  subject: daughterName,
  content: 'Avery Quinn likes drawing.',
};
const tokenFact = { subject: token, content: 'qa85p2 is a warehouse inventory code.' };
const ordinaryConflict = {
  subject: 'Avery Junior',
  content: 'A different Avery Junior uses avery.work@example.test.',
};

const nightlyFact = <T extends { subject: string; content: string }>(candidate: T) => ({
  ...candidate,
  content: `Nightly attribution check: ${candidate.content}`,
});
const directAssertion = (candidate: typeof daughterEvidence) =>
  `Remember that ${candidate.personEvidence.quote}`;
const nightlyHomonymFact = nightlyFact(bareHomonymFact);
const chatCases = [
  { text: directAssertion(daughterEvidence), saved: [daughterEvidence], extracted: [] },
  {
    text: directAssertion(newAliasEvidence),
    saved: [
      {
        ...newAliasEvidence,
        personEvidence: {
          ...newAliasEvidence.personEvidence,
          quote: directAssertion(newAliasEvidence),
        },
      },
    ],
    extracted: [],
  },
  {
    text: directAssertion(caseyEvidence),
    saved: [{ subject: '', content: 'The owner mentioned a Casey record for nightly review.' }],
    extracted: [caseyEvidence],
  },
  ...actualClaims.map((candidate) => ({
    text: directAssertion(candidate),
    saved: [candidate],
    extracted: [nightlyFact(candidate)],
  })),
  {
    text: `Remember that this hypothetical was discussed. Suppose ${hypotheticalClaim.personEvidence.quote} Would the evidence be enough?`,
    saved: [hypotheticalClaim],
    extracted: [nightlyFact(hypotheticalClaim)],
  },
  {
    text: [
      'Remember that these notes apply.',
      nonPersonSentence,
      existingAliasFact.content,
      bareHomonymFact.content,
      ordinaryConflict.content,
      `${token} and ${extractionToken} are warehouse inventory codes.`,
    ].join(' '),
    saved: [
      tokenFact,
      sentenceFact,
      existingAliasFact,
      bareHomonymFact,
      ordinaryConflict,
      unspokenClaim,
    ],
    extracted: [
      nightlyFact(sentenceFact),
      nightlyFact(unspokenClaim),
      nightlyFact(ordinaryConflict),
      nightlyHomonymFact,
      { subject: extractionToken, content: 'The inventory code for the warehouse is qa85p3.' },
    ],
  },
];
const savedFacts = chatCases.flatMap((entry) => entry.saved);
const extractionFacts = chatCases.flatMap((entry) => entry.extracted);

const replayFacts = [
  {
    subject: duplicateLabel,
    content: 'The former Avery child label still identifies the daughter.',
  },
  { subject: alias, content: 'Avery Q Junior enjoys music lessons.' },
];
const replaySource = `Remember that these notes apply. ${replayFacts.map((fact) => `${fact.subject}: ${fact.content}`).join(' ')}`;

function routerFor(
  mode: 'save' | 'recall' | 'extraction',
  confirmedText: string,
  saveInputs: typeof savedFacts = savedFacts,
  homonymContactId?: string,
) {
  let steps = 0;
  let extractionRan = false;
  let confirmedInContext = false;
  const router = {
    embed,
    embeddingSpace: async () => SPACE,
    embeddingSpaceKey: async () => embeddingSpaceIdentityKey(SPACE),
    route: async () => ({
      ok: true,
      model: {},
      modelId,
      degraded: false,
      thinking: false,
      decision: { mode: 'primary' },
      params: {},
      promptCostPerMTok: 0,
      completionCostPerMTok: 0,
    }),
    async object(role: string, input: { prompt: string }) {
      if (role === 'classify')
        return { ok: true, modelId, degraded: false, object: { needsAction: true } };
      const isExtraction =
        mode === 'extraction' && input.prompt.startsWith('Conversation (source trust:');
      const extractionCase = isExtraction
        ? chatCases.find((entry) => input.prompt.includes(`them: ${entry.text}`))
        : undefined;
      if (extractionCase?.text === directAssertion(caseyEvidence)) extractionRan = true;
      const object = isExtraction
        ? {
            facts: (extractionCase?.extracted ?? []).map((fact) => ({
              content: fact.content,
              kind: 'fact',
              category: 'knowledge',
              subject:
                fact.content === nightlyHomonymFact.content && homonymContactId
                  ? { type: 'known_contact', contactId: homonymContactId }
                  : { type: 'new_person_candidate', name: fact.subject },
              relationship: fact.subject === extractionToken ? '' : 'daughter',
              importance: 3,
              confidence: 0.9,
              domain: 'relationships',
              validFrom: '',
              ...('personEvidence' in fact ? { personEvidence: fact.personEvidence } : {}),
            })),
            occasions: [],
          }
        : mode === 'extraction'
          ? { commitments: [], resolvedTitles: [] }
          : role === 'plan'
            ? {
                action: 'workflow',
                reasoning: 'Use the durable memory tools.',
                steps: ['Use the durable memory tools.'],
                missingInfo: [],
              }
            : { decision: 'publish', reasons: [] };
      return { ok: true, modelId, degraded: false, object };
    },
    async step(_role: string, input: { messages: unknown }) {
      const messages = JSON.stringify(input.messages ?? []);
      const step = steps++;
      if (mode === 'recall' && step > 0 && messages.includes(confirmedText))
        confirmedInContext = true;
      const calls =
        mode === 'save'
          ? saveInputs.map((fact) => ({
              toolCallId: randomUUID(),
              toolName: 'memory.save',
              input: { ...fact, category: 'knowledge', kind: 'fact', domain: 'relationships' },
            }))
          : [
              {
                toolCallId: randomUUID(),
                toolName: 'memory.recall',
                input: { query: 'Who is my daughter?', limit: 10 },
              },
            ];
      return {
        ok: true,
        modelId,
        degraded: false,
        text:
          step === 0
            ? ''
            : mode === 'save'
              ? 'I’ve reviewed the notes.'
              : confirmedInContext
                ? `Your daughter is ${daughterName}.`
                : 'I could not verify who your daughter is.',
        toolCalls: step === 0 ? calls : [],
        finishReason: step === 0 ? 'tool-calls' : 'stop',
      };
    },
  } as unknown as ModelRouter;
  return { router, evidence: () => ({ steps, extractionRan, confirmedInContext }) };
}

const unavailableDb = new Proxy(
  {},
  {
    get: (_target, key) => {
      throw new Error(`Unexpected PostgreSQL access in Firestore: ${String(key)}`);
    },
  },
) as Db;

for (const driver of ['postgres', 'firestore'] as const) {
  it.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `C4 acceptance through Assistant chat and fresh clients on ${driver}`,
    async () => {
      const url = process.env.DATABASE_URL;
      assertAllocatedTestTarget({
        databaseUrl: url,
        testDatabaseUrl: process.env.TEST_DATABASE_URL,
        token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
        kind: 'standard',
      });
      if (!url) throw new Error('Expected disposable database URL');
      const databaseUrl = url;
      const isFirestore = driver === 'firestore';
      resetConfigForTest();
      const config = loadConfig({
        NODE_ENV: 'test',
        PERSISTENCE_DRIVER: driver,
        OPENROUTER_API_KEY: 'synthetic-only',
        QUEUE_DRIVER: 'local',
        CHAT_RECALL_ENABLED: 'false',
        GRAPH_RAG_ENABLED: 'false',
      });
      process.env.QUEUE_DRIVER = 'local';
      resetQueueNotifierForTest();
      let db = isFirestore ? unavailableDb : createDb(databaseUrl);
      let store = isFirestore ? emulatorStore() : undefined;
      const agentId = store
        ? randomUUID()
        : (await createPostgresApplicationChatPersistence(db).resolveAgent()).id;
      const getChat = () =>
        store
          ? new FirestoreApplicationChatPersistence(store, agentId)
          : createPostgresApplicationChatPersistence(db);
      const getPersistence = (): ExecutionPersistence =>
        store
          ? createFirestoreExecutionPersistence(store, agentId, SPACE)
          : createPostgresExecutionPersistence(db);
      const [ownerId, daughterId, duplicateId, lookalikeId] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const caseyId = randomUUID();
      const caseyDuplicateId = randomUUID();
      const robinId = randomUUID();
      const sharedDuplicateId = randomUUID();
      const sharedContactId = randomUUID();
      const historicalMemoryId = randomUUID();
      const conversationIds: string[] = [];
      const scheduledTaskIds: string[] = [];
      const seededMemoryIds: string[] = [historicalMemoryId];

      const seed = [
        {
          id: ownerId,
          name: ownerName,
          aliases: [],
          emails: [],
          identityAuthority: 'owner' as const,
          trust: 'owner',
          relationship: 'self',
        },
        {
          id: daughterId,
          name: daughterName,
          aliases: ['Avery Junior'],
          emails: ['avery.child@example.test'],
          identityAuthority: 'owner' as const,
          trust: 'known',
          relationship: 'daughter',
        },
        {
          id: duplicateId,
          name: duplicateLabel,
          aliases: ['Avery Child Record'],
          emails: ['avery.child@example.test'],
          identityAuthority: 'inferred' as const,
          trust: 'unknown',
          relationship: 'child',
        },
        {
          id: lookalikeId,
          name: daughterName,
          aliases: ['Avery from work'],
          emails: ['avery.work@example.test'],
          identityAuthority: 'owner' as const,
          trust: 'known',
          relationship: 'coworker',
        },
        ...[
          { id: caseyId, name: extractedName, email: 'casey.reed@example.test', inferred: false },
          {
            id: caseyDuplicateId,
            name: extractedLabel,
            email: 'casey.reed@example.test',
            inferred: true,
          },
          {
            id: robinId,
            name: sharedName,
            email: 'shared.household@example.test',
            inferred: false,
          },
          {
            id: sharedDuplicateId,
            name: sharedLabel,
            email: 'shared.household@example.test',
            inferred: true,
          },
          {
            id: sharedContactId,
            name: 'Morgan Vale',
            email: 'shared.household@example.test',
            inferred: false,
          },
        ].map(({ id, name, email, inferred }) => ({
          id,
          name,
          aliases: [],
          emails: [email],
          relationship: '',
          identityAuthority: inferred ? ('inferred' as const) : ('owner' as const),
          trust: inferred ? 'unknown' : 'known',
        })),
      ];
      try {
        if (store) {
          await store.doc('agents', agentId).set({
            id: agentId,
            name: ownerName,
            timezone: 'UTC',
            locale: 'en-US',
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          for (const contact of seed)
            await store.doc('contacts', contact.id).set({
              ...contact,
              phones: [],
              notes: '',
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          for (const [label, id] of [
            [duplicateLabel, duplicateId],
            [extractedLabel, caseyDuplicateId],
          ] as const) {
            await contactNameRef(store, label).set({ contactId: id, createdAt: new Date() });
          }
        } else {
          await db.insert(contacts).values(seed);
        }
        const graphInput = {
          subject: { label: daughterName, contactId: daughterId, kind: 'person' as const },
          predicate: 'daughter_of',
          object: { label: ownerName, contactId: ownerId, kind: 'person' as const },
          note: 'My daughter is Avery Quinn.',
        };
        const graphRouter = { embed, embeddingSpace: async () => SPACE };
        const confirmed = store
          ? await createOwnerKnowledgeGraphFactWithRepository(
              {
                repository: new FirestoreOwnerKnowledgeGraphFactRepository(store, SPACE, agentId),
                router: graphRouter,
                agentId,
              },
              graphInput,
            )
          : await createOwnerKnowledgeGraphFact({ db, router: graphRouter, agentId }, graphInput);
        expect(confirmed.error).toBeUndefined();
        if (!confirmed.relationId || !confirmed.memoryId)
          throw new Error('Missing seeded confirmed link IDs');
        const relationId = confirmed.relationId;
        const memoryId = confirmed.memoryId;
        seededMemoryIds.push(memoryId);
        const [embedding] = await embed([historicalFact]);
        const historicalMemory: Records['memories'] = {
          id: historicalMemoryId,
          content: historicalFact,
          contentHash: createHash('sha256').update(historicalFact).digest('hex'),
          agentId,
          kind: 'fact',
          category: 'knowledge',
          originTrust: 'owner',
          quarantined: false,
          subjectContactId: duplicateId,
          ownerConfirmed: false,
          createdAt: new Date(),
          expiresAt: null,
          embedding: embedding ?? null,
          embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
          sourceTaskId: null,
          confidence: '0.90',
          goalId: null,
          importance: 3,
          domain: 'relationships',
          validFrom: null,
          validUntil: null,
          supersededById: null,
          pinned: false,
          source: null,
          lastAccessedAt: null,
          lastConsolidatedAt: null,
        };
        if (store) await new FirestoreMemoryRepository(store, SPACE).save(historicalMemory);
        else await db.insert(memories).values(historicalMemory);

        async function readback() {
          const rows = store
            ? (await store.collection('contacts').get()).docs.map((doc) => doc.data())
            : await db.select().from(contacts);
          const rel = store
            ? (await store.doc('knowledgeGraphRelations', relationId).get()).data()
            : (
                await db
                  .select()
                  .from(knowledgeGraphRelations)
                  .where(eq(knowledgeGraphRelations.id, relationId))
              )[0];
          if (!rel) throw new Error('Missing confirmed relationship');
          async function contactFor(id: string) {
            return store
              ? (await store.doc('knowledgeGraphEntities', id).get()).get('contactId')
              : (
                  await db
                    .select()
                    .from(knowledgeGraphEntities)
                    .where(eq(knowledgeGraphEntities.id, id))
                )[0]?.contactId;
          }
          const facts = store
            ? (await store.collection('memories').where('agentId', '==', agentId).get()).docs.map(
                (doc) => doc.data(),
              )
            : await db.select().from(memories).where(eq(memories.agentId, agentId));
          return {
            contacts: rows
              .filter(
                (row) =>
                  seed.some((s) => s.id === row.id) ||
                  [
                    alias,
                    token,
                    extractionToken,
                    nonPersonSentence,
                    unspokenClaim.subject,
                    hypotheticalClaim.subject,
                  ].includes(row.name),
              )
              .map((row) => ({
                id: row.id,
                name: row.name,
                aliases: row.aliases,
                relationship: row.relationship,
                emails: row.emails,
              }))
              .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
            confirmed: {
              id: rel.id,
              predicate: rel.predicate,
              reviewStatus: rel.reviewStatus,
              memoryId: rel.sourceMemoryId,
              subjectContactId: await contactFor(rel.subjectEntityId),
              objectContactId: await contactFor(rel.objectEntityId),
            },
            memories: facts
              .filter(
                (fact) =>
                  [memoryId, historicalMemoryId].includes(fact.id) ||
                  [...savedFacts, ...extractionFacts, ...replayFacts].some(
                    (f) => f.content === fact.content,
                  ),
              )
              .map((fact) => ({
                id: fact.id,
                content: fact.content,
                subjectContactId: fact.subjectContactId,
                ownerConfirmed: fact.ownerConfirmed,
              }))
              .sort((a, b) => a.content.localeCompare(b.content)),
          };
        }

        function makeDeps(router: ModelRouter) {
          const persistence = getPersistence();
          const registry = registerPortableMemoryTools(new ToolRegistry(), {
            embed,
            memory: store ? persistence.memory : createPostgresMemoryToolRepository(db, SPACE),
          });
          return {
            db,
            persistence,
            router,
            dispatcher: new ToolDispatcher(
              db,
              registry,
              persistence.toolExecution,
              persistence.costs,
              persistence.approvals,
              persistence.approvalPolicies,
            ),
          };
        }

        async function turn(question: string, script: ReturnType<typeof routerFor>) {
          const chat = getChat();
          const conversation = await chat.createConversation(agentId);
          conversationIds.push(conversation.id);
          const operation = randomUUID();
          const request = new Request('https://assistant.example/api/chat', {
            method: 'POST',
            body: JSON.stringify({
              force: question === 'Who is my daughter?',
              conversationId: conversation.id,
              clientOperationId: operation,
              messages: [
                { id: operation, role: 'user', parts: [{ type: 'text', text: question }] },
              ],
            }),
          });
          const deps = makeDeps(script.router);
          const response = await handleChatTurn(request, { ...deps, chat, config });
          const body = await response.text();
          expect(response.status, body).toBe(200);
          const taskId = response.headers.get('x-async-task');
          if (!taskId) throw new Error('Expected async task from chat handler');
          const run = await executeTask(deps, taskId);
          expect(run.outcome, `${question}: ${JSON.stringify(run)}`).toBe('done');
          const page = await chat.listMessages(agentId, conversation.id, { limit: 20 });
          if (!page) throw new Error('Missing chat messages after executing turn');
          return {
            conversationId: conversation.id,
            taskId,
            messages: page.messages.map((row) => ({ role: row.role, text: row.text })),
            ...script.evidence(),
          };
        }

        async function reopen() {
          if (store) {
            const installationId = store.installationId;
            await store.db.terminate();
            store = new InstallationStore(
              new Firestore({ projectId: 'demo-assistant-test', databaseId: '(default)' }),
              installationId,
            );
          } else {
            await db.$client.end();
            db = createDb(databaseUrl);
          }
        }

        const before = await readback();
        expect(before.confirmed).toMatchObject({
          subjectContactId: daughterId,
          objectContactId: ownerId,
          reviewStatus: 'confirmed',
          memoryId,
        });
        const confirmedText = before.memories.find((fact) => fact.id === memoryId)?.content;
        if (!confirmedText) throw new Error('Expected confirmed memory to have content');
        const save = [];
        for (const entry of chatCases)
          save.push(await turn(entry.text, routerFor('save', confirmedText, entry.saved)));
        await reopen();
        const afterSave = await readback();

        const extraction = routerFor('extraction', confirmedText, savedFacts, lookalikeId);
        const extractionDeps = makeDeps(extraction.router);
        const { task } = await extractionDeps.persistence.tasks.createTask({
          agentId,
          type: 'scheduled',
          trust: 'assistant',
          trigger: { source: 'schedule', payload: { job: 'memory.extract' } },
        });
        scheduledTaskIds.push(task.id);
        const run = await executeTask(extractionDeps, task.id);
        expect(run.outcome, JSON.stringify(run)).toBe('done');
        expect(extraction.evidence().extractionRan).toBe(true);
        await reopen();
        const afterExtraction = await readback();
        let staleSubjectWrite: { id: string; subjectContactId: string | null } | undefined;
        if (store) {
          const id = randomUUID();
          const content =
            'An unrelated fact arrived after a previous writer read the old contact ID.';
          const written = await new FirestoreMemoryRepository(store, SPACE).save({
            ...historicalMemory,
            id,
            content,
            contentHash: createHash('sha256').update(content).digest('hex'),
            subjectContactId: duplicateId,
          });
          expect(written).toBe(true);
          await reopen();
          if (!store) throw new Error('Expected reconnected Firestore client');
          const stored = await store.doc('memories', id).get();
          staleSubjectWrite = { id, subjectContactId: stored.get('subjectContactId') };
          expect(staleSubjectWrite.subjectContactId).toBeNull();
          for (const [label, id] of [
            [duplicateLabel, daughterId],
            [extractedLabel, caseyId],
          ] as const) {
            const marker = await contactNameRef(store, label).get();
            expect(marker.exists).toBe(true);
            expect(marker.get('contactId')).toBe(id);
          }
        }
        const replay = await turn(replaySource, routerFor('save', confirmedText, replayFacts));
        await reopen();
        const afterReplay = await readback();
        const recall = await turn('Who is my daughter?', routerFor('recall', confirmedText));
        await reopen();
        const persisted = await getChat().listMessages(agentId, recall.conversationId, {
          limit: 20,
        });
        if (!persisted) throw new Error('Missing fresh chat messages after reconnect');
        const evidence = {
          driver,
          ids: {
            ownerId,
            daughterId,
            duplicateId,
            lookalikeId,
            caseyId,
            caseyDuplicateId,
            robinId,
            sharedDuplicateId,
            sharedContactId,
            historicalMemoryId,
          },
          before,
          save,
          afterSave,
          extraction: { taskId: task.id, outcome: run.outcome },
          afterExtraction,
          staleSubjectWrite,
          replay,
          afterReplay,
          recall,
          reopenedAnswer: persisted.messages.find((row) => row.role === 'assistant')?.text,
        };
        console.log(`C4_EVIDENCE ${JSON.stringify(evidence)}`);
        const contactAt = (state: typeof before, id: string) =>
          state.contacts.find((row) => row.id === id);
        const factAt = (state: typeof before, content: string) =>
          state.memories.find((fact) => fact.content === content);
        const daughterBefore = contactAt(before, daughterId);
        expect(daughterBefore?.aliases).toEqual(['Avery Junior']);
        const historicalBefore = factAt(before, historicalFact);
        expect(historicalBefore).toMatchObject({
          id: historicalMemoryId,
          subjectContactId: duplicateId,
        });
        for (const state of [afterSave, afterExtraction]) {
          expect(state.confirmed).toEqual(before.confirmed);
          for (const id of [ownerId, lookalikeId, robinId, sharedContactId, sharedDuplicateId])
            expect(contactAt(state, id)).toEqual(contactAt(before, id));
          expect(contactAt(state, duplicateId)).toBeUndefined();
          expect(contactAt(state, daughterId)).toMatchObject({
            name: daughterName,
            relationship: 'daughter',
            emails: daughterBefore?.emails,
            aliases: expect.arrayContaining([
              'Avery Junior',
              'Avery Child Record',
              duplicateLabel,
              alias,
            ]),
          });
          expect(contactAt(state, daughterId)?.aliases).toHaveLength(4);
          expect(factAt(state, historicalFact)).toEqual({
            ...historicalBefore,
            subjectContactId: daughterId,
          });
          expect(
            state.contacts.filter((row) =>
              [
                token,
                extractionToken,
                alias,
                nonPersonSentence,
                unspokenClaim.subject,
                hypotheticalClaim.subject,
              ].includes(row.name),
            ),
          ).toEqual([]);
        }
        expect(contactAt(afterSave, caseyDuplicateId)).toEqual(contactAt(before, caseyDuplicateId));
        expect(contactAt(afterExtraction, caseyDuplicateId)).toBeUndefined();
        expect(contactAt(afterExtraction, caseyId)?.aliases).toEqual([extractedLabel]);
        for (const candidate of [daughterEvidence, newAliasEvidence])
          expect(factAt(afterSave, candidate.content)?.subjectContactId).toBe(daughterId);
        for (const candidate of [
          ...negativeCases,
          tokenFact,
          sentenceFact,
          bareHomonymFact,
          ordinaryConflict,
        ])
          expect(factAt(afterSave, candidate.content)?.subjectContactId).toBeNull();
        expect(factAt(afterSave, existingAliasFact.content)?.subjectContactId).toBe(daughterId);
        expect(factAt(afterExtraction, caseyEvidence.content)?.subjectContactId).toBe(caseyId);
        for (const candidate of extractionFacts.slice(1))
          expect(factAt(afterExtraction, candidate.content)?.subjectContactId).toBeNull();
        expect(afterReplay.contacts).toEqual(afterExtraction.contacts);
        expect(afterReplay.confirmed).toEqual(before.confirmed);
        for (const candidate of replayFacts)
          expect(factAt(afterReplay, candidate.content)?.subjectContactId).toBe(daughterId);
        expect(recall.confirmedInContext).toBe(true);
        expect(evidence.reopenedAnswer).toBe('Your daughter is Avery Quinn.');
      } finally {
        if (store) await disposeStore(store);
        else {
          try {
            await db.transaction(async (tx) => {
              const taskRows = await tx
                .select({ id: tasks.id })
                .from(tasks)
                .where(inArray(tasks.conversationId, conversationIds));
              const taskIds = [...scheduledTaskIds, ...taskRows.map((row) => row.id)];
              const contactIds = seed.map((person) => person.id);
              await tx
                .delete(memories)
                .where(
                  or(
                    inArray(memories.id, seededMemoryIds),
                    inArray(memories.sourceTaskId, taskIds),
                  ),
                );
              await tx
                .delete(knowledgeGraphEntities)
                .where(inArray(knowledgeGraphEntities.contactId, contactIds));
              await tx.delete(contacts).where(inArray(contacts.id, contactIds));
              const messageRows = await tx
                .select({ id: messages.id })
                .from(messages)
                .where(inArray(messages.conversationId, conversationIds));
              await tx.delete(recallSurfaces).where(
                inArray(
                  recallSurfaces.lastMessageId,
                  messageRows.map((row) => row.id),
                ),
              );
              await tx.delete(messages).where(inArray(messages.conversationId, conversationIds));
              await tx
                .update(toolCalls)
                .set({ approvalId: null })
                .where(inArray(toolCalls.taskId, taskIds));
              await tx.delete(approvals).where(inArray(approvals.taskId, taskIds));
              await tx.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
              await tx.delete(tasks).where(inArray(tasks.id, taskIds));
              await tx.delete(conversations).where(inArray(conversations.id, conversationIds));
            });
          } finally {
            await db.$client.end();
          }
        }
      }
    },
    60_000,
  );
}
