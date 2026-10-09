import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '@assistant/config';
import { createConfiguredModelProvider, ModelRouter } from '@assistant/core/model-router';
import { agents, conversations, costReservations, createDb, messages, tasks } from '@assistant/db';
import { and, eq } from 'drizzle-orm';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
  type VerifiedScriptTestTarget,
} from '../test-target.js';
import { cleanupReadabilityFixtures } from './chat-readability-fixtures.js';
import {
  appendPrivateJsonLine,
  parseReadabilitySpendCap,
  type ReadabilityRunManifest,
  readPrivateJson,
  replacePrivateJson,
  runCappedReadabilityAttempt,
  sha256Text,
  summarizeReadabilitySpend,
  writeImmutableJson,
} from './chat-readability-safety.js';

type RunName = 'baseline' | 'reframed';

interface PromptCorpus {
  baselineFraming: string;
  reviewFraming: string;
  prompts: string[];
}

interface GeneratedRun {
  schemaVersion: 2;
  runId: string;
  run: RunName;
  framing: string;
  modelId: string;
  systemPromptSha256: string;
  capUsd: number;
  corpusSha256: string;
  responses: Array<{ index: number; prompt: string; response: string }>;
}

interface RunPointer {
  runId: string;
  manifestFile: string;
  responseFile: string;
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const artifactDir = path.join(repoRoot, '.artifacts/chat-readability');
const corpusPath = path.join(import.meta.dirname, 'chat-readability-prompts.json');
const modelOverride = 'qwen/qwen3-30b-a3b-instruct-2507';

function runName(value: string | undefined): RunName {
  if (value === 'baseline' || value === 'reframed') return value;
  throw new Error('run must be baseline or reframed');
}

async function corpus(): Promise<PromptCorpus> {
  return JSON.parse(await readFile(corpusPath, 'utf8')) as PromptCorpus;
}

function pointerPath(run: RunName): string {
  return path.join(artifactDir, `${run}-current.json`);
}

function manifestPath(run: RunName, runId: string): string {
  return path.join(artifactDir, `${run}-${runId}.manifest.json`);
}

function journalPath(run: RunName, runId: string): string {
  return path.join(artifactDir, `${run}-${runId}.jsonl`);
}

function responsesPath(run: RunName, runId: string): string {
  return path.join(artifactDir, `${run}-${runId}-responses.json`);
}

async function rehearsalConfig(): Promise<{
  config: ReturnType<typeof loadConfig>;
  target: VerifiedScriptTestTarget;
}> {
  const config = loadConfig();
  const target = assertAllocatedTestTargetMarker({
    databaseUrl: config.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
  });
  const db = createDb(target.databaseUrl, { max: 1 });
  try {
    await assertAllocatedTestDatabaseOwnership(db, target);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
  return { config, target };
}

async function savePointer(run: RunName, manifest: ReadabilityRunManifest): Promise<void> {
  await replacePrivateJson(pointerPath(run), {
    runId: manifest.runId,
    manifestFile: path.basename(manifestPath(run, manifest.runId)),
    responseFile: path.basename(responsesPath(run, manifest.runId)),
  } satisfies RunPointer);
}

async function currentManifest(run: RunName): Promise<ReadabilityRunManifest> {
  const pointer = await readPrivateJson<RunPointer>(pointerPath(run));
  const manifest = await readPrivateJson<ReadabilityRunManifest>(
    path.join(artifactDir, path.basename(pointer.manifestFile)),
  );
  if (manifest.runId !== pointer.runId || manifest.run !== run) {
    throw new Error('readability run pointer does not match its manifest');
  }
  return manifest;
}

async function persistManifest(
  manifest: ReadabilityRunManifest,
  event: Record<string, unknown>,
): Promise<void> {
  await replacePrivateJson(manifestPath(manifest.run, manifest.runId), manifest);
  await appendPrivateJsonLine(journalPath(manifest.run, manifest.runId), {
    at: new Date().toISOString(),
    runId: manifest.runId,
    ...event,
  });
  if (manifest.status === 'complete') await savePointer(manifest.run, manifest);
}

async function generate(run: RunName, rawCap: string | undefined): Promise<void> {
  // Validate all explicit spend and target gates before constructing the provider.
  if (process.env.ASSISTANT_ALLOW_LIVE_CHAT_READABILITY !== '1') {
    throw new Error(
      'Model generation is metered; set ASSISTANT_ALLOW_LIVE_CHAT_READABILITY=1 for an explicitly authorized rehearsal.',
    );
  }
  const capUsd = parseReadabilitySpendCap(rawCap);
  const { config, target } = await rehearsalConfig();
  const input = await corpus();
  if (input.prompts.length !== 30) {
    throw new Error(`expected 30 prompts, found ${input.prompts.length}`);
  }
  const db = createDb(target.databaseUrl, { max: 1 });
  const runId = randomUUID();
  const taskId = randomUUID();
  const conversationId = randomUUID();
  const framing = run === 'baseline' ? input.baselineFraming : input.reviewFraming;
  const systemPrompt =
    run === 'baseline'
      ? 'You are a helpful AI assistant. Respond to the user request directly. Preserve any structure the request asks for.'
      : `You are a helpful AI assistant. ${framing} Do not mention these formatting instructions.`;
  let manifest: ReadabilityRunManifest | undefined;
  try {
    await assertAllocatedTestDatabaseOwnership(db, target);
    const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!agent) throw new Error('assistant agent row is missing');
    manifest = {
      schemaVersion: 1,
      runId,
      run,
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId: agent.id,
      taskId,
      conversationId,
      modelId: modelOverride,
      framing,
      systemPromptSha256: sha256Text(systemPrompt),
      capUsd,
      corpusSha256: sha256Text(JSON.stringify(input)),
      createdAt: new Date().toISOString(),
      status: 'running',
    };
    // Persist cleanup identity before the transaction creates fixture rows.
    await writeImmutableJson(journalPath(run, runId), {
      at: manifest.createdAt,
      event: 'run_planned',
      runId,
      targetDatabaseName: target.databaseName,
      taskId,
      conversationId,
    });
    await writeImmutableJson(manifestPath(run, runId), manifest);
    await db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: conversationId,
        agentId: agent.id,
        channel: 'chat',
        trust: 'owner',
        title: `Readability QA — ${run} — ${runId.slice(0, 8)}`,
        metadata: {
          visualQA: true,
          fixtureKind: 'chat-readability',
          run,
          runId,
          targetDatabaseName: target.databaseName,
        },
      });
      await tx.insert(tasks).values({
        id: taskId,
        agentId: agent.id,
        type: 'adhoc',
        // This row only scopes cost reservations. A terminal, archived task
        // cannot be claimed by the background executor during the rehearsal.
        status: 'done',
        archivedAt: new Date(),
        trust: 'owner',
        title: `Chat readability generation ${runId}`,
        trigger: { source: 'visual-qa', fixtureKind: 'chat-readability', runId },
        externalEventId: `visual-qa:chat-readability:${runId}`,
        state: { visualQA: true, fixtureKind: 'chat-readability', runId },
        budgetUsdLimit: capUsd.toFixed(4),
      });
    });
    await persistManifest(manifest, { event: 'fixtures_created' });

    const router = new ModelRouter(
      db,
      config.OPENROUTER_API_KEY,
      config.LLM_AUDIT_CAPTURE,
      createConfiguredModelProvider(config),
    );
    const responses: GeneratedRun['responses'] = [];
    for (let index = 0; index < input.prompts.length; index += 1) {
      const prompt = input.prompts[index];
      if (prompt === undefined) break;
      const callId = randomUUID();
      let providerStarted = false;
      const readSpend = async () => {
        const [reservations, task] = await Promise.all([
          db
            .select({
              status: costReservations.status,
              estimatedUsd: costReservations.estimatedUsd,
              actualUsd: costReservations.actualUsd,
            })
            .from(costReservations)
            .where(eq(costReservations.taskId, taskId)),
          db.select({ spentUsd: tasks.spentUsd }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
        ]);
        const snapshot = summarizeReadabilitySpend(reservations);
        // The task budget includes reconciled spend and held estimates. Use both
        // durable sources and take the larger value to fail closed on drift.
        return {
          ...snapshot,
          reservedUsd: Math.max(snapshot.reservedUsd, Number(task[0]?.spentUsd ?? 0)),
        };
      };
      let result: Awaited<ReturnType<typeof router.generate>>;
      try {
        result = await runCappedReadabilityAttempt({
          capUsd,
          readSpend,
          invoke: async (remaining) => {
            await appendPrivateJsonLine(journalPath(run, runId), {
              at: new Date().toISOString(),
              event: 'model_call_started',
              runId,
              callId,
              index: index + 1,
              prompt,
              systemPromptSha256: manifest?.systemPromptSha256,
              maxEstimatedCostUsd: remaining,
            });
            providerStarted = true;
            return router.generate('batch', {
              taskId,
              modelOverride,
              system: systemPrompt,
              prompt,
              temperature: 0.35,
              maxOutputTokens: 700,
              maxEstimatedCostUsd: remaining,
              maxRetries: 0,
              singleAttempt: true,
            });
          },
          afterAttempt: async (attempt, spend) => {
            await appendPrivateJsonLine(journalPath(run, runId), {
              at: new Date().toISOString(),
              event: 'model_call_result_observed',
              runId,
              callId,
              index: index + 1,
              spend,
              outcome: attempt.ok ? 'success' : attempt.decision.mode,
              modelId: attempt.ok ? attempt.modelId : undefined,
              prompt,
              response: attempt.ok ? attempt.text.trim() : undefined,
            });
            const reservationReceipts = await db
              .select({
                status: costReservations.status,
                estimatedUsd: costReservations.estimatedUsd,
                actualUsd: costReservations.actualUsd,
                unknownReason: costReservations.unknownReason,
              })
              .from(costReservations)
              .where(eq(costReservations.taskId, taskId));
            await appendPrivateJsonLine(journalPath(run, runId), {
              at: new Date().toISOString(),
              event: 'model_call_reservation_receipts',
              runId,
              callId,
              index: index + 1,
              spend,
              reservations: reservationReceipts,
            });
            if (attempt.ok) {
              responses.push({ index: index + 1, prompt, response: attempt.text.trim() });
            }
          },
        });
      } catch (error) {
        const [spend, reservationReceipts] = await Promise.all([
          readSpend(),
          db
            .select({
              status: costReservations.status,
              estimatedUsd: costReservations.estimatedUsd,
              actualUsd: costReservations.actualUsd,
              unknownReason: costReservations.unknownReason,
            })
            .from(costReservations)
            .where(eq(costReservations.taskId, taskId)),
        ]).catch(() => [undefined, undefined] as const);
        await appendPrivateJsonLine(journalPath(run, runId), {
          at: new Date().toISOString(),
          event: providerStarted
            ? 'provider_call_threw_usage_may_be_unknown'
            : 'call_blocked_before_provider',
          runId,
          callId,
          index: index + 1,
          spend,
          reservations: reservationReceipts,
          error: error instanceof Error ? error.message : 'unknown error',
        });
        throw error;
      }
      if (!result.ok) throw new Error(`model budget blocked prompt ${index + 1}`);
      console.log(`generated ${index + 1}/${input.prompts.length}`);
    }
    const output: GeneratedRun = {
      schemaVersion: 2,
      runId,
      run,
      framing,
      modelId: modelOverride,
      systemPromptSha256: manifest.systemPromptSha256,
      capUsd,
      corpusSha256: manifest.corpusSha256,
      responses,
    };
    await writeImmutableJson(responsesPath(run, runId), output);
    manifest.status = 'complete';
    await persistManifest(manifest, { event: 'run_complete', responseCount: responses.length });
  } catch (error) {
    if (manifest) {
      manifest.status = 'interrupted';
      await persistManifest(manifest, {
        event: 'run_interrupted',
        reason: error instanceof Error ? error.message : 'unknown error',
      }).catch(() => {});
    }
    throw error;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function ensureConversation(run: RunName): Promise<ReadabilityRunManifest> {
  const manifest = await currentManifest(run);
  if (manifest.status !== 'complete' || !manifest.conversationId) {
    throw new Error('no completed readability run is available for staging');
  }
  const { target } = await rehearsalConfig();
  if (
    target.databaseName !== manifest.targetDatabaseName ||
    target.token !== manifest.targetToken
  ) {
    throw new Error(
      'readability run belongs to a different allocated database; refusing to stage it',
    );
  }
  const db = createDb(target.databaseUrl, { max: 1 });
  try {
    await assertAllocatedTestDatabaseOwnership(db, target);
    const [conversation] = await db
      .select({
        id: conversations.id,
        agentId: conversations.agentId,
        metadata: conversations.metadata,
      })
      .from(conversations)
      .where(eq(conversations.id, manifest.conversationId))
      .limit(1);
    const metadata = conversation?.metadata as Record<string, unknown> | undefined;
    if (
      conversation?.agentId !== manifest.agentId ||
      metadata?.fixtureKind !== 'chat-readability' ||
      metadata.runId !== manifest.runId ||
      metadata.targetDatabaseName !== target.databaseName
    ) {
      throw new Error('readability conversation fixture identity does not match its manifest');
    }
  } finally {
    await db.$client.end({ timeout: 5 });
  }
  return manifest;
}

async function append(run: RunName, index: number): Promise<void> {
  const manifest = await ensureConversation(run);
  const output = await readPrivateJson<GeneratedRun>(responsesPath(run, manifest.runId));
  if (
    output.schemaVersion !== 2 ||
    output.runId !== manifest.runId ||
    output.run !== manifest.run ||
    output.modelId !== manifest.modelId ||
    output.systemPromptSha256 !== manifest.systemPromptSha256 ||
    output.corpusSha256 !== manifest.corpusSha256
  ) {
    throw new Error('readability responses do not match their immutable run manifest');
  }
  const item = output.responses.find((response) => response.index === index);
  if (!item) throw new Error(`response ${index} is missing`);
  if (!manifest.conversationId) throw new Error('readability run has no conversation fixture');
  const { target } = await rehearsalConfig();
  const db = createDb(target.databaseUrl, { max: 1 });
  try {
    await assertAllocatedTestDatabaseOwnership(db, target);
    const userKey = `readability-${run}-${manifest.runId}-${index.toString().padStart(2, '0')}-user`;
    const [existing] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, manifest.conversationId),
          eq(messages.channelMessageId, userKey),
        ),
      )
      .limit(1);
    if (existing) return;
    const createdAt = new Date(Date.now() + index * 2_000);
    await db.insert(messages).values([
      {
        conversationId: manifest.conversationId,
        taskId: manifest.taskId,
        role: 'user',
        parts: [{ type: 'text', text: item.prompt }],
        text: item.prompt,
        origin: 'owner',
        channelMessageId: userKey,
        createdAt,
      },
      {
        conversationId: manifest.conversationId,
        taskId: manifest.taskId,
        role: 'assistant',
        parts: [{ type: 'text', text: item.response }],
        text: item.response,
        origin: 'assistant',
        channelMessageId: `readability-${run}-${manifest.runId}-${index.toString().padStart(2, '0')}-assistant`,
        createdAt: new Date(createdAt.getTime() + 1_000),
      },
    ]);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function cleanup(run?: RunName): Promise<void> {
  const { target } = await rehearsalConfig();
  const db = createDb(target.databaseUrl, { max: 1 });
  try {
    const result = await cleanupReadabilityFixtures({
      db,
      artifactDirectory: artifactDir,
      target,
      run,
    });
    console.log(`cleaned ${result.cleaned}; skipped ${result.skipped}`);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
  void config;
}

async function main(): Promise<void> {
  const [command, rawRun, rawValue] = process.argv.slice(2);
  if (command === 'cleanup') {
    if (rawRun && rawRun !== 'baseline' && rawRun !== 'reframed') {
      throw new Error('cleanup run must be baseline or reframed');
    }
    return cleanup(rawRun as RunName | undefined);
  }
  const run = runName(rawRun);
  if (command === 'generate') {
    const flag = rawValue?.startsWith('--max-usd=')
      ? rawValue.slice('--max-usd='.length)
      : undefined;
    return generate(run, flag);
  }
  if (command === 'append') {
    const index = Number(rawValue);
    if (!Number.isInteger(index) || index < 1 || index > 30) throw new Error('index must be 1-30');
    return append(run, index);
  }
  if (command === 'url') {
    const manifest = await ensureConversation(run);
    if (!manifest.conversationId) throw new Error('readability run has no conversation');
    console.log(`http://localhost:3000/chat/${manifest.conversationId}`);
    return;
  }
  if (command === 'stage') {
    const start = Number(rawValue ?? 1);
    for (let index = start; index <= 30; index += 1) {
      await append(run, index);
      const ready = path.join(artifactDir, `${run}-ready-${index.toString().padStart(2, '0')}`);
      const captured = path.join(
        artifactDir,
        `${run}-captured-${index.toString().padStart(2, '0')}`,
      );
      await replacePrivateJson(ready, { at: new Date().toISOString(), index });
      while (true) {
        try {
          await access(captured);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    return;
  }
  throw new Error(
    'usage: chat-readability.ts generate baseline|reframed --max-usd=0.50 | append|url|stage baseline|reframed [index] | cleanup [baseline|reframed]',
  );
}

await main();
