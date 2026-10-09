import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallationStore } from '@assistant/firestore';
import { chatAdmissionPayload } from '@assistant/persistence';
import {
  advanceInstallationStage,
  type ConsumerInstallOptions,
  type ConsumerInstallResult,
  createInstallationManifest,
  type InstallationManifest,
  type provisionConsumerInstallation,
} from '@assistant/setup/installation';
import { afterAll, describe, expect, it } from 'vitest';
import {
  firestoreReadinessEvidence,
  issueInstallerOwnerClaim,
  provisionConsumerInstallationWithPublishedImages,
  provisionConsumerInstallationWithSeed,
} from './consumer-install.js';
import { createGcloudAuthClient } from './gcloud-auth.js';

const seedAt = '2026-09-22T12:00:00.000Z';
const agentId = '8202725c-1311-4eec-bddc-698c92db37d4';
const embeddingSpace = {
  provider: 'vertex',
  model: 'example-embedding',
  dimensions: 1536,
  revision: 'fixture-v1',
};

function seedInput(installationId: string) {
  const chat = 'vertex/example-chat';
  const embed = 'vertex/example-embedding';
  const model = (id: string, capabilities: Record<string, boolean>) => ({
    id,
    label: `Synthetic ${id}`,
    capabilities,
    latencyClass: 'fast',
    promptCostPerMTok: '0.1',
    completionCostPerMTok: '0.2',
    pricingSource: 'https://example.test/synthetic-fixture-prices',
    pricingVerifiedAt: seedAt,
  });
  return {
    schemaVersion: 1,
    projectId: 'demo-assistant-test',
    installationId,
    seedAt,
    agent: {
      id: agentId,
      name: 'Fixture assistant',
      email: 'owner@example.test',
      timezone: 'UTC',
      locale: 'en-US',
      signature: '',
    },
    budget: { dailyLimitMicros: 1_000_000, monthlyLimitMicros: 10_000_000, softPct: 80 },
    embeddingSpace,
    models: [model(chat, { text: true }), model(embed, { embedding: true })],
    roles: ['plan', 'classify', 'extract', 'draft', 'reason', 'rewrite', 'embed', 'batch'].map(
      (role) => ({
        role,
        primaryModel: role === 'embed' ? embed : chat,
        fallbackModel: role === 'embed' ? embed : chat,
        params: {},
      }),
    ),
  };
}

