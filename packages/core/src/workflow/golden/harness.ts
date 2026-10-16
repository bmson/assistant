import { type Db, messages, tasks, toolCalls } from '@assistant/db';
import { eq } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { type InboundEvent, type Plan, TaskStateSchema } from '../../events.js';
import type { GenerativeCardSpecV1 } from '../../generative-card.js';
import type { ModelRouter, StepCallOutcome } from '../../model-router/router.js';
import type { DispatcherPort, ExecutorDeps } from '../executor.js';
import { executeTask } from '../executor.js';
import { enqueueTask } from '../machine.js';
import { OutputVerificationSchema } from '../output-verification.js';
import type { RequestChecklist } from '../request-checklist-schema.js';

/**
 * A golden task: a scripted conversation with the model plus assertions about
 * what the platform should have done with it.
 *
 * The router is replaced by the fixture's `script` — each executor step
 * consumes the next entry — and tools execute against a fixture-provided
 * implementation table, recording real tool_calls rows so the response
 * contract, evidence queries, and response_checks all run exactly as in
 * production. What stays real is the point: fixtures measure the machinery
 * around the model, so a prompt or contract change that alters behavior fails
 * a fixture instead of a user.
 */
export interface GoldenFixture {
  name: string;
  /** The triggering event; agentId is filled in by the runner. */
  event: Omit<InboundEvent, 'agentId'>;
  taskType: 'adhoc' | 'chat_turn' | 'email_triage';
  /** Pre-set plan so fixtures do not script the planner too (optional). */
  plan?: Plan;
  /** Bound a scenario to prove the owner-visible result when work runs out of steps. */
  maxSteps?: number;
  /** Seed durable executor state for a bounded resume regression. */
  initialPlannerState?: Record<string, unknown>;
  initialStep?: number;
  /** Resume a budget-parked task once after moving its runAfter into the past. */
  resumeAfterBudget?: boolean;
  /** Mutate durable owner context after the first execution parks, before an optional resume. */
  afterFirstExecution?: (input: { db: Db; taskId: string; agentId: string }) => Promise<void>;
  /** Give this synthetic chat the durable pinned owner-message shape of a production admission. */
  pinOwnerRequest?: boolean;
  /** Seed a validated checklist state to exercise composed finalization behavior. */
  initialRequestChecklist?: RequestChecklist;
  /** One entry per model step: tool calls to propose and/or final text. */
  script: Array<{
    text?: string;
    toolCalls?: Array<{ toolName: string; input: Record<string, unknown> }>;
    qualityFailure?: boolean;
    finishReason?: string;
  }>;
  /** Structured results for executor-owned rank/answer stages, in call order. */
  objects?: Array<{ role: string; value: unknown; unavailable?: boolean }>;
  /** Optional self-review result after the final scripted model step. */
  verification?: GoldenVerification;
  /** Structured booking facts returned by the bounded compound-trip extractor. */
  compoundTripExtraction?: unknown;
  /** Optional grounded card composition; persistence still uses the real database. */
  card?: GenerativeCardSpecV1;
  /** Tool implementations available to the scripted model. */
  tools: Record<string, { schema: ZodType; execute: (args: unknown) => Promise<unknown> }>;
  /** Optional deterministic dispatcher outcome, before the fixture tool executes. */
  beforeDispatch?: (
    input: Parameters<DispatcherPort['dispatch']>[0],
  ) =>
    | Awaited<ReturnType<DispatcherPort['dispatch']>>
    | undefined
    | Promise<Awaited<ReturnType<DispatcherPort['dispatch']>> | undefined>;
}

type GoldenVerification =
  | {
      decision: 'publish' | 'revise';
      revisedText?: string;
      reasons?: Array<
        | 'does_not_answer_request'
        | 'unsupported_claim'
        | 'ungrounded_fact'
        | 'missing_uncertainty'
        | 'unsafe_instruction'
        | 'clarity_or_format'
      >;
    }
  /** Simulate an unavailable verifier without making the primary response fail. */
  | { unavailable: true };

export interface GoldenResult {
  /** Canonical tool names in dispatch order, from the durable ledger. */
  toolNames: string[];
  /** The delivered final text (post response-contract). */
  finalText: string;
  /** The durable terminal task status. */
  status: string;
  /** Number of bounded structured booking extractions attempted. */
  extractCalls: number;
  taskId: string;
  objectRoles: string[];
  stepCount: number;
}

