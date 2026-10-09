import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAgent } from '@assistant/core';
import { agents, conversations, costReservations, createDb, messages, tasks } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertAllocatedTestTargetMarker } from '../test-target.js';
import { cleanupReadabilityFixtures } from './chat-readability-fixtures.js';
import {
  assertReadabilityCallFits,
  parseReadabilitySpendCap,
  type ReadabilityRunManifest,
  runCappedReadabilityAttempt,
  summarizeReadabilitySpend,
  writeImmutableJson,
} from './chat-readability-safety.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const targetToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!databaseUrl || !targetToken) throw new Error('Run through the allocated pnpm test wrapper');
const databaseName = new URL(databaseUrl).pathname.slice(1);
const target = assertAllocatedTestTargetMarker({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: targetToken,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const db = createDb(databaseUrl, { max: 3 });
let agentId: string;
let artifactDirectory: string;

describe('chat readability run safety', () => {
  beforeAll(async () => {
    agentId = (await getAgent(db)).id;
    artifactDirectory = await mkdtemp(path.join(tmpdir(), 'chat-readability-'));
  });

  afterAll(async () => {
    await rm(artifactDirectory, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  it('requires an explicit small bounded cap and rejects invalid amounts', () => {
    expect(parseReadabilitySpendCap('0.25')).toBe(0.25);
    expect(parseReadabilitySpendCap('10')).toBe(10);
    for (const value of [undefined, '', '0', '-1', '10.01', '1e-2', '0.00001', 'NaN']) {
      expect(() => parseReadabilitySpendCap(value)).toThrow();
    }
  });

  it('aggregates actual cost and held estimates, and stops before an unresolved attempt can be followed', () => {
    const known = summarizeReadabilitySpend([
      { status: 'reconciled', estimatedUsd: '0.08', actualUsd: '0.03' },
      { status: 'released', estimatedUsd: '0.10', actualUsd: null },
      { status: 'held', estimatedUsd: '0.04', actualUsd: null },
    ]);
    expect(known.reservedUsd).toBeCloseTo(0.07);
    expect(known.unknown).toBe(true);
    const providerKnown = summarizeReadabilitySpend([
      { status: 'reconciled', estimatedUsd: '0.08', actualUsd: '0.03' },
    ]);
    expect(
      summarizeReadabilitySpend([{ status: 'reconciled', estimatedUsd: '0.08', actualUsd: null }])
        .unknown,
    ).toBe(true);
    expect(assertReadabilityCallFits(0.1, providerKnown)).toBeCloseTo(0.07);
    expect(() => assertReadabilityCallFits(0.03, providerKnown)).toThrow(/cap is exhausted/);
    expect(() => assertReadabilityCallFits(0.1, known)).toThrow(/unresolved model usage/);

    const provider = vi.fn(async () => ({ text: 'should not run' }));
    try {
      assertReadabilityCallFits(0.1, known);
      void provider();
    } catch {
      // The gate executes before provider work.
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it('runs mocked generations serially and does not start another call after cap or unknown usage', async () => {
    let spend = summarizeReadabilitySpend([]);
    const snapshots = vi.fn(async () => spend);
    const provider = vi.fn(async (_maxEstimatedCostUsd: number) => {
      const index = provider.mock.calls.length;
      spend = summarizeReadabilitySpend([
        {
          status: 'reconciled',
          estimatedUsd: index === 1 ? '0.04' : '0.07',
          actualUsd: index === 1 ? '0.04' : '0.07',
        },
      ]);
      return { index };
    });
    const invoke = async () => {
      return runCappedReadabilityAttempt({
        capUsd: 0.1,
        readSpend: snapshots,
        invoke: provider,
        afterAttempt: async () => {},
      });
    };
    await invoke();
    expect(await invoke()).toEqual({ index: 2 });
    expect(provider.mock.calls.map(([cap]) => cap)).toEqual([0.1, 0.06]);
    spend = summarizeReadabilitySpend([
      { status: 'reconciled', estimatedUsd: '0.11', actualUsd: '0.11' },
    ]);
    await expect(invoke()).rejects.toThrow(/cap is exhausted/);
    expect(provider).toHaveBeenCalledTimes(2);

    spend = summarizeReadabilitySpend([]);
    const unknownProvider = vi.fn(async () => {
      spend = summarizeReadabilitySpend([
        { status: 'unknown', estimatedUsd: '0.04', actualUsd: null },
      ]);
      return { index: 1 };
    });
    await expect(
      runCappedReadabilityAttempt({
        capUsd: 0.1,
        readSpend: async () => spend,
        invoke: unknownProvider,
        afterAttempt: async () => {},
      }),
    ).rejects.toThrow(/unresolved/);
    await expect(
      runCappedReadabilityAttempt({
        capUsd: 0.1,
        readSpend: async () => spend,
        invoke: unknownProvider,
        afterAttempt: async () => {},
      }),
    ).rejects.toThrow(/unresolved/);
    expect(unknownProvider).toHaveBeenCalledTimes(1);
  });

  it('writes private immutable generation evidence and refuses overwrite', async () => {
    const file = path.join(artifactDirectory, 'baseline-test-responses.json');
    await writeImmutableJson(file, { runId: randomUUID(), modelId: 'synthetic', responses: [] });
    const permissions = (await stat(file)).mode & 0o777;
    expect(permissions & 0o077).toBe(0);
    await expect(writeImmutableJson(file, { responses: ['replacement'] })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(file, 'utf8')).toContain('synthetic');
  });

  it('recovers only manifest-owned fixture IDs and retains immutable model accounting', async () => {
    const runId = randomUUID();
    const taskId = randomUUID();
    const conversationId = randomUUID();
    const foreignConversationId = randomUUID();
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) throw new Error('test agent unexpectedly missing');
    await db.insert(conversations).values([
      {
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'fixture conversation',
        metadata: {
          visualQA: true,
          fixtureKind: 'chat-readability',
          run: 'baseline',
          runId,
          targetDatabaseName: databaseName,
        },
      },
      {
        id: foreignConversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'unrelated conversation',
        metadata: { source: 'manual' },
      },
    ]);
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      type: 'adhoc',
      status: 'running',
      trust: 'owner',
      title: `Chat readability generation ${runId}`,
      trigger: { source: 'visual-qa', fixtureKind: 'chat-readability', runId },
      externalEventId: `visual-qa:chat-readability:${runId}`,
      state: { fixtureKind: 'chat-readability', runId },
      budgetUsdLimit: '0.2500',
    });
    await db.insert(messages).values([
      {
        conversationId,
        role: 'assistant',
        parts: [{ type: 'text', text: 'synthetic response' }],
        text: 'synthetic response',
        origin: 'assistant',
        channelMessageId: `readability-baseline-${runId}-01-assistant`,
      },
      {
        conversationId,
        role: 'user',
        parts: [{ type: 'text', text: 'manual owner follow-up' }],
        text: 'manual owner follow-up',
        origin: 'owner',
        channelMessageId: 'manual-owner-follow-up',
      },
    ]);
    await db.insert(costReservations).values({
      taskId,
      source: 'model',
      estimatedUsd: '0.020000',
      status: 'reconciled',
      actualUsd: '0.011000',
      description: 'synthetic mocked provider usage',
      reconciledAt: new Date(),
    });
    const manifest: ReadabilityRunManifest = {
      schemaVersion: 1,
      runId,
      run: 'baseline',
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId,
      taskId,
      conversationId,
      modelId: 'synthetic/mock',
      framing: 'synthetic test framing',
      systemPromptSha256: '1'.repeat(64),
      capUsd: 0.25,
      corpusSha256: '0'.repeat(64),
      createdAt: new Date().toISOString(),
      status: 'interrupted',
    };
    await writeImmutableJson(path.join(artifactDirectory, `baseline-${runId}.jsonl`), {
      event: 'run_planned',
      runId,
    });
    await writeImmutableJson(
      path.join(artifactDirectory, `baseline-${runId}.manifest.json`),
      manifest,
    );
    const result = await cleanupReadabilityFixtures({
      db,
      artifactDirectory,
      target,
      run: 'baseline',
    });
    expect(result).toEqual({ cleaned: 1, skipped: 0 });
    const [preservedFixtureChat] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const retainedMessages = await db
      .select({ channelMessageId: messages.channelMessageId })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const [preserved] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, foreignConversationId));
    const [retainedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const [retainedCost] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.taskId, taskId));
    expect(preservedFixtureChat?.id).toBe(conversationId);
    expect(retainedMessages.map((message) => message.channelMessageId)).toEqual([
      'manual-owner-follow-up',
    ]);
    expect(preserved?.id).toBe(foreignConversationId);
    expect(retainedTask?.status).toBe('done');
    expect(retainedTask?.archivedAt).toBeInstanceOf(Date);
    expect(retainedCost?.actualUsd).toBe('0.011000');
    await expect(
      cleanupReadabilityFixtures({ db, artifactDirectory, target, run: 'baseline' }),
    ).resolves.toEqual({ cleaned: 0, skipped: 1 });
  });

  it('refuses cleanup when the stored target token does not match this allocated database', async () => {
    const runId = randomUUID();
    const manifest: ReadabilityRunManifest = {
      schemaVersion: 1,
      runId,
      run: 'reframed',
      targetDatabaseName: target.databaseName,
      targetToken: 'f'.repeat(24),
      agentId,
      taskId: randomUUID(),
      conversationId: randomUUID(),
      modelId: 'synthetic/mock',
      framing: 'synthetic test framing',
      systemPromptSha256: '1'.repeat(64),
      capUsd: 0.25,
      corpusSha256: '0'.repeat(64),
      createdAt: new Date().toISOString(),
      status: 'interrupted',
    };
    await writeImmutableJson(
      path.join(artifactDirectory, `reframed-${runId}.manifest.json`),
      manifest,
    );
    const result = await cleanupReadabilityFixtures({
      db,
      artifactDirectory,
      target,
      run: 'reframed',
    });
    expect(result).toEqual({ cleaned: 0, skipped: 1 });
  });
});
