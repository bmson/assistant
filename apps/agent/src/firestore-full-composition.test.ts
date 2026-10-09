import { randomUUID } from 'node:crypto';
import { loadConfig, parseFirestoreEmbeddingSpace, resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createDb = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('createDb must not run in the Firestore composition');
  }),
);
vi.mock('@assistant/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/db')>()),
  createDb,
}));

const { agentServices, composeFirestoreAgent } = await import('./deps.js');
const { firestoreMaintenanceReady } = await import('./firestore-maintenance-ready.js');
const { runFirestoreSweep } = await import('./firestore-sweep.js');
const { executeAgentTask } = await import('./task-runner.js');
const { LocalDocumentProcessLauncher, hashCallbackToken } = await import('@assistant/core');
const { embeddingModelId } = await import('@assistant/persistence');
const { startDocumentIngest } = await import(
  '../../../packages/core/src/memory/document-catalog.js'
);
const { default: composition } = await import('../../../assistant.config.js');

/**
 * Tools the Firestore composition serves without SQL, and tools that are
 * registered when every production module is enabled but still reach
 * PostgreSQL when executed. Every registered tool must be in one list, so a
 * new tool cannot silently land in the Firestore runtime unclassified. Move a
 * tool across only with an SQL-proxy emulator test. See
 * docs/firestore-agent-runtime-inventory.md.
 */