class ScriptedRouter {
  private index = 0;
  private extractionCallCount = 0;
  private objectIndex = 0;
  readonly objectRoles: string[] = [];
  constructor(
    private script: GoldenFixture['script'],
    private verification: GoldenVerification = { decision: 'publish' },
    private card?: GenerativeCardSpecV1,
    private compoundTripExtraction?: unknown,
    private objects: NonNullable<GoldenFixture['objects']> = [],
  ) {}

  get extractCalls(): number {
    return this.extractionCallCount;
  }

  async step(): Promise<StepCallOutcome> {
    const entry = this.script[this.index] ?? { text: 'Done.' };
    this.index += 1;
    return {
      ok: true,
      modelId: 'golden/scripted',
      degraded: false,
      text: entry.text ?? '',
      toolCalls: (entry.toolCalls ?? []).map((call, i) => ({
        toolCallId: `golden-${this.index}-${i}`,
        toolName: call.toolName,
        input: call.input,
      })),
      finishReason: entry.finishReason ?? 'stop',
      ...(entry.qualityFailure ? { qualityFailure: true as const } : {}),
    };
  }

  async object<T>(role: string, options?: { system?: string; schema?: unknown }): Promise<unknown> {
    if (role === 'extract') this.extractionCallCount += 1;
    if (role === 'extract' && this.compoundTripExtraction !== undefined) {
      return {
        ok: true,
        modelId: 'golden/trip-extractor',
        degraded: false,
        object: this.compoundTripExtraction as T,
        finishReason: 'stop',
      };
    }
    this.objectRoles.push(role);
    if (role === 'reason' && options?.schema === OutputVerificationSchema) {
      if ('unavailable' in this.verification) {
        return {
          ok: false,
          decision: { mode: 'park', reason: 'golden verifier unavailable' },
        };
      }
      return {
        ok: true,
        modelId: 'golden/reason',
        degraded: false,
        object: { reasons: [], ...this.verification } as T,
        finishReason: 'stop',
      };
    }
    const scripted = this.objects[this.objectIndex];
    if (scripted?.role === role) {
      this.objectIndex += 1;
      return scripted.unavailable
        ? { ok: false, decision: { mode: 'park', reason: 'golden structured result unavailable' } }
        : { ok: true, modelId: 'golden/structured', degraded: false, object: scripted.value };
    }
    if (role === 'rewrite') {
      if (options?.system?.startsWith('You compose a native information card')) {
        return {
          ok: true,
          modelId: 'golden/card',
          degraded: false,
          object: { cardable: Boolean(this.card), card: this.card },
          finishReason: 'stop',
        };
      }
      if ('unavailable' in this.verification) {
        return {
          ok: false,
          decision: { mode: 'park', reason: 'golden verifier unavailable' },
        };
      }
      return {
        ok: true,
        modelId: 'golden/rewrite',
        degraded: false,
        object: { reasons: [], ...this.verification } as T,
        finishReason: 'stop',
      };
    }
    throw new Error('golden fixtures pre-set their plan; the planner must not run');
  }

  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  }
}

function fixtureDispatcher(db: Db, fixture: GoldenFixture): DispatcherPort {
  return {
    toolDefs: () =>
      Object.entries(fixture.tools).map(([name, tool]) => ({
        name,
        description: `golden fixture tool ${name}`,
        inputSchema: tool.schema,
      })),
    resultIsUntrusted: () => false,
    dispatch: async (input) => {
      const overridden = await fixture.beforeDispatch?.(input);
      if (overridden) return overridden;
      const tool = fixture.tools[input.toolName];
      if (!tool) throw new Error(`golden fixture has no tool named ${input.toolName}`);
      let result: unknown;
      try {
        result = await tool.execute(input.args);
      } catch (error) {
        // Match ToolDispatcher's definitive execution-failure contract: record
        // the failed call, return its error to the model, and let the executor
        // make its bounded retry / ledger-grounded coverage-gap decision.
        const message = String(error).slice(0, 2_000);
        await db.insert(toolCalls).values({
          taskId: input.task.id,
          toolName: input.toolName,
          args: input.args,
          risk: 'autonomous',
          status: 'failed',
          error: message,
          step: input.step,
          // The executor uses this durable identity to reconcile an emitted
          // call after a crash between dispatch and checkpoint.
          decision: { ...input.provenance, modelToolCallId: input.modelToolCallId },
          finishedAt: new Date(),
        });
        return { kind: 'rejected' as const, reason: `execution failed: ${message.slice(0, 500)}` };
      }
      const [row] = await db
        .insert(toolCalls)
        .values({
          taskId: input.task.id,
          toolName: input.toolName,
          args: input.args,
          risk: 'autonomous',
          status: 'succeeded',
          result: result as Record<string, unknown>,
          step: input.step,
          decision: { ...input.provenance, modelToolCallId: input.modelToolCallId },
          finishedAt: new Date(),
        })
        .returning({ id: toolCalls.id });
      if (!row) throw new Error('golden dispatcher failed to record the call');
      return { kind: 'executed' as const, toolCallId: row.id, result, cached: false };
    },
    executeApproved: async () => {
      throw new Error('golden fixtures do not exercise approvals');
    },
  };
}