function manifest(installationId: string, databaseId = '(default)') {
  return createInstallationManifest({
    identity: {
      installationId,
      projectId: 'demo-assistant-test',
      region: 'us-central1',
      databaseId,
      release: {
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        archiveDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
    modules: [],
    modelProvider: 'google',
    embeddingModel: embeddingSpace.model,
    embeddingDimension: embeddingSpace.dimensions,
    resources: [],
    createdAt: seedAt,
  });
}

function advanced(input: InstallationManifest, to: 'provisioned' | 'initialized') {
  let result = input;
  for (const stage of ['authorized', 'bootstrapped', 'provisioned', 'initialized'] as const) {
    result = advanceInstallationStage(result, stage, seedAt);
    if (stage === to) break;
  }
  return result;
}

function installer(input: InstallationManifest, failRuntime = false) {
  let current = input;
  const calls: Array<{ apply: boolean; runtime: boolean }> = [];
  const provision: typeof provisionConsumerInstallation = async (_dependencies, options) => {
    calls.push({ apply: options.apply, runtime: Boolean(options.runtime) });
    if (options.apply && options.runtime) {
      if (failRuntime) throw new Error('runtime deployment failed');
      current = advanced(input, 'initialized');
    } else if (options.apply) {
      current = advanced(input, 'provisioned');
    }
    const result: ConsumerInstallResult = {
      manifest: current,
      applied: options.apply,
      runtimeReady: false,
      completed: current.stage.completed,
      pending: current.stage.current === 'initialized' ? ['ready'] : ['initialized', 'ready'],
      note: 'fixture',
    };
    return result;
  };
  return {
    calls,
    provision,
    current: () => current,
    failRuntime: () => {
      failRuntime = false;
    },
  };
}

const dependencies = {
  runner: {
    run: async () => {
      throw new Error('unexpected cloud command');
    },
  },
};

function dependenciesForCleanRelease(input: InstallationManifest) {
  return {
    runner: {
      run: async (command: string, args: readonly string[]) => {
        if (command === 'git' && args[0] === 'rev-parse')
          return { ok: true, stdout: input.identity.release.commitSha, stderr: '' };
        if (command === 'git' && args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
        return { ok: false, stdout: '', stderr: 'unexpected command' };
      },
    },
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'consumer install runtime seed orchestration',
  () => {
    const stores: ReturnType<typeof createInstallationStore>[] = [];
    function setup(databaseId = '(default)') {
      const installationId = `seed-${randomUUID().slice(0, 8)}`;
      const store = createInstallationStore({
        projectId: 'demo-assistant-test',
        installationId,
        databaseId,
      });
      stores.push(store);
      const input = manifest(installationId, databaseId);
      const options: ConsumerInstallOptions & { seedInput: unknown } = {
        manifest: input,
        archivePath: 'unused',
        statePath: 'unused',
        stateBucket: 'unused',
        terraformDir: 'unused',
        apply: true,
        seedInput: seedInput(installationId),
      };
      return { store, options, input };
    }
    afterAll(async () => {
      for (const store of stores) {
        await store.db.recursiveDelete(store.root);
        await store.db.terminate();
      }
    });

    it('previews without creating a marker or invoking apply', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        { ...options, apply: false },
        stub.provision,
      );
      expect(result.seed).toMatchObject({ status: 'planned', agentId });
      expect(stub.calls).toEqual([{ apply: false, runtime: false }]);
      expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
      expect(JSON.stringify(result)).not.toContain('owner@example.test');
      expect(JSON.stringify(result)).not.toContain('promptCostPerMTok');
    });

    it('applies a create-only seed after foundation provisioning', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        options,
        stub.provision,
      );
      expect(result.manifest.stage.current).toBe('provisioned');
      expect(result.seed).toMatchObject({ status: 'seeded', agentId });
      expect(stub.calls).toEqual([
        { apply: false, runtime: false },
        { apply: true, runtime: false },
      ]);
      expect((await store.doc('coordination', 'runtime-seed').get()).get('status')).toBe(
        'complete',
      );
    });

    it('uses the explicitly supplied gcloud auth client for the integrated Firestore seed', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      const authClient = await createGcloudAuthClient(async (args) =>
        args[1] === 'list' ? 'operator@example.test\n' : `ya29.${'a'.repeat(40)}\n`,
      );
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        { ...options, seedAuthClient: authClient },
        stub.provision,
      );
      expect(result.seed?.status).toBe('seeded');
      expect((await store.doc('coordination', 'runtime-seed').get()).get('status')).toBe(
        'complete',
      );
    });

    it('seeds the named database selected by the installation manifest', async () => {
      const { store, options, input } = setup('assistant-production');
      const stub = installer(input);
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        options,
        stub.provision,
      );
      expect(result.seed?.status).toBe('seeded');
      expect((await store.doc('agents', agentId).get()).exists).toBe(true);
      const wrongDatabase = createInstallationStore({
        projectId: 'demo-assistant-test',
        installationId: input.identity.installationId,
      });
      try {
        expect((await wrongDatabase.doc('agents', agentId).get()).exists).toBe(false);
      } finally {
        await wrongDatabase.db.terminate();
      }
    });

    it('seeds before optional runtime deployment, then retries without rewriting records', async () => {
      const { store, options, input } = setup();
      const stub = installer(input, true);
      const runtime = {
        images: {},
        config: {
          firestoreAgentId: agentId,
          ownerEmail: 'owner@example.test',
          firestoreEmbeddingSpace: embeddingSpace,
        },
      };
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          { ...options, runtime },
          stub.provision,
        ),
      ).rejects.toThrow('runtime deployment failed');
      expect((await store.doc('coordination', 'runtime-seed').get()).get('status')).toBe(
        'complete',
      );
      expect(stub.calls).toEqual([
        { apply: false, runtime: true },
        { apply: true, runtime: false },
        { apply: true, runtime: true },
      ]);
      stub.failRuntime();
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        { ...options, runtime },
        stub.provision,
      );
      expect(result.seed?.status).toBe('already_seeded');
      expect(result.manifest.stage.current).toBe('initialized');
      expect((await store.doc('agents', agentId).get()).exists).toBe(true);
    });

    it('rejects identity, embedding, provider, and runtime mismatch before any apply', async () => {
      const { options, input } = setup();
      const stub = installer(input);
      const plan = options.seedInput as ReturnType<typeof seedInput>;
      for (const seedInput of [
        { ...plan, projectId: 'foreign-project' },
        { ...plan, embeddingSpace: { ...embeddingSpace, dimensions: 1024 } },
      ]) {
        await expect(
          provisionConsumerInstallationWithSeed(
            dependencies,
            { ...options, seedInput },
            stub.provision,
          ),
        ).rejects.toThrow();
      }
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          {
            ...options,
            manifest: { ...input, selection: { ...input.selection, modelProvider: 'openrouter' } },
          },
          stub.provision,
        ),
      ).rejects.toThrow('Google provider');
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          { ...options, runtime: { images: {}, config: { firestoreAgentId: randomUUID() } } },
          stub.provision,
        ),
      ).rejects.toThrow('differs from seed plan');
      expect(stub.calls).toEqual([]);
    });

    it('leaves the foundation resumable when seed refuses existing data', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      await store.doc('agents', 'foreign-agent').create({ id: 'foreign-agent' });
      await expect(
        provisionConsumerInstallationWithSeed(dependencies, options, stub.provision),
      ).rejects.toThrow('installation already contains data');
      expect(stub.current().stage.current).toBe('provisioned');
      expect(stub.calls).toEqual([
        { apply: false, runtime: false },
        { apply: true, runtime: false },
      ]);
      expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
    });

    it('refuses late seed creation after runtime initialization without a marker', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      const runtime = {
        images: {},
        config: {
          firestoreAgentId: agentId,
          ownerEmail: 'owner@example.test',
          firestoreEmbeddingSpace: embeddingSpace,
        },
      };
      await stub.provision(dependencies, { ...options, runtime });
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          { ...options, runtime },
          stub.provision,
        ),
      ).rejects.toThrow('no seed marker');
      expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
    });

    it('retains the original installer path without a seed plan', async () => {
      const { options, input } = setup();
      const stub = installer(input);
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        { ...options, seedInput: undefined },
        stub.provision,
      );
      expect(result.seed).toBeUndefined();
      expect(stub.calls).toEqual([{ apply: true, runtime: false }]);
    });
  },
);

