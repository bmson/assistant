import { randomUUID } from 'node:crypto';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import {
  applicationConfirmationTaskHandlers,
  applicationPersistence,
  type EmailSyncDeps,
  executeApplicationConfirmationTask,
  processApplicationConfirmation,
  processMessage,
} from '@assistant/modules';
import type { ExecutionPersistence } from '@assistant/persistence';
import type { ToolContext } from '@assistant/tools';
import {
  type GoogleClient,
  parseApplicationActionState,
  registerApplicationTools,
  ToolRegistry,
} from '@assistant/tools';
import { ToolDispatcher } from '@assistant/tools/dispatcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { drainEmailObservers } from '../../../packages/modules/src/email-observers.js';
import { reapExpiredApplicationWatches } from '../../../packages/modules/src/google/application-confirmations.js';
import { googleDurableEmailObservers } from '../../../packages/modules/src/google/durable-email-observers.js';

const SPACE = { provider: 'synthetic', model: 'apps-fixture', dimensions: 1536, revision: '1' };
const SENDER = 'careers@acme.test';
const HOUR = 3_600_000;
const directAdmissionObserverIdentities = googleDurableEmailObservers({
  api: vi.fn(),
  configured: () => true,
} as unknown as GoogleClient)
  .map(({ identity }) => `${identity.key}@${identity.version}:${identity.workClass}`)
  .filter((identity) => !identity.startsWith('google.application-confirmation@'))
  .sort();

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore application confirmations',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let registry: ToolRegistry;
    let dispatcher: ToolDispatcher;
    let api: ReturnType<typeof vi.fn>;
    let notices: string[];
    const db = new Proxy({} as Db, {
      get: (_target, property) => {
        throw new Error(`PostgreSQL access in Firestore test: ${String(property)}`);
      },
    });

    beforeEach(async () => {
      store = emulatorStore();
      notices = [];
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      api = vi.fn(async (url: string) =>
        url.includes('docs.googleapis.com') && !url.endsWith(':batchUpdate')
          ? { body: { content: [{ endIndex: 1 }] } }
          : {},
      );
      const apps = applicationPersistence(persistence);
      registry = registerApplicationTools(new ToolRegistry(), {
        client: { api, configured: () => true } as unknown as GoogleClient,
        applications: apps.applications,
        tasks: persistence.tasks,
      });
      dispatcher = new ToolDispatcher(
        db,
        registry,
        persistence.toolExecution,
        persistence.costs,
        persistence.approvals,
        persistence.approvalPolicies,
      );
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Ada',
        email: 'owner@example.test',
        timezone: 'UTC',
      });
      await store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    const deps = () => ({
      db,
      dispatcher,
      persistence: applicationPersistence(persistence),
      notifyOwner: async (input: { text: string }) => {
        notices.push(input.text);
      },
    });

    async function ownerTask() {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'adhoc',
        trust: 'owner',
        trigger: { source: 'owner', payload: { instruction: 'apply to acme' } },
      });
      return task;
    }

    function ctx(taskId: string, conversationId?: string): ToolContext {
      return {
        taskId,
        agentId,
        conversationId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
      };
    }

    async function watch(token: string, extra: Record<string, unknown> = {}) {
      const tool = registry.get('applications.watch_confirmation')?.tool;
      if (!tool) throw new Error('missing watch tool');
      const task = await ownerTask();
      return tool.execute(
        {
          company: 'Acme',
          role: 'Engineer',
          expectedSenderEmails: [SENDER],
          confirmationToken: token,
          expiresAt: new Date(Date.now() + 48 * HOUR).toISOString(),
          trackerUpdate: {
            spreadsheetId: 'sheet-1234567890',
            sheetName: 'Applications',
            startCell: 'A2',
            rows: [['Acme', 'Engineer', 'confirmed']],
          },
          documentUpdate: { documentId: 'doc-1234567890', content: 'Acme confirmed receipt.' },
          ...extra,
        },
        ctx(task.id),
      ) as Promise<{ applicationId: string; conversationId: string; status: string }>;
    }

    const email = (messageId: string, body: string, from = SENDER) =>
      processApplicationConfirmation(deps(), {
        agentId,
        messageId,
        from,
        subject: 'Application received',
        body,
        authenticated: true,
      });

    async function admitAndDrainEmail(messageId: string, body: string, from = SENDER) {
      const priorRecord = await persistence.applications?.byConfirmationMessage(
        agentId,
        `gmail:${messageId}`,
      );
      const client = {
        configured: () => true,
        api: vi.fn(async (url: string) => {
          if (!url.includes(`/messages/${messageId}?`))
            throw new Error(`unexpected ingress Google API call: ${url}`);
          return {
            id: messageId,
            threadId: `thread-${messageId}`,
            labelIds: ['INBOX'],
            snippet: body.slice(0, 40),
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: from },
                { name: 'Subject', value: 'Application received' },
                { name: 'Message-ID', value: `<${messageId}@mail.test>` },
                {
                  name: 'Authentication-Results',
                  value: `mx.google.com; dmarc=pass header.from=${from.split('@')[1]}`,
                },
              ],
              body: { data: Buffer.from(body).toString('base64url') },
            },
          };
        }),
      } as unknown as GoogleClient;
      const config = {
        ASSISTANT_MODULES: ['google'],
        GMAIL_SYNC_ENABLED: 'true',
        EMAIL_OBSERVER_WORKER_ENABLED: true,
        EMAIL_INGEST_MODE: 'direct',
        EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
        EMAIL_INGEST_NOTIFY_THRESHOLD: 5,
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 20,
        EMAIL_OBSERVER_MAX_PAID_PER_DAY: 20,
        GENERATIVE_CARDS_ENABLED: false,
      };
      const router = {
        embeddingSpace: async () => SPACE,
        object: async () => ({
          ok: true,
          object: {
            category: 'transactional',
            importance: 3,
            actionable: false,
            reason: 'Synthetic application confirmation.',
            dates: [],
            cardCandidate: false,
          },
        }),
        embed: async (texts: string[]) => texts.map(() => new Array(1536).fill(0)),
      };
      const durableEmailObservers = googleDurableEmailObservers(client);
      const emailDeps = {
        config,
        db,
        dispatcher,
        persistence,
        router,
        registry,
        workspace: {},
        googleClient: client,
        notifyOwner: async (input: { text: string }) => {
          notices.push(input.text);
        },
        observeInboundEmail: async () => {},
        durableEmailObservers,
      } as unknown as EmailSyncDeps;
      expect(
        await processMessage(
          emailDeps,
          agentId,
          'bot@assistant.test',
          new Map([[from.toLowerCase(), 'known']]),
          messageId,
        ),
      ).toBe('skipped');
      const drain = await drainEmailObservers(
        {
          ...emailDeps,
          ownerNotifier: {
            notifyOwner: async (input: { text: string }) => {
              notices.push(input.text);
              return { legs: [] };
            },
            notifyApprovals: async () => {},
          },
          emailObservers: [],
        } as never,
        agentId,
        {
          limit: 20,
          shouldContinue: () =>
            config.EMAIL_OBSERVER_WORKER_ENABLED === true && config.GMAIL_SYNC_ENABLED === 'true',
        },
      );
      expect(drain.unknown).toBe(0);
      expect(drain.failed).toBe(0);
      const record = await persistence.applications?.byConfirmationMessage(
        agentId,
        `gmail:${messageId}`,
      );
      if (priorRecord && record)
        return { kind: 'replay' as const, applicationId: record.id, status: record.status };
      if (record)
        return record.status === 'confirmation_received'
          ? { kind: 'in_progress' as const, applicationId: record.id }
          : { kind: 'replay' as const, applicationId: record.id, status: record.status };
      const [ambiguous] = (
        await store
          .collection('tasks')
          .where('externalEventId', '==', `application-confirmation:gmail:${messageId}:ambiguous`)
          .get()
      ).docs;
      if (ambiguous) return { kind: 'ambiguous' as const };
      return { kind: 'ignored' as const };
    }

    it('creates one active watch per token, in a new follow-up chat', async () => {
      const created = await watch('REQ-100200');
      expect(created.status).toBe('awaiting_confirmation');
      const chat = await store.doc('conversations', created.conversationId).get();
      expect([chat.get('channel'), chat.get('trust'), chat.get('title')]).toEqual([
        'chat',
        'owner',
        'Acme — Engineer',
      ]);
      await expect(watch('req-100200')).rejects.toThrow(
        'an active confirmation watch already uses this token',
      );
      const raced = await Promise.allSettled([watch('REQ-300400'), watch('REQ-300400')]);
      expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const list = registry.get('applications.list_confirmations')?.tool;
      const listed = (await list?.execute({}, ctx((await ownerTask()).id))) as {
        confirmations: Array<{ tokenHint: string }>;
      };
      expect(listed.confirmations.map((row) => row.tokenHint).sort()).toEqual(['0200', '0400']);
    });

    it('claims the matching email once and runs both pre-authorized updates through the dispatcher', async () => {
      const created = await watch('REQ-100200');
      expect(await email('m-unrelated', 'Thanks for applying!')).toEqual({ kind: 'ignored' });
      expect(await email('m-other-sender', 'Ref REQ-100200', 'spoof@else.test')).toEqual({
        kind: 'ignored',
      });

      const claimed = await admitAndDrainEmail('m-1', 'Your reference is REQ-100­200.');
      expect(claimed).toEqual({ kind: 'in_progress', applicationId: created.applicationId });
      const observerWork = await store
        .collection('emailObserverWork')
        .where('sourceKey', '==', 'gmail:m-1')
        .get();
      expect(
        observerWork.docs
          .map(
            (row) =>
              `${row.get('observerKey')}@${row.get('observerVersion')}:${row.get('workClass')}`,
          )
          .sort(),
      ).toEqual(directAdmissionObserverIdentities);
      expect(
        observerWork.docs.some(
          (row) => row.get('observerKey') === 'google.application-confirmation',
        ),
      ).toBe(false);
      expect(
        observerWork.docs.some(
          (row) =>
            row.get('observerKey') === 'google.direct-email-routing' &&
            row.get('status') === 'complete',
        ),
      ).toBe(true);
      // Generative cards are explicitly disabled in this fixture. Their paid
      // observer remains due and is intentionally not claimed by the drain.
      expect(
        observerWork.docs
          .find((row) => row.get('observerKey') === 'google.email-card')
          ?.get('status'),
      ).toBe('pending');
      const [task] = (
        await store
          .collection('tasks')
          .where('externalEventId', '==', 'application-confirmation:gmail:m-1')
          .get()
      ).docs;
      if (!task) throw new Error('missing confirmation task');

      const handler = applicationConfirmationTaskHandlers.find(
        (h) => h.kind === 'application_confirmation',
      );
      expect(handler).toBeDefined();
      expect(await executeApplicationConfirmationTask(deps(), task.get('id'))).toEqual({
        outcome: 'done',
        applicationId: created.applicationId,
      });
      const record = await persistence.applications?.get(created.applicationId);
      expect(record?.status).toBe('updated');
      const actionState = parseApplicationActionState(record?.actionState);
      const sheetAction = actionState.sheet;
      const documentAction = actionState.document;
      expect(sheetAction?.status).toBe('succeeded');
      expect(documentAction?.status).toBe('succeeded');
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const sheetReceipt = sheetAction?.effectReceipt;
      const documentReceipt = documentAction?.effectReceipt;
      expect(sheetReceipt).toEqual({
        argsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        claimToken: expect.stringMatching(uuid),
        idempotencyKey: `application-confirmation-apply-${created.applicationId}`,
        producerPrivacyGeneration: null,
        taskId: task.get('id'),
        toolCallId: expect.stringMatching(uuid),
        toolName: 'applications.apply_confirmation',
      });
      expect(documentReceipt).toEqual({
        argsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        claimToken: expect.stringMatching(uuid),
        idempotencyKey: `application-confirmation-doc-${created.applicationId}`,
        producerPrivacyGeneration: null,
        taskId: task.get('id'),
        toolCallId: expect.stringMatching(uuid),
        toolName: 'applications.append_confirmation_doc',
      });
      expect(sheetReceipt?.claimToken).not.toBe(documentReceipt?.claimToken);
      expect(sheetReceipt?.toolCallId).not.toBe(documentReceipt?.toolCallId);
      expect(api.mock.calls.map(([url]) => String(url).split('?')[0])).toEqual([
        expect.stringContaining('sheets.googleapis.com/v4/spreadsheets/sheet-1234567890/values/'),
        'https://docs.googleapis.com/v1/documents/doc-1234567890',
        'https://docs.googleapis.com/v1/documents/doc-1234567890:batchUpdate',
      ]);
      expect(notices).toEqual([
        expect.stringContaining('I matched the authenticated confirmation for Acme'),
      ]);

      // A replayed email and a replayed task change nothing.
      expect(await admitAndDrainEmail('m-1', 'Your reference is REQ-100200.')).toMatchObject({
        kind: 'replay',
      });
      expect(await executeApplicationConfirmationTask(deps(), task.get('id'))).toMatchObject({
        outcome: 'done',
      });
      expect(api).toHaveBeenCalledTimes(3);
    });

    it('changes nothing when one email matches two watches', async () => {
      await watch('REQ-111111');
      await watch('REQ-222222');
      expect(await admitAndDrainEmail('m-2', 'Refs REQ-111111 and REQ-222222')).toMatchObject({
        kind: 'ambiguous',
      });
      const observerWork = await store
        .collection('emailObserverWork')
        .where('sourceKey', '==', 'gmail:m-2')
        .get();
      expect(
        observerWork.docs
          .map(
            (row) =>
              `${row.get('observerKey')}@${row.get('observerVersion')}:${row.get('workClass')}`,
          )
          .sort(),
      ).toEqual(directAdmissionObserverIdentities);
      expect(
        observerWork.docs.some(
          (row) => row.get('observerKey') === 'google.application-confirmation',
        ),
      ).toBe(false);
      expect(
        observerWork.docs
          .find((row) => row.get('observerKey') === 'google.direct-email-routing')
          ?.get('status'),
      ).toBe('complete');
      expect(
        observerWork.docs
          .find((row) => row.get('observerKey') === 'google.email-card')
          ?.get('status'),
      ).toBe('pending');
      const [task] = (
        await store
          .collection('tasks')
          .where('externalEventId', '==', 'application-confirmation:gmail:m-2:ambiguous')
          .get()
      ).docs;
      expect(task?.get('status')).toBe('needs_attention');
      expect(api).not.toHaveBeenCalled();
      expect(notices).toEqual([expect.stringContaining('matched 2 application watches')]);
    });

    it('cancels a waiting watch and reaps an expired one with a notice', async () => {
      const cancelled = await watch('REQ-555555');
      const cancel = registry.get('applications.cancel_confirmation')?.tool;
      const task = await ownerTask();
      expect(
        await cancel?.execute({ applicationId: cancelled.applicationId }, ctx(task.id)),
      ).toEqual({
        applicationId: cancelled.applicationId,
        status: 'cancelled',
        cancelled: true,
      });
      expect(
        await cancel?.execute({ applicationId: cancelled.applicationId }, ctx(task.id)),
      ).toMatchObject({
        cancelled: false,
        status: 'cancelled',
      });

      const expiring = await watch('REQ-666666');
      await store
        .doc('applicationConfirmations', expiring.applicationId)
        .update({ expiresAt: new Date(Date.now() - HOUR) });
      expect(await reapExpiredApplicationWatches(deps())).toBe(1);
      expect(await reapExpiredApplicationWatches(deps())).toBe(0);
      expect((await persistence.applications?.get(expiring.applicationId))?.status).toBe('expired');
      const messages = await store
        .collection('messages')
        .where('conversationId', '==', expiring.conversationId)
        .get();
      expect(messages.docs.map((doc) => doc.get('text'))).toEqual([
        expect.stringContaining('it never arrived. I made no Sheet or Doc update.'),
      ]);
    });
  },
);