/** Run one fixture through the real executor and return what it verifiably did. */
export async function runGoldenTask(
  db: Db,
  agentId: string,
  fixture: GoldenFixture,
): Promise<GoldenResult> {
  const scriptedRouter = new ScriptedRouter(
    fixture.script,
    fixture.verification,
    fixture.card,
    fixture.compoundTripExtraction,
    fixture.objects,
  );
  const router = scriptedRouter as unknown as ModelRouter;
  const { task } = await enqueueTask(db, {
    event: { ...fixture.event, agentId } as InboundEvent,
    type: fixture.taskType,
    ...(fixture.plan ? { plan: fixture.plan } : {}),
    ...(fixture.maxSteps ? { maxSteps: fixture.maxSteps } : {}),
  });
  if (
    fixture.initialRequestChecklist ||
    fixture.initialPlannerState ||
    fixture.initialStep !== undefined
  ) {
    const state = TaskStateSchema.parse(task.state);
    if (fixture.initialRequestChecklist) state.requestChecklist = fixture.initialRequestChecklist;
    if (fixture.initialPlannerState)
      state.plannerState = { ...state.plannerState, ...fixture.initialPlannerState };
    if (fixture.initialStep !== undefined) state.step = fixture.initialStep;
    await db.update(tasks).set({ state }).where(eq(tasks.id, task.id));
  }
  if (fixture.pinOwnerRequest && task.conversationId) {
    const payload = (fixture.event as { payload?: Record<string, unknown> }).payload ?? {};
    const text = payload.text;
    if (typeof text !== 'string' || !text)
      throw new Error('pinned golden owner requests require nonempty event text');
    const [ownerMessage] = await db
      .insert(messages)
      .values({
        conversationId: task.conversationId,
        taskId: task.id,
        role: 'user',
        origin: 'owner',
        text,
        parts: [{ type: 'text', text }],
      })
      .returning({ id: messages.id });
    if (!ownerMessage) throw new Error('golden fixture failed to pin owner request');
    const currentEvent = { ...fixture.event, agentId } as Record<string, unknown>;
    await db
      .update(tasks)
      .set({
        trigger: {
          ...currentEvent,
          payload: { ...payload, triggerMessageId: ownerMessage.id },
        },
      })
      .where(eq(tasks.id, task.id));
  }

  const deps: ExecutorDeps = {
    db,
    router,
    dispatcher: fixtureDispatcher(db, fixture),
  };
  await executeTask(deps, task.id);
  await fixture.afterFirstExecution?.({ db, taskId: task.id, agentId });
  if (fixture.resumeAfterBudget) {
    await db
      .update(tasks)
      .set({ runAfter: new Date(0) })
      .where(eq(tasks.id, task.id));
    await executeTask(deps, task.id);
  }

  const rows = await db
    .select({ toolName: toolCalls.toolName, step: toolCalls.step })
    .from(toolCalls)
    .where(eq(toolCalls.taskId, task.id))
    .orderBy(toolCalls.step);
  const [finished] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  const pendingFinal = (finished?.state as { pendingFinal?: { text?: string } } | null)
    ?.pendingFinal;
  return {
    toolNames: rows.map((row) => row.toolName),
    finalText: pendingFinal?.text ?? finished?.progress ?? '',
    status: finished?.status ?? 'missing',
    extractCalls: scriptedRouter.extractCalls,
    taskId: task.id,
    objectRoles: scriptedRouter.objectRoles,
    stepCount: Number((finished?.state as { step?: unknown } | null)?.step ?? 0),
  };
}
