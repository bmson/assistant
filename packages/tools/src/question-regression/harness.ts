import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  type AuditDefectKind,
  enqueueTask,
  executeTask,
  getAgent,
  gradeAuditedOutput,
  type ModelRouter,
} from '@assistant/core';
import { BudgetReservationError } from '@assistant/core/cost';
import { resolveApproval } from '@assistant/core/workflow/approvals';
import {
  agents,
  approvals,
  conversations,
  costEvents,
  type Db,
  messages,
  modelCalls,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ToolDispatcher } from '../dispatcher.js';
import { ToolRegistry } from '../registry.js';
import type { ToolFlags } from '../types.js';
import type { QuestionCase } from './corpus.js';

export function assertReplayDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/[a-zA-Z_][a-zA-Z0-9_]*_test$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Question replay requires a loopback PostgreSQL _test database without connection overrides.',
    );
  }
  return url.toString();
}

export interface QuestionResult {
  id: string;
  records: number[];
  mode: 'scripted' | 'live';
  status: string;
  answer: string;
  parts: unknown[];
  toolCalls: Array<{ name: string; status: string; args: unknown; result: unknown }>;
  approvals: number;
  saved: Array<{ subject: string; content: string }>;
  elapsedMs: number;
  costUsd: number;
  modelCalls: Array<{ role: string; model: string; latencyMs: number | null; costUsd: string }>;
  verification: unknown[];
  statusSequence?: string[];
  executions?: Array<{ name: string; args: Record<string, unknown> }>;
  modelContexts?: string[];
  failures: string[];
}

/**
 * The defect kinds that make a *delivered answer* wrong to ship. Emptiness and
 * provider truncation are graded separately above, and emoji is suppressed
 * because these fixtures predate that rule — widening the suite's scope is a
 * separate decision from sharing its checks.
 */
const PRESENTATION_DEFECTS = new Set<AuditDefectKind>([
  'unclosed-code-fence',
  'background-notice-echo',
  'forbidden-theme-tag',
  'leaked-markup',
  'fabricated-interface-element',
  'excess-break-tags',
  'excess-chip-rows',
]);

