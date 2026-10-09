import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkFirestoreRuntimeData,
  createInstallationStore,
  FirestoreOwnerAuthRepository,
} from '@assistant/firestore';
import { chatAdmissionPayload } from '@assistant/persistence';
import {
  type ConsumerInstallDependencies,
  type ConsumerInstallOptions,
  type ConsumerInstallResult,
  type ConsumerReadinessEvidence,
  type ConsumerVerifyContext,
  provisionConsumerInstallation,
  systemRunner,
  validateInstallationManifest,
} from '@assistant/setup/installation';
import type { AuthClient } from 'google-auth-library';
import { issueOwnerSetupLink } from './consumer-owner-claim.js';
import { publishConsumerImages, reportImagePublishProgress } from './consumer-publish-images.js';
import {
  applyConsumerRuntimeSeed,
  type ConsumerRuntimeSeedPlan,
  planConsumerRuntimeSeed,
} from './consumer-runtime-seed.js';
import { createGcloudAuthClient } from './gcloud-auth.js';

const usage = `Usage: pnpm consumer:install --manifest PATH --archive PATH --state PATH --state-bucket NAME --terraform-dir PATH [--seed-plan PATH] [--gcloud-auth] [--images PATH --runtime-config PATH] [--owner-access-callback HTTPS_URL] [--issue-owner-claim] [--verify [--owner-signed-in] --native-app-version VERSION --native-pairing-confirmed] [--apply]

Without --apply this verifies the release archive, customer project billing, and selected Firestore database absence.
With --apply it bootstraps customer-owned state, runs Terraform, and records resumable foundation stages.
Supply both --images and --runtime-config to opt in to digest-pinned Cloud Run deployment after the foundation.
Supply --seed-plan with an explicit customer runtime seed plan to create required data before Cloud Run.
With --seed-plan, --gcloud-auth uses the active gcloud account in memory for the Firestore seed when ADC is unavailable. Terraform can use a short-lived GOOGLE_OAUTH_ACCESS_TOKEN from the active gcloud login.
On an initialized private runtime, pass --owner-access-callback with the exact Google OAuth Web client redirect URI. Preview is read-only; --apply grants public invocation to web only after the customer has configured the OAuth client and HTTPS routing.
With a passkey runtime config ("ownerAuth": "passkey"), no Google OAuth client is used: the installer generates the session secret, makes web public at deploy (application sign-in is claim-protected), and --issue-owner-claim --apply prints a one-time 24-hour setup link for the owner passkey.
--verify runs the native-first readiness checks (operator-confirmed installed app version and authenticated pairing, revisions, release health, owner authentication, runtime data, a post-installation owner conversation and model response); with --apply a full pass records the ready stage.
On an already provisioned foundation, --build-images --runtime-config PATH --apply builds and pushes the exact source commit's web and agent images into the customer repository, then deploys those digests. Docker Buildx and an active customer gcloud login are required; Docker authentication is configured for this run.
`;

type SeedSummary = {
  status: 'planned' | 'seeded' | 'already_seeded';
  planHash: string;
  recordCount: number;
  agentId: string;
};

function validateSeedScope(plan: ConsumerRuntimeSeedPlan, options: ConsumerInstallOptions): void {
  const manifest = validateInstallationManifest(options.manifest);
  const space = plan.input.embeddingSpace;
  if (
    plan.input.projectId !== manifest.identity.projectId ||
    plan.input.installationId !== manifest.identity.installationId
  )
    throw new Error('Runtime seed project and installation must match the manifest');
  if (manifest.selection.modelProvider !== 'google')
    throw new Error('Runtime seed requires the Google provider');
  if (
    manifest.selection.embeddingModel !== space.model ||
    manifest.selection.embeddingDimension !== space.dimensions
  )
    throw new Error('Runtime seed embedding model and dimensions must match the manifest');
  if (options.runtime) {
    const config = options.runtime.config as Record<string, unknown> | null;
    const runtimeSpace = config?.firestoreEmbeddingSpace as Record<string, unknown> | null;
    if (
      config?.firestoreAgentId !== plan.input.agent.id ||
      config?.ownerEmail !== plan.input.agent.email ||
      runtimeSpace?.provider !== space.provider ||
      runtimeSpace?.model !== space.model ||
      runtimeSpace?.dimensions !== space.dimensions ||
      runtimeSpace?.revision !== space.revision
    )
      throw new Error('Runtime config agent, owner, or embedding space differs from seed plan');
  }
}