describe('consumer install image publishing orchestration', () => {
  it('previews the exact customer image build only after the foundation is provisioned', async () => {
    const input = manifest('install-images');
    const current = advanced(input, 'provisioned');
    const calls: string[] = [];
    const provision = async (_dependencies: unknown, options: ConsumerInstallOptions) => {
      calls.push(options.apply ? 'apply' : 'preview');
      const result: ConsumerInstallResult = {
        manifest: current,
        applied: options.apply,
        runtimeReady: false,
        completed: current.stage.completed,
        pending: ['initialized', 'ready'],
        note: 'fixture',
      };
      return result;
    };
    const publish = async (options: {
      projectId: string;
      region: string;
      repositoryId: string;
      sourceSha: string;
      dryRun: boolean;
    }) => {
      calls.push('publish-preview');
      expect(options).toEqual({
        projectId: 'demo-assistant-test',
        region: 'us-central1',
        repositoryId: 'install-images',
        sourceSha: input.identity.release.commitSha,
        dryRun: true,
      });
      return { dryRun: true, tags: { web: 'web-tag', agent: 'agent-tag' } };
    };
    const result = await provisionConsumerInstallationWithPublishedImages(
      dependenciesForCleanRelease(input),
      {
        manifest: input,
        archivePath: 'unused',
        statePath: 'unused',
        stateBucket: 'unused',
        terraformDir: 'unused',
        apply: false,
        runtimeConfig: {},
      },
      provision as typeof provisionConsumerInstallation,
      publish as unknown as typeof import('./consumer-publish-images.js').publishConsumerImages,
    );
    expect(calls).toEqual(['preview', 'publish-preview']);
    expect(result.imagePublish).toMatchObject({ dryRun: true });
    expect(result.applied).toBe(false);
  });

  it('publishes to a private temporary manifest before applying the pinned runtime', async () => {
    const input = manifest('install-images');
    const current = advanced(input, 'provisioned');
    const calls: string[] = [];
    const imageManifest = { schemaVersion: 1, images: { web: 'web', agent: 'agent' } };
    const provision = async (_dependencies: unknown, options: ConsumerInstallOptions) => {
      calls.push(options.apply ? 'runtime-apply' : 'foundation-preview');
      if (options.apply) expect(options.runtime?.images).toEqual(imageManifest);
      const result: ConsumerInstallResult = {
        manifest: options.apply ? advanced(input, 'initialized') : current,
        applied: options.apply,
        runtimeReady: false,
        completed: current.stage.completed,
        pending: ['initialized', 'ready'],
        note: 'fixture',
      };
      return result;
    };
    const publish = async (options: { dryRun: boolean; outputPath?: string }) => {
      calls.push('publish');
      expect(options.dryRun).toBe(false);
      expect(options.outputPath).toBeTruthy();
      await writeFile(options.outputPath as string, JSON.stringify(imageManifest), { mode: 0o600 });
      return { schemaVersion: 1 };
    };
    const stateDir = await mkdtemp(join(tmpdir(), 'assistant-build-images-'));
    const result = await provisionConsumerInstallationWithPublishedImages(
      dependenciesForCleanRelease(input),
      {
        manifest: input,
        archivePath: 'unused',
        statePath: join(stateDir, 'state.json'),
        stateBucket: 'unused',
        terraformDir: 'unused',
        apply: true,
        runtimeConfig: { ownerEmail: 'owner@example.test' },
      },
      provision as typeof provisionConsumerInstallation,
      publish as unknown as typeof import('./consumer-publish-images.js').publishConsumerImages,
    );
    expect(calls).toEqual(['foundation-preview', 'publish', 'runtime-apply']);
    expect(result.manifest.stage.current).toBe('initialized');
    expect(result.imagePublish).toMatchObject({
      published: true,
      sourceSha: input.identity.release.commitSha,
      imageManifestPath: join(stateDir, `image-manifest-${input.identity.release.commitSha}.json`),
    });
    expect(
      JSON.parse(
        await readFile(
          join(stateDir, `image-manifest-${input.identity.release.commitSha}.json`),
          'utf8',
        ),
      ),
    ).toEqual(imageManifest);
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('consumer install readiness evidence', () => {
  it('requires a current owner reply acknowledged by the paired native client', async () => {
    const installationId = `ready-${randomUUID().slice(0, 8)}`;
    const createStore = () =>
      createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    const inspect = createStore();
    try {
      const { applyConsumerRuntimeSeed, planConsumerRuntimeSeed } = await import(
        './consumer-runtime-seed.js'
      );
      await applyConsumerRuntimeSeed(inspect, planConsumerRuntimeSeed(seedInput(installationId)));
      const context = {
        ownerAuth: 'passkey' as const,
        webUrl: 'https://ready-web-1.us-central1.run.app',
        authOrigin: 'https://ready-web-1.us-central1.run.app',
        agentId,
        runtimeInitializedAt: seedAt,
        servingAgentRevision: 'ready-agent-revision',
        releaseSha: '0123456789abcdef0123456789abcdef01234567',
        embeddingSpace,
      };
      const evidence = firestoreReadinessEvidence(createStore);
      expect(await evidence(context)).toEqual({
        runtimeData: { ready: true, issues: [] },
        ownerReplyDelivered: false,
      });
      await inspect.doc('modelCalls', 'call-1').set({
        id: 'call-1',
        createdAt: new Date(),
        model: 'vertex/example-chat',
        outputTokens: 12,
      });
      expect((await evidence(context)).ownerReplyDelivered).toBe(false);
      const requestAt = new Date();
      const callAt = new Date(requestAt.getTime() + 1);
      const replyAt = new Date(callAt.getTime() + 1);
      const deliveredAt = new Date(replyAt.getTime() + 1);
      const clientId = '5609a8a4-fd04-49bf-a90a-d0038262e765';
      const conversationId = 'd1f64071-aa8d-4d7a-a68f-1d1c75f51630';
      await inspect.doc('tasks', 'owner-task-1').set({
        id: 'owner-task-1',
        agentId,
        trust: 'owner',
        type: 'chat_turn',
        status: 'done',
        createdAt: requestAt,
        conversationId,
        trigger: {
          payload: {
            chatAdmission: {
              protocol: 'owner-chat-v1',
              clientOperationId: '5509a8a4-fd04-49bf-a90a-d0038262e765',
              requestHash: 'a'.repeat(64),
              triggerMessageId: 'owner-request-1',
              phase: 'streaming',
            },
          },
        },
      });
      await inspect.doc('messages', 'owner-request-1').set({
        id: 'owner-request-1',
        taskId: 'owner-task-1',
        role: 'user',
        origin: 'owner',
        text: 'Hi',
        conversationId,
        clientId,
        createdAt: requestAt,
      });
      await inspect.doc('messages', 'owner-reply-1').set({
        id: 'owner-reply-1',
        taskId: 'owner-task-1',
        role: 'assistant',
        origin: 'assistant',
        text: 'Hello.',
        conversationId,
        clientDeliveredAt: deliveredAt,
        clientDeliveredBy: clientId,
        createdAt: replyAt,
      });
      await inspect.doc('modelCalls', 'owner-call-1').set({
        id: 'owner-call-1',
        taskId: 'owner-task-1',
        createdAt: callAt,
        model: 'vertex/example-chat',
        outputTokens: 12,
        runtimeRevision: context.servingAgentRevision,
        runtimeReleaseSha: context.releaseSha,
      });
      const savedTask = await inspect.doc('tasks', 'owner-task-1').get();
      expect(chatAdmissionPayload(savedTask.data() as never)?.triggerMessageId).toBe(
        'owner-request-1',
      );
      const savedCall = await inspect.doc('modelCalls', 'owner-call-1').get();
      expect(savedCall.get('runtimeRevision')).toBe(context.servingAgentRevision);
      const savedRequest = await inspect.doc('messages', 'owner-request-1').get();
      const savedReply = await inspect.doc('messages', 'owner-reply-1').get();
      expect(savedRequest.get('clientId')).toBe(clientId);
      expect(savedReply.get('clientDeliveredBy')).toBe(clientId);
      expect(savedRequest.get('createdAt').toDate().getTime()).toBeLessThanOrEqual(
        savedCall.get('createdAt').toDate().getTime(),
      );
      expect(savedCall.get('createdAt').toDate().getTime()).toBeLessThanOrEqual(
        savedReply.get('createdAt').toDate().getTime(),
      );
      expect((await evidence(context)).ownerReplyDelivered).toBe(true);
      await inspect.doc('modelCalls', 'owner-call-1').update({ runtimeRevision: 'old-revision' });
      expect((await evidence(context)).ownerReplyDelivered).toBe(false);
      await inspect.doc('modelCalls', 'owner-call-1').update({
        runtimeRevision: context.servingAgentRevision,
      });
      await inspect.doc('messages', 'owner-reply-1').update({ clientDeliveredBy: 'other-client' });
      expect((await evidence(context)).ownerReplyDelivered).toBe(false);
      await inspect.doc('messages', 'owner-reply-1').update({ clientDeliveredBy: clientId });
      await inspect.doc('messages', 'owner-reply-1').update({ clientDeliveredAt: null });
      expect((await evidence(context)).ownerReplyDelivered).toBe(false);
      await inspect.doc('messages', 'owner-reply-1').update({ clientDeliveredAt: deliveredAt });
      await inspect.doc('tasks', 'owner-task-1').update({ agentId: 'foreign-agent' });
      expect((await evidence(context)).ownerReplyDelivered).toBe(false);
      await inspect.doc('tasks', 'owner-task-1').update({ agentId });
      await inspect.doc('tasks', 'owner-task-1').update({ type: 'scheduled' });
      expect((await evidence(context)).ownerReplyDelivered).toBe(false);
      await inspect.doc('tasks', 'owner-task-1').update({ type: 'chat_turn' });
      expect(
        (await evidence({ ...context, agentId: '00000000-0000-4000-8000-000000000000' }))
          .runtimeData.ready,
      ).toBe(false);

      const result = {
        manifest: advanced(manifest(installationId), 'initialized'),
        applied: true,
        runtimeReady: false,
        completed: [],
        pending: ['ready'],
        note: 'fixture',
        ownerAccess: {
          webUrl: context.webUrl,
          authOrigin: context.authOrigin,
          ownerAuth: 'passkey' as const,
          publicInvoker: true,
        },
      } satisfies ConsumerInstallResult;
      const claim = await issueInstallerOwnerClaim(result, createStore);
      expect(claim).toMatchObject({
        setupUrl: expect.stringMatching(
          /^https:\/\/ready-web-1\.us-central1\.run\.app\/setup#claim=[A-Za-z0-9_-]{43}$/,
        ),
      });
      await inspect.doc('ownerAuth', 'state').set({ claimedAt: new Date(), sessionGeneration: 1 });
      expect(await issueInstallerOwnerClaim(result, createStore)).toMatchObject({
        skipped: expect.stringContaining('already has an owner'),
      });
      expect(
        await issueInstallerOwnerClaim(
          { ...result, ownerAccess: { ...result.ownerAccess, ownerAuth: 'google' } },
          createStore,
        ),
      ).toMatchObject({ skipped: expect.stringContaining('passkey runtime') });
    } finally {
      await inspect.db.recursiveDelete(inspect.root);
      await inspect.db.terminate();
    }
  }, 30_000);
});