export function evaluateQuestion(
  fixture: QuestionCase,
  result: Omit<QuestionResult, 'failures'>,
): string[] {
  const failures: string[] = [];
  const answer = result.answer;
  if (!answer.trim()) failures.push('answer: empty');
  for (const pattern of fixture.expect.matches)
    if (!new RegExp(pattern, 'is').test(answer)) failures.push(`answer: missing ${pattern}`);
  for (const pattern of fixture.expect.excludes ?? [])
    if (new RegExp(pattern, 'is').test(answer)) failures.push(`answer: forbidden ${pattern}`);
  for (const name of fixture.expect.tools ?? [])
    if (!result.toolCalls.some((call) => call.name === name && call.status === 'succeeded'))
      failures.push(`execution: missing successful ${name}`);
  for (const name of fixture.expect.failedTools ?? [])
    if (!result.toolCalls.some((call) => call.name === name && call.status === 'failed'))
      failures.push(`execution: missing failed ${name}`);
  if (fixture.expect.noTools && result.toolCalls.length)
    failures.push('execution: unexpected tool use');
  const expectedStatuses = fixture.expect.statuses ?? ['done'];
  if (!expectedStatuses.includes(result.status))
    failures.push(`completion: ${result.status}, expected ${expectedStatuses.join('|')}`);
  if (result.approvals > (fixture.expect.maxApprovals ?? 0))
    failures.push(`approvals: ${result.approvals} exceeds allowance`);
  if (
    fixture.expect.approvalCount !== undefined &&
    result.approvals !== fixture.expect.approvalCount
  )
    failures.push(`approvals: ${result.approvals}, expected ${fixture.expect.approvalCount}`);
  if (
    fixture.expect.statusSequence &&
    JSON.stringify(result.statusSequence) !== JSON.stringify(fixture.expect.statusSequence)
  )
    failures.push(
      `lifecycle: ${result.statusSequence?.join(' → ')}, expected ${fixture.expect.statusSequence.join(' → ')}`,
    );
  for (const expected of fixture.expect.calls ?? []) {
    const calls = result.toolCalls.filter(
      (call) => call.name === expected.name && call.status === expected.status,
    );
    if (calls.length !== expected.count)
      failures.push(
        `ledger: ${expected.name} ${expected.status} count ${calls.length}, expected ${expected.count}`,
      );
    if (
      expected.args &&
      !calls.some((call) =>
        Object.entries(expected.args ?? {}).every(
          ([key, value]) =>
            JSON.stringify((call.args as Record<string, unknown> | null)?.[key]) ===
            JSON.stringify(value),
        ),
      )
    )
      failures.push(`ledger: ${expected.name} missing requested arguments`);
  }
  for (const [name, count] of Object.entries(fixture.expect.executionCounts ?? {})) {
    const actual = result.executions?.filter((call) => call.name === name).length ?? 0;
    if (actual !== count) failures.push(`effects: ${name} invoked ${actual}, expected ${count}`);
  }
  for (const pattern of fixture.expect.contextMatches ?? [])
    if (!result.modelContexts?.some((context) => new RegExp(pattern, 'is').test(context)))
      failures.push(`continuity: model context missing ${pattern}`);
  if (
    fixture.expect.modelStepCount !== undefined &&
    result.modelContexts?.length !== fixture.expect.modelStepCount
  )
    failures.push(
      `model: ${result.modelContexts?.length ?? 0} steps, expected ${fixture.expect.modelStepCount}`,
    );
  if (fixture.expect.verification) {
    const check = result.verification.at(-1) as Record<string, unknown> | undefined;
    const expected = fixture.expect.verification;
    for (const [field, value] of Object.entries({
      outputVerificationAttempted: expected.attempted,
      outputVerificationRevised: expected.revised,
      outputVerificationUnavailable: expected.unavailable,
      ...(expected.blocked !== undefined ? { blocked: expected.blocked } : {}),
    }))
      if (check?.[field] !== value) failures.push(`verification: ${field} expected ${value}`);
  }
  if (fixture.expect.savedCount !== undefined && fixture.expect.savedCount !== result.saved.length)
    failures.push(`writes: saved ${result.saved.length}, expected ${fixture.expect.savedCount}`);
  const saved = result.saved.map((row) => `${row.subject}: ${row.content}`).join('\n');
  for (const text of fixture.expect.savedContent ?? [])
    if (!saved.toLowerCase().includes(text.toLowerCase())) failures.push(`writes: missing ${text}`);
  // The shared checks, not a local copy: these same functions now run in
  // `response-contract.ts` before publish, so a case can no longer fail here on
  // a property the runtime does not enforce — which is exactly what the
  // September audit found this suite doing.
  for (const defect of gradeAuditedOutput(answer, { emojiRequested: true }))
    if (PRESENTATION_DEFECTS.has(defect.kind))
      failures.push(`formatting: ${defect.kind} (${defect.detail})`);
  const cards = result.parts.flatMap((part) => {
    if (
      typeof part !== 'object' ||
      part === null ||
      !('type' in part) ||
      part.type !== 'data-card' ||
      !('data' in part)
    )
      return [];
    const data = part.data as {
      kind?: string;
      id?: string;
      revisionId?: string;
      spec?: { facts?: Array<{ value?: string }> };
    } | null;
    return data?.kind === 'generated-card' && data.id && data.revisionId ? [data] : [];
  });
  const hasScoreboard = result.parts.some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      'data' in part &&
      (part.data as { kind?: string } | null)?.kind === 'scoreboard',
  );
  if (fixture.expect.scoreboard && !hasScoreboard)
    failures.push('formatting: missing scoreboard card');
  const hasRoute = result.parts.some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      'data' in part &&
      (part.data as { kind?: string } | null)?.kind === 'route',
  );
  if (fixture.expect.route && !hasRoute) failures.push('formatting: missing route card');
  for (const kind of fixture.expect.responseCardKinds ?? [])
    if (
      !result.parts.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'data-card' &&
          'data' in part &&
          (part.data as { kind?: string } | null)?.kind === kind,
      )
    )
      failures.push(`formatting: missing ${kind} card`);
  for (const kind of fixture.expect.forbiddenResponseCardKinds ?? [])
    if (
      result.parts.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'data-card' &&
          'data' in part &&
          (part.data as { kind?: string } | null)?.kind === kind,
      )
    )
      failures.push(`formatting: unexpected ${kind} card`);
  if (fixture.expect.scoreboardScores) {
    const expected = fixture.expect.scoreboardScores;
    const matches = result.parts.some((part) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('type' in part) ||
        part.type !== 'data-card'
      )
        return false;
      const data = 'data' in part ? (part.data as { kind?: string; games?: unknown } | null) : null;
      if (data?.kind !== 'scoreboard' || !Array.isArray(data.games)) return false;
      return data.games.some(
        (game: { home?: { score?: string }; away?: { score?: string } }) =>
          game?.home?.score === expected.home && game?.away?.score === expected.away,
      );
    });
    if (!matches)
      failures.push(`formatting: scoreboard scores expected ${expected.home}/${expected.away}`);
  }
  if (fixture.expect.routeTimes) {
    const expected = fixture.expect.routeTimes;
    const matches = result.parts.some((part) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('type' in part) ||
        part.type !== 'data-card'
      )
        return false;
      const data =
        'data' in part
          ? (part.data as { kind?: string; departAt?: string; arriveAt?: string } | null)
          : null;
      return (
        data?.kind === 'route' &&
        data.departAt === expected.departAt &&
        data.arriveAt === expected.arriveAt
      );
    });
    if (!matches) failures.push('formatting: route timestamps do not match the requested meeting');
  }
  if (fixture.expect.card && !cards.length)
    failures.push('formatting: missing persisted generated card');
  const cardFacts = cards
    .flatMap((card) => card.spec?.facts?.map((fact) => fact.value ?? '') ?? [])
    .join(' ');
  for (const value of fixture.expect.cardValues ?? [])
    if (!cardFacts.includes(value)) failures.push(`formatting: card missing ${value}`);
  if (result.elapsedMs > 120_000) failures.push('performance: exceeded 120s');
  if (result.costUsd > 1.1) failures.push('performance: exceeded $1.10 per case');
  return failures;
}