/** Keep the create-only seed outside the setup package and before runtime deployment. */
export async function provisionConsumerInstallationWithSeed(
  dependencies: ConsumerInstallDependencies,
  options: ConsumerInstallOptions & { seedInput?: unknown; seedAuthClient?: AuthClient },
  provision: typeof provisionConsumerInstallation = provisionConsumerInstallation,
): Promise<ConsumerInstallResult & { seed?: SeedSummary }> {
  const { seedInput, seedAuthClient, ...installOptions } = options;
  if (seedInput === undefined) return provision(dependencies, installOptions);
  const plan = planConsumerRuntimeSeed(seedInput);
  validateSeedScope(plan, installOptions);
  const summary = {
    planHash: plan.planHash,
    recordCount: plan.records.length,
    agentId: plan.input.agent.id,
  };
  // This verifies the archive, runtime config, and current installation stage
  // before the foundation or seed changes customer resources.
  const preview = await provision(dependencies, { ...installOptions, apply: false });
  if (!installOptions.apply) return { ...preview, seed: { status: 'planned', ...summary } };

  const initialized = preview.manifest.stage.current === 'initialized';
  if (preview.manifest.stage.current === 'ready')
    throw new Error('Runtime seed cannot be added after the installation is ready');
  const foundation = initialized
    ? preview
    : await provision(dependencies, { ...installOptions, runtime: undefined });
  if (foundation.manifest.stage.current !== 'provisioned' && !initialized)
    throw new Error('Runtime seed requires a provisioned customer foundation');

  const store = createInstallationStore({
    projectId: plan.input.projectId,
    installationId: plan.input.installationId,
    databaseId: preview.manifest.identity.databaseId,
    ...(seedAuthClient ? { authClient: seedAuthClient } : {}),
  });
  let status: 'seeded' | 'already_seeded';
  try {
    if (initialized) {
      const marker = await store.doc('coordination', 'runtime-seed').get();
      if (!marker.exists)
        throw new Error('Initialized runtime has no seed marker; refusing late seed creation');
    }
    const result = await applyConsumerRuntimeSeed(store, plan);
    if (result.status !== 'seeded' && result.status !== 'already_seeded')
      throw new Error('Runtime seed returned an unexpected state');
    status = result.status;
  } finally {
    await store.db.terminate();
  }
  const result = installOptions.runtime
    ? await provision(dependencies, installOptions)
    : foundation;
  return { ...result, seed: { status, ...summary } };
}

