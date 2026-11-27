import { randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { type ExecutorDeps, executeTask, runBriefing } from '@assistant/core';
import {
  assertPostgresInstallationOwner,
  conversations,
  createPostgresApplicationChatPersistence,
  createPostgresExecutionPersistence,
  type Db,
  emailBookingOccurrences,
  messages,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreApplicationChatPersistence,
} from '@assistant/firestore';
import {
  approvalPolicyFingerprint,
  type ExecutionPersistence,
  emailBookingKey,
  notificationLeg,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const SPACE = { provider: 'synthetic', model: 'booking-fixture', dimensions: 1536, revision: '1' };
const SUBJECT = 'Lantern Hotel booking confirmation';
const HEALTH = 'Medical diagnosis: G1-health-marker.';
const HEALTH_CONTEXT = 'The hotel stay follows an asthma operation.';
const HOTEL_MENTION = 'The hotel lobby ceiling is painted with g1-violets.';
const INTIMATE = 'Intimate preference: G1-intimate-marker.';
const FINANCE = 'Bank loan balance: $968.17.';
const HISTORY = 'Prescription from an old conversation: G1-old-marker.';
const DEPOSIT = 'Deposit: $113.28';
const TOTAL = 'Reservation total: $234.56';
const MIXED_TOTAL = `${TOTAL}, and my g1-jasper credit note should stay private.`;
const UNBOUND_TOTAL = 'Total $987.65.';
const LOGISTICS = 'Lantern Hotel check-in is October 24, 2027 at 3:00 PM.';
const CHECKOUT = 'Check-out: October 27, 2027 at noon.';
const TIMED_FIELD = 'Check-in: 3 PM';
const MIXED_FIELD = `${TIMED_FIELD}, and I carry an insulin pump.`;
const DUPLICATE_FIELD = `${TIMED_FIELD}, with my glucose monitor packed for the journey.`;
const ADDRESS = 'Address: 14 Lantern Avenue';
const MIXED_ADDRESS = `${ADDRESS} because my partner keeps g1-saffron journals there.`;
const MIXED_SUBJECT = `${SUBJECT} g1-twilight arrangement is underway`;
const REFERENCE = 'Booking reference: G1LANTERN';
const MIXED_REFERENCE = `${REFERENCE}, I keep g1-silver reminders.`;
const MIXED_DATE_LABEL = 'Lantern Hotel check-in requires g1-orchid supplies.';
const THREAD = 'g1-lantern-thread';
const MESSAGE = 'g1-lantern-message';
const UNLABELLED = 'G1-unlabelled-marker.';
const BODY = [
  LOGISTICS,
  CHECKOUT,
  MIXED_TOTAL,
  MIXED_FIELD,
  MIXED_ADDRESS,
  MIXED_REFERENCE,
  HEALTH,
  DUPLICATE_FIELD,
  HEALTH_CONTEXT,
  HOTEL_MENTION,
  UNLABELLED,
  INTIMATE,
  FINANCE,
  DEPOSIT,
].join('\n');
const FORBIDDEN = [
  'G1-health-marker',
  'asthma operation',
  'insulin pump',
  'glucose monitor',
  'g1-jasper',
  '987.65',
  '345.67',
  'g1-saffron',
  'g1-twilight',
  'g1-orchid',
  'g1-silver',
  'g1-violets',
  'G1-intimate-marker',
  '968.17',
  'G1-old-marker',
  'G1-unlabelled-marker',
  '692.77',
];

const noSql = new Proxy(
  {},
  {
    get() {
      throw new Error('Firestore admission attempted to use PostgreSQL');
    },
  },
) as Db;

interface Saved {
  text: unknown;
  parts: unknown;
}

async function fixture(driver: 'postgres' | 'firestore') {
  const conversationId = randomUUID();
  if (driver === 'postgres') {
    const { db, close } = await createIsolatedTestDatabase();
    const agentId = await assertPostgresInstallationOwner(db);
    await db
      .insert(conversations)
      .values({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
    return {
      db,
      close,
      agentId,
      conversationId,
      persistence: createPostgresExecutionPersistence(db),
      chat: createPostgresApplicationChatPersistence(db),
      installationId: undefined,
      async saved(taskId: string): Promise<Saved[]> {
        return db
          .select({ text: messages.text, parts: messages.parts })
          .from(messages)
          .where(and(eq(messages.taskId, taskId), eq(messages.role, 'assistant')));
      },
      async addBooking(row: typeof emailBookingOccurrences.$inferInsert) {
        await db.insert(emailBookingOccurrences).values(row);
      },
    };
  }
  const store = emulatorStore();
  const agentId = randomUUID();
  const now = new Date();
  await seedBudget(store);
  await store.doc('agents', agentId).set({
    id: agentId,
    name: 'Synthetic assistant',
    email: 'assistant@example.invalid',
    signature: '',
    locale: 'en',
    timezone: 'UTC',
    createdAt: now,
    updatedAt: now,
  });
  await store.doc('conversations', conversationId).set({
    id: conversationId,
    agentId,
    channel: 'chat',
    trust: 'owner',
    createdAt: now,
    updatedAt: now,
  });
  return {
    db: noSql,
    close: () => disposeStore(store),
    agentId,
    conversationId,
    persistence: createFirestoreExecutionPersistence(store, agentId, SPACE),
    chat: new FirestoreApplicationChatPersistence(store, agentId),
    installationId: store.installationId,
    async saved(taskId: string): Promise<Saved[]> {
      const result = await store.collection('messages').where('taskId', '==', taskId).get();
      return result.docs
        .filter((doc) => doc.get('role') === 'assistant')
        .map((doc) => ({ text: doc.get('text'), parts: doc.get('parts') }));
    },
    async addBooking(row: typeof emailBookingOccurrences.$inferInsert) {
      await store
        .doc('emailBookingOccurrences', row.bookingKey)
        .set({ ...row, id: row.bookingKey });
    },
  };
}

function dispatcher(
  persistence: ExecutionPersistence,
  messageBody: () => string,
  completeRead: () => boolean,
): ExecutorDeps['dispatcher'] {
  return {
    toolDefs: () =>
      ['gmail.search', 'gmail.read_thread'].map((name) => ({
        name,
        description: 'Synthetic Gmail lookup',
        inputSchema: {} as never,
      })),
    resultIsUntrusted: () => true,
    async dispatch(input) {
      if (input.toolName === 'gmail.search') {
        expect(String(input.args.query)).toMatch(
          /^(?:"Lantern Hotel" \{booking reservation confirmation\}|G1LANTERN)$/i,
        );
      } else {
        expect(input.toolName).toBe('gmail.read_thread');
        expect(input.args.threadId).toBe(THREAD);
      }
      const result =
        input.toolName === 'gmail.search'
          ? {
              results: [
                {
                  threadId: THREAD,
                  messageId: MESSAGE,
                  from: 'desk@example.invalid',
                  subject: `${MIXED_SUBJECT}\n${HEALTH_CONTEXT}`,
                  snippet: `${LOGISTICS} ${MIXED_FIELD} ${HEALTH_CONTEXT} ${HOTEL_MENTION}\n${HEALTH}\n${FINANCE}\nDeposit: $692.77`,
                  date: '2027-10-24',
                },
              ],
              complete: true,
              hasMore: false,
              mailboxSearched: 'owner@example.invalid',
            }
          : {
              threadId: THREAD,
              complete: completeRead(),
              truncated: !completeRead(),
              totalMessages: 1,
              messages: [
                {
                  messageId: MESSAGE,
                  from: 'desk@example.invalid',
                  subject: `${MIXED_SUBJECT}\n${HEALTH_CONTEXT}`,
                  text: messageBody(),
                  date: '2027-10-24',
                  sourceLength: messageBody().length,
                  truncated: false,
                },
              ],
            };
      const receipt = await persistence.toolExecution.start({
        agentId: input.task.agentId,
        taskId: input.task.id,
        step: input.step,
        toolName: input.toolName,
        args: input.args,
        idempotencyKey: null,
        decision: { modelToolCallId: input.modelToolCallId },
        expectedPolicyFingerprint: approvalPolicyFingerprint([]),
      });
      if (!receipt) throw new Error('Synthetic tool call was not persisted');
      const written = await persistence.toolExecution.outcome({
        agentId: input.task.agentId,
        taskId: input.task.id,
        toolCallId: receipt.id,
        status: 'succeeded',
        fromStatus: 'executing',
        result,
      });
      if (!written) throw new Error('Synthetic tool result was not persisted');
      return { kind: 'executed', toolCallId: receipt.id, result, cached: false };
    },
    async executeApproved() {
      throw new Error('Fixture has no outward actions');
    },
  };
}

function expectWithheld(value: unknown) {
  const record = JSON.stringify(value);
  for (const marker of FORBIDDEN) expect(record).not.toContain(marker);
  expect(record).not.toContain('113.28');
}

describe.each([
  { driver: 'postgres' as const, enabled: Boolean(process.env.ASSISTANT_TEST_TARGET_TOKEN) },
  {
    driver: 'firestore' as const,
    enabled: /^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''),
  },
])('G1 booking disclosure on $driver', ({ driver, enabled }) => {
  it.skipIf(!enabled)(
    'keeps synthetic private clauses out of model input and new durable answers and briefings',
    async () => {
      const {
        agentId,
        db,
        persistence,
        conversationId,
        chat,
        installationId,
        close,
        saved,
        addBooking,
      } = await fixture(driver);
      let mailBody = BODY;
      let readComplete = true;
      const inputs: unknown[] = [];
      const previews: unknown[] = [];
      let briefingLead = `Your Lantern Hotel check-in is coming up. ${HEALTH_CONTEXT}`;
      const router = {
        async object(role: string, input: unknown) {
          inputs.push(input);
          const object =
            role === 'classify'
              ? { trivial: false }
              : role === 'plan'
                ? {
                    action: 'reply',
                    reasoning: 'Look up the requested booking.',
                    steps: [],
                    missingInfo: [],
                  }
                : role === 'draft'
                  ? { lead: briefingLead }
                  : { decision: 'publish', reasons: [] };
          return { ok: true, modelId: 'synthetic/g1', object, degraded: false };
        },
        async step(_role: string, input: unknown) {
          inputs.push(input);
          return {
            ok: true,
            modelId: 'synthetic/g1',
            text: `${LOGISTICS}\n${HEALTH_CONTEXT}`,
            toolCalls: [],
            finishReason: 'stop',
            degraded: false,
          };
        },
        async embeddingSpace() {
          return SPACE;
        },
        async embed(texts: string[]) {
          return texts.map(() => Array(1536).fill(0.01));
        },
      } as unknown as ExecutorDeps['router'];
      const deps = {
        db,
        persistence,
        router,
        dispatcher: dispatcher(
          persistence,
          () => mailBody,
          () => readComplete,
        ),
      };
      try {
        await persistence.messages.append({
          conversationId,
          role: 'user',
          origin: 'owner',
          text: HISTORY,
          parts: [{ type: 'text', text: HISTORY }],
        });
        const config = loadConfig({
          NODE_ENV: 'test',
          PERSISTENCE_DRIVER: driver,
          FIRESTORE_AGENT_ID: driver === 'firestore' ? agentId : undefined,
          ASSISTANT_WORKSPACE_ID: installationId,
          FIRESTORE_EMBEDDING_SPACE: driver === 'firestore' ? JSON.stringify(SPACE) : undefined,
          OPENROUTER_API_KEY: 'synthetic-not-a-real-key',
          QUEUE_DRIVER: 'local',
          CHAT_RECALL_ENABLED: 'true',
        });
        const admissionClassify = vi.fn(async () => {
          throw new Error('Booking admission must not send old turns to a classifier');
        });
        const admissionRouter = {
          route: async () => ({ ok: true }),
          object: admissionClassify,
        } as unknown as ExecutorDeps['router'];
        async function ask(text: string) {
          const operationId = randomUUID();
          const response = await handleChatTurn(
            new Request('http://assistant.local/api/chat', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                conversationId,
                clientOperationId: operationId,
                messages: [{ id: operationId, role: 'user', parts: [{ type: 'text', text }] }],
              }),
            }),
            {
              config,
              router: admissionRouter,
              chat,
              persistence,
              ...(driver === 'postgres' ? { db } : {}),
            },
          );
          await response.text();
          expect(response.status).toBe(200);
          const taskId = response.headers.get('x-async-task');
          if (!taskId) throw new Error('Fresh booking lookup was not queued');
          await executeTask(deps, taskId);
          const replies = await saved(taskId);
          expect(replies).toHaveLength(1);
          expect(admissionClassify).not.toHaveBeenCalled();
          return replies[0];
        }
        const ordinary = await ask(
          'Read the Lantern Hotel confirmation email and tell me what time check-in is.',
        );
        expect(ordinary?.text).toMatch(/Lantern Hotel/);
        expect(ordinary?.text).toMatch(/3:00 PM/);
        expectWithheld(ordinary);
        expect(JSON.stringify(ordinary)).not.toContain('234.56');
        const details = await ask(
          'Read the Lantern Hotel confirmation email and tell me the details of my hotel reservation.',
        );
        expect(details?.text).toContain(TOTAL);
        expect(details?.text).toContain(THREAD);
        expectWithheld(details);

        const saveRequest = 'Save a card for my hotel booking in my inbox under G1LANTERN';
        const card = await ask(saveRequest);
        expect(JSON.stringify(card?.parts)).toContain('generated-card');
        expect(JSON.stringify(card?.parts)).toContain(LOGISTICS);
        expectWithheld(card);
        const cardPart = (
          (card?.parts ?? []) as Array<{ type: string; data?: { id: string } }>
        ).find((part) => part.type === 'data-card' && part.data?.id);
        if (!cardPart?.data) throw new Error('Generated card identity was not saved in the reply');
        const savedCard = await persistence.generatedCards?.get(agentId, cardPart.data.id);
        expect(JSON.stringify(savedCard?.revision.spec)).toContain(LOGISTICS);
        expect(JSON.stringify(savedCard?.revision.spec)).toContain(CHECKOUT);
        const spec = savedCard?.revision.spec as
          | { facts: Array<{ id: string; value: string }> }
          | undefined;
        expect(
          spec?.facts.filter((fact) => fact.id === 'check-in').map((fact) => fact.value),
        ).toEqual([LOGISTICS]);
        expect(JSON.stringify(savedCard?.revision.spec)).toContain(ADDRESS);
        expect(JSON.stringify(savedCard?.revision.spec)).toContain(TOTAL);
        expectWithheld(savedCard);

        const locationFields = Array.from(
          { length: 10 },
          (_, index) => `Location: Lantern Annex ${index}`,
        );
        mailBody = [BODY, ...locationFields, ...Array<string>(40).fill(DUPLICATE_FIELD)].join('\n');
        const longCard = await ask(saveRequest);
        expect(JSON.stringify(longCard?.parts)).toContain('generated-card');
        expect(JSON.stringify(longCard?.parts)).toContain(LOGISTICS);
        expect(JSON.stringify(longCard?.parts)).toContain(CHECKOUT);
        expect(JSON.stringify(longCard?.parts)).toContain(ADDRESS);
        expectWithheld(longCard);
        const longCardPart = (
          (longCard?.parts ?? []) as Array<{
            data?: {
              kind?: string;
              spec?: { facts: Array<{ value: string }>; blocks: Array<{ factIds: string[] }> };
            };
          }>
        ).find((part) => part.data?.kind === 'generated-card');
        expect(longCardPart?.data?.spec?.blocks[0]?.factIds).toHaveLength(8);
        expect(longCardPart?.data?.spec?.facts.every((fact) => fact.value.length <= 500)).toBe(
          true,
        );

        mailBody = `${BODY}\nCheck-in: 4 PM`;
        const conflictingCard = await ask(saveRequest);
        expect(conflictingCard?.text).toMatch(/couldn't create and save/);
        expect(JSON.stringify(conflictingCard?.parts)).not.toContain('generated-card');
        expectWithheld(conflictingCard);

        mailBody = `${BODY.replace(MIXED_TOTAL, '')}\nUnrelated receipt note.\n${UNBOUND_TOTAL}`;
        const unverifiedTotalCard = await ask(saveRequest);
        expect(JSON.stringify(unverifiedTotalCard?.parts)).toContain('generated-card');
        expect(JSON.stringify(unverifiedTotalCard?.parts)).not.toContain('234.56');
        expectWithheld(unverifiedTotalCard);

        mailBody = `${BODY}\nHotel total: $345.67.`;
        const ambiguousTotalCard = await ask(saveRequest);
        expect(JSON.stringify(ambiguousTotalCard?.parts)).toContain('generated-card');
        expect(JSON.stringify(ambiguousTotalCard?.parts)).not.toMatch(/234\.56|345\.67/);
        expectWithheld(ambiguousTotalCard);

        mailBody = `Lantern Hotel reservation confirmation. ${HEALTH_CONTEXT}`;
        const propertyCard = await ask(saveRequest);
        expect(JSON.stringify(propertyCard?.parts)).toContain('generated-card');
        expect(JSON.stringify(propertyCard?.parts)).toContain('Lantern Hotel');
        expectWithheld(propertyCard);

        mailBody = BODY;
        readComplete = false;
        const incompleteCard = await ask(saveRequest);
        expect(JSON.stringify(incompleteCard?.parts)).not.toContain('generated-card');
        expectWithheld(incompleteCard);
        expect(JSON.stringify(incompleteCard)).not.toContain('234.56');
        readComplete = true;
        const explicit = await ask(
          'Read the Lantern Hotel confirmation email and tell me the deposit amount.',
        );
        expect(explicit?.text).toContain('Deposit: $113.28');
        expect(explicit?.text).toContain(THREAD);
        expect(explicit?.text).not.toContain('234.56');
        for (const marker of FORBIDDEN) expect(JSON.stringify(explicit)).not.toContain(marker);
        mailBody = BODY.replace(DEPOSIT, '');
        const noDeposit = await ask(
          'Read the Lantern Hotel confirmation email and tell me the deposit amount.',
        );
        expect(noDeposit?.text).toContain('could not verify the deposit');
        expectWithheld(noDeposit);
        expect(inputs.some((input) => JSON.stringify(input).includes(LOGISTICS))).toBe(true);
        expect(
          inputs.some((input) => {
            const payload = JSON.stringify(input);
            return (
              payload.includes(THREAD) && payload.includes(MESSAGE) && payload.includes(LOGISTICS)
            );
          }),
        ).toBe(true);
        expect(inputs.some((input) => JSON.stringify(input).includes(REFERENCE))).toBe(true);
        expectWithheld(inputs);
        expect(JSON.stringify(inputs)).not.toContain('234.56');

        const now = new Date();
        const checkIn = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const bookingKey = emailBookingKey(agentId, 'G1LANTERN');
        await persistence.emailSync?.recordIngest({
          agentId,
          conversationId,
          channelMessageId: MESSAGE,
          fromEmail: 'desk@example.invalid',
          fromName: 'Lantern Hotel',
          subject: `${MIXED_SUBJECT}\n${HEALTH_CONTEXT}\n${FINANCE}`,
          category: 'travel',
          importance: 5,
          contentTrust: 'known',
          authenticated: true,
          actionable: false,
          reason: 'Booking',
          dates: [],
          messagePersisted: true,
        });
        await addBooking({
          agentId,
          bookingKey,
          sourceChannelMessageId: MESSAGE,
          sourceReceivedAt: now,
          sourceAuthenticated: true,
          lifecycle: 'confirmed',
          version: 1,
          dates: [
            {
              iso: checkIn.toISOString(),
              what: `${MIXED_DATE_LABEL}\n${HEALTH_CONTEXT}\n${INTIMATE}\n${DEPOSIT}\n${MIXED_TOTAL}`,
              dateRole: 'event_start',
              lifecycle: 'confirmed',
              bookingIdentity: 'G1LANTERN',
            },
          ],
          createdAt: now,
          updatedAt: now,
        });
        for (const composedFallback of [false, true]) {
          if (composedFallback) briefingLead = HEALTH_CONTEXT;
          const { task } = await persistence.tasks.createTask({
            agentId,
            type: 'scheduled',
            trust: 'assistant',
            trigger: { source: 'schedule', payload: { job: 'briefing.compose' } },
          });
          const result = await runBriefing(
            {
              ...deps,
              calendarReader: async () => ({ events: [], complete: true }),
              notifyOwner: vi.fn(async (input) => {
                previews.push(input);
                return notificationLeg('phone', 'skipped', 'synthetic-preview');
              }),
            },
            { agentId, taskId: task.id, now },
          );
          expect(result).toMatchObject({
            delivered: true,
            composedFallback,
            upcoming: 1,
            highlights: 1,
          });
          const briefings = await saved(task.id);
          expect(briefings).toHaveLength(1);
          expect(briefings[0]?.text).toContain('Lantern Hotel check-in');
          expect(JSON.stringify(briefings[0]?.parts)).toContain('"kind":"briefing"');
          expectWithheld(briefings);
          expect(JSON.stringify(briefings)).not.toContain('234.56');
        }
        expectWithheld(inputs);
        expect(previews).toHaveLength(2);
        expectWithheld(previews);
        expect(JSON.stringify(inputs)).not.toContain('234.56');
      } finally {
        await close();
      }
    },
    60_000,
  );
});