const PORTABLE_TOOLS = [
  'improvement.report',
  'audit.read',
  'audit.read_field',
  'applications.append_confirmation_doc',
  'applications.apply_confirmation',
  'applications.cancel_confirmation',
  'applications.list_confirmations',
  'applications.watch_confirmation',
  // Job launches stage through execution persistence; their result callbacks
  // (webhooks, not tools) are still SQL — see the inventory.
  // Job launches stage through execution persistence, and their result
  // callbacks (webhooks, not tools) record through it too.
  'browser.execute',
  'browser.plan',
  'calendar.availability',
  'calendar.cancel_booking_event',
  'calendar.cancel_event',
  'calendar.create_event',
  'calendar.list_calendars',
  'calendar.list_events',
  'calendar.respond_to_event',
  'calendar.search_events',
  'calendar.update_event',
  'code.execute',
  'contacts.lookup',
  'conversations.search',
  'docs.append',
  'docs.create',
  'docs.get',
  'docs.replace_text',
  'docs.share',
  'documents.search',
  'drive.download',
  'drive.ingest',
  'drive.read',
  'drive.search',
  'gmail.create_draft',
  'gmail.modify',
  'gmail.read_thread',
  'gmail.search',
  'gmail.send',
  'goals.create',
  'goals.list',
  'goals.update_progress',
  'maps.directions',
  // Owner MCP servers, read from Firestore connection snapshots.
  'mcp.call',
  'mcp.list_connections',
  'mcp.list_tools',
  'memory.graph_snapshot',
  'memory.recall',
  'memory.save',
  'mission.update',
  'occasions.list',
  'occasions.save',
  'owner.notify',
  // Calls stage like jobs and keep their state in callSessions.
  'phone.call',
  'reminder.cancel',
  'reminder.create',
  'reminder.list',
  'sheets.append_rows',
  'sheets.create',
  'sheets.get_rows',
  'sheets.write_rows',
  'situations.change',
  'situations.decisions',
  'situations.read',
  'situations.sources',
  'slides.append',
  'slides.create',
  'sms.send',
  'sports.scores',
  'task.schedule',
  'tools.read_result',
  'watch.cancel',
  'watch.create',
  'watch.list',
  'watch.web',
  'weather.lookup',
  'web.fetch',
  'web.search',
  'workspace.list',
  'workspace.read',
  'workspace.write',
];
const SQL_DEPENDENT_TOOLS: string[] = [];

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore agent composition with every production module',
  () => {
    const agentId = randomUUID();
    const installationId = `full-composition-${randomUUID()}`;
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

    beforeEach(async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      resetConfigForTest();
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
      await store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      });
    });

    afterEach(async () => {
      await store.db.recursiveDelete(store.root);
      resetConfigForTest();
      vi.unstubAllEnvs();
    });

    function productionConfig() {
      return loadConfig({
        PERSISTENCE_DRIVER: 'firestore',
        ASSISTANT_MODULES: 'all',
        ASSISTANT_WORKSPACE_ID: installationId,
        FIRESTORE_AGENT_ID: agentId,
        FIRESTORE_EMBEDDING_SPACE:
          '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
        GCP_PROJECT: 'demo-assistant-test',
        QUEUE_DRIVER: 'local',
        OPENROUTER_API_KEY: 'test-key',
        // Configured credentials, so every module registers its full tool set.
        GOOGLE_OAUTH_CLIENT_ID: 'client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
        BOT_GOOGLE_REFRESH_TOKEN: 'refresh',
        TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550000000',
        OWNER_PHONE: '+15550000001',
        SEARCH_PROVIDER: 'brave',
        SEARCH_API_KEY: 'search-key',
        APNS_KEY_ID: 'KEY1234567',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_PRIVATE_KEY: Buffer.from('not-a-real-key').toString('base64'),
        APNS_BUNDLE_ID: 'test.bundle',
      });
    }

    it('constructs every production module and tool with no SQL client', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = composeFirestoreAgent(productionConfig());

      expect(createDb).not.toHaveBeenCalled();
      expect([...deps.modules.installed].sort()).toEqual(
        composition.modules.map((module) => module.meta.name).sort(),
      );
      const registered = deps.registry
        .toolsForTask('owner')
        .map((tool) => tool.name)
        .sort();
      expect(registered).toEqual([...PORTABLE_TOOLS, ...SQL_DEPENDENT_TOOLS].sort());

      // Recurring work that still needs SQL is declared, and the Firestore
      // runtime skips it rather than tripping over it every tick.
      expect(deps.modules.ticks.filter((tick) => !tick.portable).map((tick) => tick.name)).toEqual(
        [],
      );
      expect(
        deps.modules.sweepSteps.filter((step) => !step.portable).map((step) => step.name),
      ).toEqual([]);

      // The complete maintenance pass, with every module installed, runs on
      // Firestore alone. Step failures are logged rather than thrown, so the
      // SQL tripwire's message is what would reveal a regression.
      const result = await runFirestoreSweep(deps);
      expect(result.ready).toBe(true);
      expect(errors.filter((line) => line.includes('PostgreSQL access is unavailable'))).toEqual(
        [],
      );
      expect(createDb).not.toHaveBeenCalled();
    });

    it('rechecks activation inside the document callback transaction after route readiness', async () => {
      const deps = composeFirestoreAgent(productionConfig());
      const callback = deps.modules.webhookHandler('/document/callback');
      if (!callback) throw new Error('document callback was not registered');
      const now = new Date();
      const inactiveDocumentId = randomUUID();
      const inactiveToken = randomUUID();
      const activeDocumentId = randomUUID();
      const activeToken = randomUUID();
      const seedProcessorDocument = async (documentId: string, token: string) =>
        store.doc('documents', documentId).set({
          id: documentId,
          agentId,
          title: 'Activation fence fixture',
          mime: 'text/plain',
          status: 'pending',
          extractor: 'pending_processor',
          processorTokenHash: hashCallbackToken(token),
          processorStartedAt: now,
          processorAttempts: 1,
          processedTextPath: null,
          createdAt: now,
          updatedAt: now,
        });
      const send = (documentId: string, token: string) =>
        callback(agentServices(deps), {
          json: async <T>() =>
            ({ documentId, token, result: { ok: true, kind: 'text', chars: 32 } }) as T,
          form: async () => ({}),
          header: () => undefined,
        });

      try {
        await store.doc('coordination', 'migration').set({ status: 'active' });
        expect(await firestoreMaintenanceReady(store, agentId)).toBe(true);
        await seedProcessorDocument(inactiveDocumentId, inactiveToken);

        // Simulate activation withdrawal after the real readiness read but
        // before the supported module webhook enters its persistence adapter.
        await store.doc('coordination', 'migration').update({ status: 'pending_activation' });
        await expect(send(inactiveDocumentId, inactiveToken)).resolves.toEqual({
          status: 503,
          json: { error: 'Firestore installation is not operationally ready' },
        });
        const inactiveDocument = await store.doc('documents', inactiveDocumentId).get();
        expect(inactiveDocument.get('processorTokenHash')).toBe(hashCallbackToken(inactiveToken));
        expect(inactiveDocument.get('processedTextPath')).toBeNull();
        expect(
          (
            await store
              .collection('tasks')
              .where('trigger.payload.documentId', '==', inactiveDocumentId)
              .get()
          ).size,
        ).toBe(0);
        expect((await store.collection('taskEventKeys').get()).size).toBe(0);
        expect((await store.collection('outbox').get()).size).toBe(0);

        // An active installation still accepts the same real callback path.
        await store.doc('coordination', 'migration').update({ status: 'active' });
        expect(await firestoreMaintenanceReady(store, agentId)).toBe(true);
        await seedProcessorDocument(activeDocumentId, activeToken);
        await expect(send(activeDocumentId, activeToken)).resolves.toEqual({
          status: 200,
          json: { ok: true },
        });
        expect(
          (await store.doc('documents', activeDocumentId).get()).get('processedTextPath'),
        ).toBe(`documents/${activeDocumentId}/extracted.txt`);
        expect(
          (
            await store
              .collection('tasks')
              .where('trigger.payload.documentId', '==', activeDocumentId)
              .get()
          ).size,
        ).toBe(1);
        expect((await store.collection('taskEventKeys').get()).size).toBe(1);
        expect((await store.collection('outbox').get()).size).toBe(1);
      } finally {
        await store
          .doc('coordination', 'migration')
          .delete()
          .catch(() => {});
      }
    });

    it('wires the configured Firestore processor through ingest, the task runner, callback and extraction', async () => {
      const deps = composeFirestoreAgent(productionConfig());
      expect(deps.documentProcessor).toBeDefined();
      expect(deps.documentProcessor?.launcher).toBeInstanceOf(LocalDocumentProcessLauncher);
      const embeddingSpace = parseFirestoreEmbeddingSpace(deps.config.FIRESTORE_EMBEDDING_SPACE);
      const embeddingModel = embeddingModelId(embeddingSpace);
      const modelCatalog = deps.persistence?.modelCatalog;
      if (!modelCatalog) throw new Error('model catalog is unavailable');
      await modelCatalog.upsertModel({
        id: embeddingModel,
        label: 'Synthetic embedding model',
        capabilities: { embeddings: true },
        promptCostPerMTok: '0',
        completionCostPerMTok: '0',
        latencyClass: 'fast',
        enabled: true,
      });
      // This is installation model-routing configuration for the synthetic
      // composition test; the fake embedder below makes no provider call.
      await store.doc('modelRoles', 'embed').set({
        role: 'embed',
        primaryModel: embeddingModel,
        fallbackModel: embeddingModel,
        params: {},
        updatedAt: new Date(),
      });

      const launches: Array<{ documentId: string; callbackToken: string; outputPath: string }> = [];
      const launcher = vi
        .spyOn(LocalDocumentProcessLauncher.prototype, 'launch')
        .mockImplementation(async (input) => {
          launches.push({
            documentId: input.documentId,
            callbackToken: input.callbackToken,
            outputPath: input.outputPath,
          });
          return { executionName: 'synthetic/document-job' };
        });
      const sourcePath = `documents/uploads/${randomUUID()}-report.docx`;
      let outputPath: string | undefined;
      try {
        const catalog = deps.persistence?.documentCatalog;
        if (!catalog) throw new Error('Firestore document catalog is not configured');
        const sourceBytes = Buffer.from('synthetic office document');
        const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        await deps.workspace.writeBytes(sourcePath, sourceBytes, docxMime);
        const ingested = await startDocumentIngest(catalog, {
          agentId,
          title: 'Annual report.docx',
          workspacePath: sourcePath,
          mime: docxMime,
          bytes: sourceBytes.byteLength,
          sha256: 'a'.repeat(64),
          source: 'upload',
        });
        expect(ingested.document.extractor).toBe('pending_processor');
        expect(ingested.taskId).toBeTruthy();
        const task = await deps.persistence?.tasks.getTask(ingested.taskId ?? '');
        if (!task) throw new Error('document ingest did not enqueue its processor task');

        expect(await executeAgentTask(deps, task.id, task.queueGeneration)).toMatchObject({
          outcome: 'done',
        });
        expect(launches).toHaveLength(1);
        const launch = launches[0];
        if (!launch) throw new Error('configured processor did not launch');
        outputPath = launch.outputPath;
        await deps.workspace.write(
          outputPath,
          'The report states that revenue grew twelve percent.',
        );

        const callback = deps.modules.webhookHandler('/document/callback');
        if (!callback) throw new Error('document callback was not registered');
        const response = await callback(agentServices(deps), {
          json: async <T>() =>
            ({
              documentId: launch.documentId,
              token: launch.callbackToken,
              result: { ok: true, kind: 'text', chars: 51 },
            }) as T,
          form: async () => ({}),
          header: () => undefined,
        });
        expect(response).toEqual({ status: 200, json: { ok: true } });

        const embed = vi
          .spyOn(deps.router, 'embed')
          .mockImplementation(async (texts) => texts.map(() => new Array(1536).fill(0.125)));
        const extractionTasks = await store
          .collection('tasks')
          .where('trigger.payload.job', '==', 'documents.extract')
          .where('trigger.payload.documentId', '==', launch.documentId)
          .get();
        expect(extractionTasks.size).toBe(1);
        const extraction = extractionTasks.docs[0];
        if (!extraction) throw new Error('document callback did not enqueue extraction');
        // Firestore document IDs are reversibly encoded by InstallationStore;
        // the task repository key is the stable ID stored in the task record.
        const extractionTaskId = String(extraction.get('id'));
        const extractionTask = await deps.persistence?.tasks.getTask(extractionTaskId);
        if (!extractionTask) throw new Error('extraction task was not readable');
        const extractionOutcome = await executeAgentTask(
          deps,
          extractionTask.id,
          extractionTask.queueGeneration,
        );
        if (extractionOutcome.outcome !== 'done')
          throw new Error(
            `Synthetic extraction did not complete: ${JSON.stringify(extractionOutcome)}`,
          );
        expect(extractionOutcome).toMatchObject({ outcome: 'done' });
        expect(embed).toHaveBeenCalledOnce();
        expect((await store.doc('documents', launch.documentId).get()).get('status')).toBe('ready');
        expect(
          (
            await store
              .collection('documentChunks')
              .where('documentId', '==', launch.documentId)
              .get()
          ).size,
        ).toBeGreaterThan(0);
      } finally {
        launcher.mockRestore();
        await deps.workspace.delete(sourcePath).catch(() => {});
        if (outputPath) await deps.workspace.delete(outputPath).catch(() => {});
      }
    });

    it('validates the full production module set with no module left on SQL', async () => {
      const { validateAgentPersistenceConfig } = await import('@assistant/config');
      expect(
        validateAgentPersistenceConfig(productionConfig(), {
          ASSISTANT_WORKSPACE_ID: installationId,
        }).filter((problem) => problem.includes('ASSISTANT_MODULES')),
      ).toEqual([]);
    });
  },
);