/** Build customer-owned runtime images after the foundation has passed its read-only checks. */
export async function provisionConsumerInstallationWithPublishedImages(
  dependencies: ConsumerInstallDependencies,
  options: ConsumerInstallOptions & {
    seedInput?: unknown;
    seedAuthClient?: AuthClient;
    runtimeConfig: unknown;
  },
  provision: typeof provisionConsumerInstallation = provisionConsumerInstallation,
  publish: typeof publishConsumerImages = publishConsumerImages,
): Promise<ConsumerInstallResult & { imagePublish: unknown; seed?: SeedSummary }> {
  const { seedInput, seedAuthClient, ...installOptions } = options;
  if (installOptions.runtime) throw new Error('Use either --images or --build-images, not both');
  if (installOptions.manifest.selection.modelProvider !== 'google')
    throw new Error('Building the customer runtime requires the Google model provider');
  if (seedInput !== undefined) {
    validateSeedScope(planConsumerRuntimeSeed(seedInput), {
      ...installOptions,
      runtime: { images: {}, config: options.runtimeConfig },
    });
  }

  const sourceSha = installOptions.manifest.identity.release.commitSha;
  const checkout = await dependencies.runner.run('git', ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!checkout.ok || checkout.stdout !== sourceSha)
    throw new Error(
      '--build-images requires the installer checkout HEAD to match the manifest source commit',
    );
  const changes = await dependencies.runner.run('git', [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  if (!changes.ok) throw new Error('Could not verify the installer checkout status');
  if (changes.stdout.length > 0)
    throw new Error('--build-images requires a clean tracked working tree');

  const foundation = await provision(dependencies, { ...installOptions, apply: false });
  if (foundation.manifest.stage.current !== 'provisioned')
    throw new Error('--build-images requires an already provisioned customer foundation');

  const scratch = await mkdtemp(path.join(tmpdir(), 'assistant-consumer-install-'));
  const outputPath = path.join(scratch, 'image-manifest.json');
  try {
    const publishResult = await publish(
      {
        projectId: installOptions.manifest.identity.projectId,
        region: installOptions.manifest.identity.region,
        repositoryId: installOptions.manifest.identity.installationId,
        sourceSha,
        dryRun: !installOptions.apply,
        ...(installOptions.apply ? { outputPath } : {}),
      },
      { onProgress: reportImagePublishProgress },
    );
    if (!installOptions.apply) return { ...foundation, imagePublish: publishResult };

    const imageManifestText = await readFile(outputPath, 'utf8');
    const images = JSON.parse(imageManifestText) as unknown;
    // Later steps (owner access, owner claim, verify, update) resume with the
    // same digests, so keep the non-secret image manifest beside the state.
    // One file per release keeps earlier digests available for rollback.
    const imageManifestPath = path.join(
      path.dirname(installOptions.statePath),
      `image-manifest-${sourceSha}.json`,
    );
    await writeFile(imageManifestPath, imageManifestText, { mode: 0o600, flag: 'wx' }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        if ((await readFile(imageManifestPath, 'utf8')) !== imageManifestText)
          throw new Error(
            `${imageManifestPath} already holds a different image manifest; move it aside before rebuilding`,
          );
      },
    );
    const result = await provisionConsumerInstallationWithSeed(
      dependencies,
      {
        ...installOptions,
        seedInput,
        seedAuthClient,
        runtime: { images, config: options.runtimeConfig },
      },
      provision,
    );
    return {
      ...result,
      imagePublish: {
        published: true,
        sourceSha,
        imageManifestPath,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function ownerReplyDelivered(
  store: ReturnType<typeof createInstallationStore>,
  context: ConsumerVerifyContext,
): Promise<boolean> {
  const asDate = (value: unknown): Date | null => {
    if (value instanceof Date) return value;
    if (value && typeof value === 'object' && 'toDate' in value) {
      const converted = (value as { toDate?: unknown }).toDate;
      if (typeof converted === 'function') {
        const date = converted.call(value);
        if (date instanceof Date) return date;
      }
    }
    return null;
  };
  const initializedAt = new Date(context.runtimeInitializedAt);
  if (!Number.isFinite(initializedAt.getTime())) return false;
  const recentCalls = await store
    .collection('modelCalls')
    .where('createdAt', '>=', initializedAt)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  for (const callDoc of recentCalls.docs) {
    const call = callDoc.data() as {
      outputTokens?: unknown;
      taskId?: unknown;
      createdAt?: unknown;
      runtimeRevision?: unknown;
      runtimeReleaseSha?: unknown;
    };
    if (
      typeof call.outputTokens !== 'number' ||
      call.outputTokens <= 0 ||
      typeof call.taskId !== 'string' ||
      call.runtimeRevision !== context.servingAgentRevision ||
      call.runtimeReleaseSha !== context.releaseSha
    )
      continue;
    const taskSnapshot = await store.doc('tasks', call.taskId).get();
    if (!taskSnapshot.exists) continue;
    const task = taskSnapshot.data() as {
      agentId?: unknown;
      trust?: unknown;
      type?: unknown;
      status?: unknown;
      conversationId?: unknown;
      trigger?: unknown;
      createdAt?: unknown;
    };
    const admission = chatAdmissionPayload(task as Parameters<typeof chatAdmissionPayload>[0]);
    const taskCreatedAt = asDate(task.createdAt);
    if (
      task.agentId !== context.agentId ||
      task.trust !== 'owner' ||
      task.type !== 'chat_turn' ||
      task.status !== 'done' ||
      !admission ||
      typeof task.conversationId !== 'string' ||
      !(taskCreatedAt instanceof Date) ||
      taskCreatedAt < initializedAt
    )
      continue;
    const callAt = asDate(call.createdAt);
    if (!(callAt instanceof Date)) continue;
    const messages = await store.collection('messages').where('taskId', '==', call.taskId).get();
    const request = messages.docs.find((messageDoc) => {
      const message = messageDoc.data() as {
        role?: unknown;
        origin?: unknown;
        text?: unknown;
        createdAt?: unknown;
        clientId?: unknown;
        conversationId?: unknown;
      };
      const createdAt = asDate(message.createdAt);
      return (
        message.role === 'user' &&
        message.origin === 'owner' &&
        messageDoc.get('id') === admission.triggerMessageId &&
        message.conversationId === task.conversationId &&
        typeof message.text === 'string' &&
        message.text.trim().length > 0 &&
        typeof message.clientId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.clientId) &&
        typeof message.conversationId === 'string' &&
        createdAt instanceof Date &&
        createdAt >= initializedAt &&
        createdAt <= callAt
      );
    });
    if (!request) continue;
    const requestData = request.data() as { clientId?: unknown; conversationId?: unknown };
    const replies = messages.docs.filter((messageDoc) => {
      const message = messageDoc.data() as {
        role?: unknown;
        origin?: unknown;
        text?: unknown;
        createdAt?: unknown;
        conversationId?: unknown;
        clientDeliveredAt?: unknown;
        clientDeliveredBy?: unknown;
      };
      const createdAt = asDate(message.createdAt);
      const deliveredAt = asDate(message.clientDeliveredAt);
      return (
        message.role === 'assistant' &&
        message.origin === 'assistant' &&
        message.conversationId === task.conversationId &&
        typeof message.text === 'string' &&
        message.text.trim().length > 0 &&
        typeof message.conversationId === 'string' &&
        deliveredAt instanceof Date &&
        typeof message.clientDeliveredBy === 'string' &&
        createdAt instanceof Date &&
        createdAt >= initializedAt &&
        deliveredAt >= createdAt &&
        createdAt >= callAt &&
        message.clientDeliveredBy === requestData.clientId
      );
    });
    if (replies.length) return true;
  }
  return false;
}

type StoreFactory = (authClient?: AuthClient) => ReturnType<typeof createInstallationStore>;

/** Customer-side Firestore evidence for --verify; reads only configuration and call metadata. */
export function firestoreReadinessEvidence(
  createStore: StoreFactory,
  authClient?: AuthClient,
): (context: ConsumerVerifyContext) => Promise<ConsumerReadinessEvidence> {
  return async (context) => {
    const store = createStore(authClient);
    try {
      const preflight = await checkFirestoreRuntimeData(store, {
        agentId: context.agentId,
        provider: 'vertex',
        embeddingSpace: context.embeddingSpace,
      });
      return {
        runtimeData: {
          ready: preflight.ready,
          issues: preflight.issues.map((issue) => `${issue.code}:${issue.subject}`),
        },
        ownerReplyDelivered: await ownerReplyDelivered(store, context),
      };
    } finally {
      await store.db.terminate();
    }
  };
}

/** Issue the owner setup link for a deployed passkey runtime that has no owner yet. */
export async function issueInstallerOwnerClaim(
  result: ConsumerInstallResult,
  createStore: StoreFactory,
  authClient?: AuthClient,
): Promise<{ setupUrl: string; expiresAt: string } | { skipped: string }> {
  const access = result.ownerAccess;
  if (access?.ownerAuth !== 'passkey' || !access.publicInvoker)
    return { skipped: 'owner claims apply only to a deployed, public passkey runtime' };
  const store = createStore(authClient);
  try {
    const repository = new FirestoreOwnerAuthRepository(store);
    if ((await repository.state()).claimed)
      return {
        skipped:
          'the installation already has an owner; use pnpm consumer:owner-claim --recover for cloud-owner recovery',
      };
    const link = await issueOwnerSetupLink(repository, {
      origin: access.authOrigin,
      grant: 'claim',
    });
    return { setupUrl: link.setupUrl, expiresAt: link.expiresAt };
  } finally {
    await store.db.terminate();
  }
}

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`cannot read valid JSON from ${path}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' },
      apply: { type: 'boolean' },
      'build-images': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      manifest: { type: 'string' },
      images: { type: 'string' },
      'runtime-config': { type: 'string' },
      'seed-plan': { type: 'string' },
      'gcloud-auth': { type: 'boolean', default: false },
      'owner-access-callback': { type: 'string' },
      'issue-owner-claim': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      'owner-signed-in': { type: 'boolean', default: false },
      'native-app-version': { type: 'string' },
      'native-pairing-confirmed': { type: 'boolean', default: false },
      state: { type: 'string' },
      'state-bucket': { type: 'string' },
      'terraform-dir': { type: 'string' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const required = [
    ['--manifest', values.manifest],
    ['--archive', values.archive],
    ['--state', values.state],
    ['--state-bucket', values['state-bucket']],
    ['--terraform-dir', values['terraform-dir']],
  ] as const;
  const missing = required.find(([, value]) => !value)?.[0];
  if (missing) throw new Error(`missing ${missing}\n\n${usage.trim()}`);
  if (!values['build-images'] && Boolean(values.images) !== Boolean(values['runtime-config']))
    throw new Error('--images and --runtime-config must be supplied together');
  if (values['build-images'] && (!values['runtime-config'] || values.images))
    throw new Error(
      '--build-images requires --runtime-config and cannot be combined with --images',
    );
  if (values['build-images'] && values['owner-access-callback'])
    throw new Error('--build-images cannot be combined with --owner-access-callback');
  if (
    (values.verify || values['issue-owner-claim']) &&
    (values['build-images'] || values['seed-plan'])
  )
    throw new Error('--verify and --issue-owner-claim run on an already deployed runtime');
  if ((values['native-app-version'] || values['native-pairing-confirmed']) && !values.verify)
    throw new Error('Native client confirmation only applies to --verify');
  if (values['owner-signed-in'] && !values.verify)
    throw new Error('--owner-signed-in only applies to --verify');
  const options: ConsumerInstallOptions = {
    manifest: validateInstallationManifest(await json(values.manifest as string)),
    archivePath: values.archive as string,
    statePath: values.state as string,
    stateBucket: values['state-bucket'] as string,
    terraformDir: values['terraform-dir'] as string,
    apply: values.apply === true,
    runtime:
      values.images && values['runtime-config']
        ? { images: await json(values.images), config: await json(values['runtime-config']) }
        : undefined,
    ownerAccessCallback: values['owner-access-callback'],
  };
  const installDependencies = { runner: systemRunner };
  const firestoreNeeded = Boolean(
    values['seed-plan'] || values.verify || values['issue-owner-claim'],
  );
  if (values['gcloud-auth'] && !firestoreNeeded)
    throw new Error(
      '--gcloud-auth is only available with --seed-plan, --verify, or --issue-owner-claim',
    );
  const seedInput = values['seed-plan'] ? await json(values['seed-plan']) : undefined;
  const seedAuthClient =
    (values.apply || values.verify) && values['gcloud-auth']
      ? await createGcloudAuthClient()
      : undefined;
  const createStore: StoreFactory = (authClient) =>
    createInstallationStore({
      projectId: options.manifest.identity.projectId,
      installationId: options.manifest.identity.installationId,
      databaseId: options.manifest.identity.databaseId,
      ...(authClient ? { authClient } : {}),
    });
  if (values.verify)
    options.verify = {
      evidence: firestoreReadinessEvidence(createStore, seedAuthClient),
      ownerSignInConfirmed: values['owner-signed-in'] === true,
      nativeAppVersion: values['native-app-version'],
      nativePairingConfirmed: values['native-pairing-confirmed'] === true,
    };
  const installOptions = {
    ...options,
    seedInput,
    seedAuthClient,
  };
  const result = values['build-images']
    ? await provisionConsumerInstallationWithPublishedImages(installDependencies, {
        ...installOptions,
        runtimeConfig: await json(values['runtime-config'] as string),
      })
    : await provisionConsumerInstallationWithSeed(installDependencies, installOptions);
  const ownerClaim =
    values['issue-owner-claim'] && values.apply
      ? await issueInstallerOwnerClaim(result, createStore, seedAuthClient)
      : undefined;
  // The setup link is shown once here and is not written to installer state.
  process.stdout.write(
    `${JSON.stringify(ownerClaim ? { ...result, ownerClaim } : result, null, 2)}\n`,
  );
  if (result.verification && !result.verification.passed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `consumer:install: ${error instanceof Error ? error.message : 'installation failed'}\n`,
    );
    process.exitCode = 1;
  }
}
