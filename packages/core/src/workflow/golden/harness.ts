import { type Db, tasks, toolCalls } from '@assistant/db';
import { eq } from 'drizzle-orm';
import type { ZodType } from 'zod';
import type { InboundEvent, Plan } from '../../events.js';
import type { GenerativeCardSpecV1 } from '../../generative-card.js';
import type { ModelRouter, StepCallOutcome } from '../../model-router/router.js';
import type { DispatcherPort, ExecutorDeps } from '../executor.js';
import { executeTask } from '../executor.js';
import { enqueueTask } from '../machine.js';

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
  /** Resume a budget-parked task once after moving its runAfter into the past. */
  resumeAfterBudget?: boolean;
  /** One entry per model step: tool calls to propose and/or final text. */
  script: Array<{
    text?: string;
    toolCalls?: Array<{ toolName: string; input: Record<string, unknown> }>;
    qualityFailure?: boolean;
    finishReason?: string;
  }>;
  /** Optional self-review result after the final scripted model step. */
  verification?: GoldenVerification;
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
  taskId: string;
}

class ScriptedRouter {
  private index = 0;
  constructor(
    private script: GoldenFixture['script'],
    private verification: GoldenVerification = { decision: 'publish' },
    private card?: GenerativeCardSpecV1,
  ) {}

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

  async object<T>(role: string, options?: { system?: string }): Promise<unknown> {
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
  const router = new ScriptedRouter(
    fixture.script,
    fixture.verification,
    fixture.card,
  ) as unknown as ModelRouter;
  const { task } = await enqueueTask(db, {
    event: { ...fixture.event, agentId } as InboundEvent,
    type: fixture.taskType,
    ...(fixture.plan ? { plan: fixture.plan } : {}),
    ...(fixture.maxSteps ? { maxSteps: fixture.maxSteps } : {}),
  });

  const deps: ExecutorDeps = {
    db,
    router,
    dispatcher: fixtureDispatcher(db, fixture),
  };
  await executeTask(deps, task.id);
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
    taskId: task.id,
  };
}
