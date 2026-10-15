import { createDb, type Db, responseChecks, tasks } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { type GoldenFixture, runGoldenTask } from '../golden/harness.js';

const databaseUrl = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});
const url = 'https://transit.example/airport';
const request = `Read ${url} and summarize its public transport options in three short bullets with a source link. Do not use my email, calendar, or memories.`;
const source = [
  'R10',
  '- Route: Central - Airport',
  '- Frequency: every 15 minutes',
  'B10',
  '- Route: South - Airport',
  '- Frequency: hourly',
  'B20',
  '- Route: North - Interchange',
  '- Continue to Airport with R10.',
].join('\n');
const summary = [
  '- R10 links Central with Airport every 15 minutes.',
  '- B10 links South with Airport hourly.',
  `- B20 ends at Interchange; continue with R10. [Source](${url})`,
].join('\n');
const verbose = `${'R10 connects Central with Airport. '.repeat(35)}\n${'B20 requires a transfer. '.repeat(35)}\n[Source](${url})`;

describe('public page summary through the allocated executor', () => {
  let db: Db;
  let agentId: string;
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Allocated test database missing');
    db = createDb(databaseUrl);
    agentId = (await getAgent(db)).id;
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });
  it.each(['complete', 'incomplete', 'unsupported'] as const)(
    'keeps source evidence, presentation and terminal state aligned for a %s correction',
    async (kind) => {
      const revision =
        kind === 'complete'
          ? summary
          : kind === 'unsupported'
            ? summary.replace(
                'B10 links South with Airport hourly',
                'B10 links South with Airport every 15 minutes',
              )
            : `- R10 links Central with Airport.\n- Connections: [Source](${url})`;
      const fixture: GoldenFixture = {
        name: `public-summary-${kind}`,
        event: { source: 'chat', trust: 'owner', payload: { text: request } },
        taskType: 'chat_turn',
        pinOwnerRequest: true,
        plan: {
          action: 'workflow',
          reasoning: 'Read the requested public page and summarize it.',
          steps: ['Read the page.', 'Summarize its transport options.'],
          missingInfo: [],
        },
        script: [{ text: verbose }],
        verification: { decision: 'revise', revisedText: revision, reasons: ['ungrounded_fact'] },
        tools: {
          'web.fetch': {
            schema: z.object({ url: z.string() }),
            execute: async () => ({ status: 200, finalUrl: url, text: source, truncated: false }),
          },
        },
      };
      const result = await runGoldenTask(db, agentId, fixture);
      expect(result.toolNames).toEqual(['web.fetch']);
      // Two verifier passes plus the existing checklist review.
      expect(result.objectRoles.filter((role) => role === 'rewrite')).toHaveLength(3);
      const [check] = await db
        .select()
        .from(responseChecks)
        .where(eq(responseChecks.taskId, result.taskId));
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, result.taskId) });
      if (kind === 'complete') {
        expect(result.status).toBe('done');
        expect(result.finalText).toBe(summary);
        expect(check).toMatchObject({ blocked: false, unsupportedCount: 0 });
      } else {
        expect(result.status).toBe('needs_attention');
        expect(result.finalText).not.toBe(verbose);
        expect(result.finalText).not.toBe(revision);
        expect(result.finalText).toContain(url);
        expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });
        if (!task) throw new Error('Missing durable task');
        expect((task.state as { pendingFinal?: { outcome?: string } }).pendingFinal?.outcome).toBe(
          'needs_attention',
        );
      }
      expect(check).toMatchObject({
        outputVerificationAttempted: true,
        outputVerificationRevised: true,
      });
    },
  );

  it.each(['failed', 'truncated'] as const)(
    'does not mark an explicit page summary done when its %s fetch receipt is unusable',
    async (kind) => {
      const requestedUrl = url;
      const fetchedUrl = requestedUrl;
      const fixture: GoldenFixture = {
        name: `public-page-fetch-${kind}`,
        event: { source: 'chat', trust: 'owner', payload: { text: request } },
        taskType: 'chat_turn',
        pinOwnerRequest: true,
        plan: {
          action: 'workflow',
          reasoning: 'Read the requested public page and summarize its transport options.',
          steps: ['Read the page.', 'Summarize its transport options.'],
          missingInfo: [],
        },
        script: [
          { toolCalls: [{ toolName: 'web.fetch', input: { url: fetchedUrl } }] },
          { text: summary },
        ],
        verification: { unavailable: true },
        tools: {
          'web.fetch': {
            schema: z.object({ url: z.string() }),
            execute: async () => ({
              status: kind === 'failed' ? 503 : 200,
              finalUrl: fetchedUrl,
              text: source,
              truncated: kind === 'truncated',
            }),
          },
        },
      };
      const result = await runGoldenTask(db, agentId, fixture);
      expect(result.toolNames).toContain('web.fetch');
      expect(result.status).toBe('needs_attention');
      expect(result.finalText).not.toContain('R10 links Central');
      if (kind === 'truncated')
        expect(result.finalText).toContain('couldn’t verify a complete current fetch');
      const [check] = await db
        .select()
        .from(responseChecks)
        .where(eq(responseChecks.taskId, result.taskId));
      if (kind === 'truncated') expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });
      else expect(check).toMatchObject({ blocked: false, unsupportedCount: 0 });
    },
  );

  it('keeps a complete redirect-bound page read', async () => {
    const requestedUrl = 'https://transit.example/redirect';
    const redirectedRequest = request.replace(url, requestedUrl);
    const redirectFixture: GoldenFixture = {
      name: 'public-page-redirect-bound',
      event: { source: 'chat', trust: 'owner', payload: { text: redirectedRequest } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: {
        action: 'workflow',
        reasoning: 'Read the requested public page and summarize its transport options.',
        steps: ['Read the page.', 'Summarize its transport options.'],
        missingInfo: [],
      },
      script: [
        { toolCalls: [{ toolName: 'web.fetch', input: { url: requestedUrl } }] },
        { text: summary },
      ],
      verification: { unavailable: true },
      tools: {
        'web.fetch': {
          schema: z.object({ url: z.string() }),
          execute: async () => ({ status: 200, finalUrl: url, text: source, truncated: false }),
        },
      },
    };
    const redirected = await runGoldenTask(db, agentId, redirectFixture);
    expect(redirected.status).toBe('done');
    expect(redirected.finalText).toBe(summary);
    expect(redirected.toolNames).toContain('web.fetch');
  });
});