/** No production adapters are imported. All tool bodies are local fixtures. */
function replayRegistry(
  fixture: QuestionCase,
  saved: Map<string, { subject: string; content: string }>,
  executions: NonNullable<QuestionResult['executions']>,
): ToolRegistry {
  const registry = new ToolRegistry();
  function add(
    name: string,
    description: string,
    schema: z.ZodType,
    execute: (args: Record<string, unknown>) => unknown,
    flags: ToolFlags = {},
  ) {
    registry.register(
      {
        name,
        description,
        inputSchema: schema,
        risk: 'autonomous',
        acceptsUntrustedInput: !flags.writesMemory,
        execute: async (args) => execute(args as Record<string, unknown>),
      },
      flags,
    );
  }
  if (fixture.source) {
    const source = fixture.source;
    add(
      'web.search',
      'Search the public web for the requested question. Results contain source URLs; fetch a source to verify its facts.',
      z.object({ query: z.string(), count: z.number().optional() }),
      () => ({
        results: [
          { title: 'Source result', url: source.url, description: source.snippet ?? source.text },
        ],
      }),
      { networkEgress: true, returnsUntrustedContent: true },
    );
    add(
      'web.fetch',
      'Read the text of an exact source URL from search results.',
      z.object({ url: z.string().url() }),
      (args) => {
        if (args.url !== source.url)
          throw new Error('Replay has no captured response for this URL');
        if (source.failed) throw new Error('Captured provider failure: HTTP 503');
        return { url: source.url, status: 200, text: source.text };
      },
      { networkEgress: true, returnsUntrustedContent: true },
    );
  }
  if (fixture.sports)
    add(
      'sports.scores',
      'Live scores, results, and fixtures for a team or league.',
      z.object({ team: z.string().optional(), league: z.string().optional() }),
      () => ({
        timeZone: 'America/Los_Angeles',
        date: '2026-09-22',
        fetchedAt: '2026-09-22T02:10:00.000Z',
        selection: 'today',
        games: [
          {
            id: '401873650',
            league: 'mlb',
            leagueLabel: 'MLB',
            state: 'in',
            statusText: 'Top 7th',
            startsAt: '2026-09-22T01:45Z',
            home: {
              id: '26',
              name: 'San Francisco Giants',
              shortName: 'Giants',
              abbreviation: 'SF',
              score: '5',
            },
            away: {
              id: '9',
              name: 'Minnesota Twins',
              shortName: 'Twins',
              abbreviation: 'MIN',
              score: '2',
            },
            line: 'Minnesota Twins at San Francisco Giants: 2-5, Top 7th',
          },
        ],
      }),
      {},
    );
  if (fixture.maps)
    add(
      'maps.directions',
      'Directions, travel time, and distance from Apple Maps.',
      z.object({
        destination: z.string(),
        origin: z.string().optional(),
        arriveBy: z.string().datetime().optional(),
      }),
      (args) => ({
        origin: { label: 'Current Location', lat: 37.7857, lng: -122.4011, current: true },
        destination: {
          label: 'Oracle Park',
          address: '24 Willie Mays Plaza, San Francisco, CA 94107',
          lat: 37.7786,
          lng: -122.3893,
        },
        mode: 'driving',
        durationSeconds: 540,
        distanceMeters: 1850,
        departAt: args.arriveBy
          ? new Date(Date.parse(String(args.arriveBy)) - 540_000).toISOString()
          : '2026-09-22T18:00:00.000Z',
        arriveAt: args.arriveBy ?? '2026-09-22T18:09:00.000Z',
        routeName: 'King St',
        steps: [{ instruction: 'Turn right onto Howard St', distanceMeters: 900 }],
        polyline: '_p~iF~ps|U',
        mapsUrl:
          'https://maps.apple.com/?saddr=37.7857%2C-122.4011&daddr=37.7786%2C-122.3893&dirflg=d',
      }),
      {},
    );
  if (fixture.calendar)
    add(
      'calendar.list_events',
      'List events in a time range across every calendar the assistant can read.',
      z.object({ timeMin: z.string(), timeMax: z.string() }).passthrough(),
      (args) => {
        // Two hours into whatever window was asked for, so "my next meeting"
        // always has one whatever clock the replay pins the task to.
        const start = new Date(Date.parse(String(args.timeMin)) + 2 * 60 * 60 * 1000);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        return {
          complete: true,
          calendarsSearched: ['Fixture calendar'],
          events: [
            {
              summary: 'Design review',
              start: start.toISOString(),
              end: end.toISOString(),
              location: fixture.calendar === 'no-location' ? '' : 'Oracle Park',
            },
          ],
        };
      },
      { confidentialRead: true, returnsUntrustedContent: true },
    );
  if (fixture.weather)
    add(
      'weather.lookup',
      'Get current weather and forecast for the requested place.',
      z.object({
        place: z.string().optional(),
        days: z.number().optional(),
        date: z.string().optional(),
      }),
      () => {
        if (fixture.weather === 'failed') throw new Error('Captured weather failure: HTTP 400');
        return {
          place: 'San Francisco',
          usedCurrentLocation: false,
          current: {
            tempC: 18,
            description: 'Cloudy',
            highC: 20,
            lowC: 14,
            precipProbabilityMax: 10,
            windKmh: 12,
          },
          forecast: [
            {
              date: '2026-09-08',
              weekday: 'Tue',
              description: 'Cloudy',
              lowC: 14,
              highC: 20,
              precipProbabilityMax: 10,
            },
          ],
        };
      },
    );
  if (fixture.mailbox) {
    add(
      'calendar.search_events',
      'Search every connected calendar.',
      z.object({}).passthrough(),
      () => ({ complete: true, calendarsSearched: ['Fixture calendar'], events: [] }),
      { confidentialRead: true, returnsUntrustedContent: true },
    );
    add(
      'gmail.search',
      'Search the connected mailbox for messages matching the query. Read matching threads for details.',
      z.object({ query: z.string() }),
      () => ({
        complete: true,
        mailboxSearched: 'fixture@example.org',
        results:
          fixture.mailbox === 'hotel'
            ? [
                {
                  threadId: 'hotel-1',
                  subject: 'Harbor Hotel booking QA-BOOKING-123',
                  from: 'hotel@example.org',
                },
              ]
            : [],
      }),
      { confidentialRead: true, returnsUntrustedContent: true },
    );
    add(
      'gmail.read_thread',
      'Read all messages in a returned mailbox thread.',
      z.object({ threadId: z.literal('hotel-1') }),
      () => {
        if (fixture.mailbox !== 'hotel')
          throw new Error('No captured thread exists for this mailbox snapshot');
        return {
          messages: [
            {
              subject: 'Harbor Hotel booking QA-BOOKING-123',
              from: 'hotel@example.org',
              text: 'Harbor Hotel, Sunnyvale. Check-in September 5, 2026 at 4:00 PM. Check-out September 6 at 11:00 AM. Total $105.85.',
            },
          ],
        };
      },
      { confidentialRead: true, returnsUntrustedContent: true },
    );
  }
  if (fixture.memory) {
    add(
      'memory.save',
      'Save supplied facts to durable long-term memory. Include literal names, dates, quantities and notes. Does not schedule reminders or create graph links.',
      z.object({
        content: z.string().min(3).max(2000),
        subject: z.string().default(''),
        category: z.enum(['knowledge', 'experience']),
        kind: z.enum(['fact', 'preference', 'person', 'project', 'episode']),
        domain: z.string().optional(),
        importance: z.number().optional(),
        confidence: z.number().optional(),
      }),
      (args) => {
        const entry = { subject: String(args.subject), content: String(args.content) };
        const key = `${entry.subject}\n${entry.content}`;
        saved.set(key, entry);
        return { saved: true, id: randomUUID(), quarantined: false };
      },
      { writesMemory: true },
    );
    add(
      'memory.recall',
      'Read saved long-term memories matching a query.',
      z.object({ query: z.string(), limit: z.number().optional() }),
      () => ({ memories: [...saved.values()] }),
      { confidentialRead: true },
    );
  }
  for (const local of fixture.localTools ?? []) {
    if (!local.outcomes.length) throw new Error(`Replay tool ${local.name} has no outcomes`);
    let index = 0;
    registry.register(
      {
        name: local.name,
        description: `Local scenario fixture for ${local.name}`,
        inputSchema: local.schema,
        risk: local.risk ?? 'autonomous',
        acceptsUntrustedInput: local.acceptsUntrustedInput ?? !local.flags?.writesMemory,
        approvalSummary: (args) => local.summary ?? `${local.name}: ${JSON.stringify(args)}`,
        execute: async (args) => {
          executions.push({ name: local.name, args: args as Record<string, unknown> });
          const outcome = local.outcomes[index++] ?? local.outcomes.at(-1);
          if (!outcome) throw new Error(`Replay tool ${local.name} has no outcome`);
          if ('error' in outcome) throw new Error(outcome.error);
          return outcome.result;
        },
      },
      local.flags ?? {},
    );
  }
  return registry;
}

class ScriptedRouter {
  private index = 0;
  readonly contexts: string[] = [];
  constructor(private fixture: QuestionCase) {}
  async step(_role?: string, options?: { messages?: unknown[] }) {
    this.contexts.push(JSON.stringify(options?.messages ?? []));
    const entry = this.fixture.script[this.index++] ?? this.fixture.script.at(-1) ?? { text: '' };
    if (entry.failure === 'provider') throw new Error('Model provider temporarily unavailable');
    if (entry.failure === 'task-budget')
      throw new BudgetReservationError(
        'task budget exhausted (scenario)',
        new Date(Date.now() + 60_000),
      );
    if (entry.failure === 'daily-budget')
      throw new BudgetReservationError(
        'daily budget exhausted (scenario)',
        new Date(Date.now() + 60_000),
      );
    return {
      ok: true,
      modelId: 'regression/scripted',
      degraded: false,
      text: entry.text ?? '',
      finishReason: 'stop',
      toolCalls: (entry.toolCalls ?? []).map((call, i) => ({
        ...call,
        toolCallId: `replay-${this.index}-${i}`,
      })),
    };
  }
  async object(role: string, options?: { system?: string }) {
    if (role === 'classify' && this.fixture.plan === 'clarify')
      return {
        ok: true,
        modelId: 'regression/scripted',
        degraded: false,
        object: { trivial: false },
      };
    if (role === 'plan' && this.fixture.plan === 'clarify')
      return {
        ok: true,
        modelId: 'regression/scripted',
        degraded: false,
        object: {
          action: 'clarify',
          reasoning: 'Required owner input is not available.',
          steps: [],
          missingInfo: this.fixture.missingInfo ?? [],
        },
      };
    if (role !== 'rewrite') throw new Error(`Unexpected scripted model role: ${role}`);
    const composing = options?.system?.startsWith('You compose a native information card');
    if (!composing && this.fixture.verification && 'unavailable' in this.fixture.verification)
      return { ok: false, decision: { mode: 'park', reason: 'Scenario verifier unavailable' } };
    return {
      ok: true,
      modelId: 'regression/scripted',
      degraded: false,
      finishReason: 'stop',
      object: composing
        ? {
            cardable: !!this.fixture.expect.card,
            card: this.fixture.expect.card
              ? {
                  version: 1,
                  title: 'Harbor Hotel',
                  accessibilityLabel: 'Hotel reservation',
                  sourceLabel: 'gmail.read_thread',
                  facts: [{ id: 'hotel', value: 'Harbor Hotel', source: 'gmail.read_thread' }],
                  blocks: [{ type: 'hero', titleFact: 'hotel' }],
                }
              : undefined,
          }
        : { reasons: [], ...(this.fixture.verification ?? { decision: 'publish' }) },
    };
  }
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0));
  }
}

class RollbackResult extends Error {
  constructor(readonly result: QuestionResult) {
    super('Replay completed; discard fixture state');
  }
}

/** Runs the real executor, dispatcher, response contract and verifier in a rolled-back transaction. */
export async function runQuestion(
  db: Db,
  fixture: QuestionCase,
  options: { router?: (db: Db) => ModelRouter; taskLimitUsd?: number } = {},
): Promise<QuestionResult> {
  const host = db.$client.options.host;
  const database = db.$client.options.database;
  if (
    !host.every((value) => ['localhost', '127.0.0.1', '::1'].includes(value)) ||
    !database.endsWith('_test')
  )
    throw new Error('Refusing replay outside a loopback _test database');
  try {
    await db.transaction(async (transaction) => {
      const replayDb = transaction as unknown as Db;
      const agent = await getAgent(replayDb);
      if (fixture.timeZone)
        await replayDb
          .update(agents)
          .set({ timezone: fixture.timeZone })
          .where(eq(agents.id, agent.id));
      const [conversation] = await replayDb
        .insert(conversations)
        .values({
          agentId: agent.id,
          channel: 'chat',
          trust: 'owner',
          title: `Question regression: ${fixture.id}`,
        })
        .returning();
      if (!conversation) throw new Error('Cannot create fixture conversation');
      const at = new Date(
        fixture.at ??
          (fixture.mailbox === 'hotel' ? '2026-09-03T18:00:00Z' : '2026-09-08T05:00:00Z'),
      );
      await replayDb.insert(messages).values(
        [...(fixture.history ?? []), { role: 'user', text: fixture.request }].map((message, i) => ({
          conversationId: conversation.id,
          role: message.role,
          origin: message.role === 'user' ? 'owner' : 'assistant',
          text: message.text,
          parts: [{ type: 'text', text: message.text }],
          createdAt: new Date(at.getTime() - 30_000 + i * 1000),
        })),
      );
      if (fixture.priorEvidence?.length) {
        const { task: prior } = await enqueueTask(replayDb, {
          event: {
            source: 'chat',
            trust: 'owner',
            agentId: agent.id,
            conversationId: conversation.id,
            payload: { text: 'Previous synthetic request' },
          },
          type: 'chat_turn',
        });
        await replayDb
          .update(tasks)
          .set({ status: 'done', createdAt: new Date(at.getTime() - 60_000) })
          .where(eq(tasks.id, prior.id));
        await replayDb.insert(toolCalls).values(
          fixture.priorEvidence.map((row, step) => ({
            taskId: prior.id,
            toolName: row.name,
            args: row.args,
            result: row.result,
            status: 'succeeded',
            risk: 'autonomous',
            step,
            finishedAt: new Date(at.getTime() - 50_000),
          })),
        );
      }
      const { task } = await enqueueTask(replayDb, {
        event: {
          source: 'chat',
          trust: 'owner',
          agentId: agent.id,
          conversationId: conversation.id,
          payload: { text: fixture.request },
        },
        type: 'chat_turn',
        maxSteps: 12,
        ...(fixture.plan === 'clarify'
          ? {}
          : {
              plan: {
                action: fixture.plan ?? 'workflow',
                reasoning:
                  'Answer the owner request using available evidence and perform requested work.',
                steps: [
                  'Resolve the request using available tools and evidence',
                  'Return the verified result and disclose incomplete work',
                ],
                missingInfo: [],
              },
            }),
      });
      await replayDb
        .update(tasks)
        .set({ createdAt: at, budgetUsdLimit: String(options.taskLimitUsd ?? 1) })
        .where(eq(tasks.id, task.id));
      const saved = new Map<string, { subject: string; content: string }>();
      const executions: NonNullable<QuestionResult['executions']> = [];
      const started = performance.now();
      const dispatcher = new ToolDispatcher(replayDb, replayRegistry(fixture, saved, executions));
      const scripted = new ScriptedRouter(fixture);
      const router = options.router?.(replayDb) ?? (scripted as unknown as ModelRouter);
      let executionError: string | undefined;
      const statusSequence: string[] = [];
      try {
        await executeTask({ db: replayDb, dispatcher, router }, task.id);
        const captureStatus = async () => {
          const [current] = await replayDb
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, task.id));
          statusSequence.push(current?.status ?? 'missing');
          return current?.status;
        };
        let status = await captureStatus();
        if (fixture.approvalDecision && status === 'waiting_approval') {
          const pending = await replayDb
            .select()
            .from(approvals)
            .where(eq(approvals.taskId, task.id));
          for (const decision of pending)
            await resolveApproval(replayDb, {
              approvalId: decision.id,
              decision: fixture.approvalDecision,
              via: 'web',
              deferNotification: true,
            });
          await executeTask({ db: replayDb, dispatcher, router }, task.id);
          status = await captureStatus();
        }
        for (
          let retry = 0;
          status === 'sleeping' && retry < (fixture.retryFailures ?? 0);
          retry++
        ) {
          await replayDb
            .update(tasks)
            .set({ runAfter: new Date(0) })
            .where(eq(tasks.id, task.id));
          await executeTask({ db: replayDb, dispatcher, router }, task.id);
          status = await captureStatus();
        }
      } catch (error) {
        executionError = error instanceof Error ? error.name : 'ExecutionError';
      }
      const [finished] = await replayDb.select().from(tasks).where(eq(tasks.id, task.id));
      const delivered = await replayDb
        .select()
        .from(messages)
        .where(eq(messages.taskId, task.id))
        .orderBy(messages.createdAt);
      const calls = await replayDb
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.taskId, task.id))
        .orderBy(toolCalls.createdAt);
      const decisions = await replayDb
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, task.id));
      const modelRows = await replayDb
        .select({
          role: modelCalls.role,
          model: modelCalls.model,
          latencyMs: modelCalls.latencyMs,
          costUsd: modelCalls.costUsd,
        })
        .from(modelCalls)
        .where(eq(modelCalls.taskId, task.id));
      const costs = await replayDb
        .select({ usd: costEvents.usd })
        .from(costEvents)
        .where(eq(costEvents.taskId, task.id));
      const checks = await replayDb
        .select()
        .from(responseChecks)
        .where(eq(responseChecks.taskId, task.id));
      const pending = (
        finished?.state as { pendingFinal?: { text?: string; responseCards?: unknown[] } } | null
      )?.pendingFinal;
      const reply = delivered.filter((message) => message.role === 'assistant').at(-1);
      const result: Omit<QuestionResult, 'failures'> = {
        id: fixture.id,
        records: fixture.records,
        mode: options.router ? 'live' : 'scripted',
        status: finished?.status ?? 'missing',
        answer: reply?.text ?? pending?.text ?? finished?.progress ?? '',
        parts: (reply?.parts as unknown[]) ?? [],
        toolCalls: calls.map((call) => ({
          name: call.toolName,
          status: call.status,
          args: call.args,
          result: call.result,
        })),
        approvals: decisions.length,
        saved: [...saved.values()],
        elapsedMs: performance.now() - started,
        costUsd: costs.reduce((sum, call) => sum + Number(call.usd), 0),
        modelCalls: modelRows,
        verification: checks,
        statusSequence,
        executions,
        modelContexts: options.router ? undefined : scripted.contexts,
      };
      throw new RollbackResult({
        ...result,
        failures: [
          ...evaluateQuestion(fixture, result),
          ...(executionError ? [`execution: ${executionError}`] : []),
        ],
      });
    });
  } catch (error) {
    if (error instanceof RollbackResult) return error.result;
    throw error;
  }
  throw new Error('Replay transaction unexpectedly committed');
}

export function summarizeQuestions(results: QuestionResult[]) {
  const percentile = (values: number[], p: number) =>
    values.length ? ([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0) : 0;
  return {
    cases: results.length,
    passed: results.filter((result) => !result.failures.length).length,
    failed: results.filter((result) => result.failures.length).length,
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    approvals: results.reduce((sum, result) => sum + result.approvals, 0),
    p50Ms: percentile(
      results.map((result) => result.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      results.map((result) => result.elapsedMs),
      0.95,
    ),
    models: [...new Set(results.flatMap((result) => result.modelCalls.map((call) => call.model)))],
  };
}
