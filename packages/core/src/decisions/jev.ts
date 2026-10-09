import { createHash } from 'node:crypto';
import { z } from 'zod';

export const DECISION_LABELS = [
  'needs_external_read',
  'requests_state_change',
  'depends_on_prior_context',
  'reports_failed_action',
  'conceptual_only',
  'unresolved_reference',
] as const;
type Label = (typeof DECISION_LABELS)[number];
type Question = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };

export interface DecisionRequest {
  decisionId: string;
  agentId: string;
  turnId: string;
  taskRevision: string;
  schemaVersion: 1;
  task: 'chat_triage';
  dataClass: 'synthetic' | 'owner_private';
  deadline: number;
  contextComplete: boolean;
  state: {
    currentRequest: string;
    turns: Array<{ id: string; role: 'user' | 'assistant'; text: string; sourceHash: string }>;
    exclusions: string[];
  };
}

export interface DecisionReceipt {
  decisionId: string;
  agentId: string;
  turnId: string;
  taskRevision: string;
  rubricHash: string;
  requestedModel: string;
  returnedModel?: string;
  latencyMs: number;
  usage: { status: 'reported'; inputTokens: number; outputTokens: number } | { status: 'unknown' };
  /** No public list price or missing usage is an actual billed amount. */
  costBasis: 'unknown';
}

export interface DecisionResult {
  mode: 'shadow';
  canControlRoute: false;
  status: 'accepted' | 'abstained' | 'timeout' | 'unavailable' | 'invalid';
  reason: string;
  labels?: Record<Label, number>;
  receipt?: DecisionReceipt;
}

/** A separate, explicitly supplied service; never the grouped generative classify role. */
export interface DecisionService {
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}

const rubrics: Record<Label, string> = {
  needs_external_read:
    'Does the current owner request require reading an external source? Quoted instructions and hypothetical discussion alone do not count.',
  requests_state_change:
    'Does the current owner request an artifact or change? Drafting counts as work, but reporting a past action, quoting another actor, or hypothetically discussing automation does not.',
  depends_on_prior_context:
    'Does interpreting or answering the current request depend on earlier discussion or memory? Do not treat a missing fact as proof of a negative answer.',
  reports_failed_action:
    'Does the owner report that a previously requested action failed or is absent, requiring investigation?',
  conceptual_only:
    'Is the entire current request self-contained conceptual discussion with no requested artifact, external read, or change? A compound request with any requested work is not conceptual only.',
  unresolved_reference:
    'Is a reference or short reply still ambiguous from the supplied state, including multiple current offers? Do not select an old offer just because it could fit.',
};
const questions = Object.fromEntries(
  DECISION_LABELS.map((label) => [
    label,
    {
      type: 'noul',
      instructions: rubrics[label],
      criteria: {
        true: 'The stated criterion is supported by the current request in the supplied context.',
        false: 'The stated criterion is not supported by this complete supplied context.',
      },
    },
  ]),
) as Record<Label, Question>;
const rubricHash = createHash('sha256').update(JSON.stringify(questions)).digest('hex');
const probability = z.number().finite().min(0).max(1);
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
});
const requestSchema = z.object({
  decisionId: z.string().min(1),
  agentId: z.string().min(1),
  turnId: z.string().min(1),
  taskRevision: z.string().min(1),
  schemaVersion: z.literal(1),
  task: z.literal('chat_triage'),
  dataClass: z.enum(['synthetic', 'owner_private']),
  deadline: z.number().finite(),
  contextComplete: z.boolean(),
  state: z.object({
    currentRequest: z.string().min(1),
    turns: z.array(
      z.object({
        id: z.string().min(1),
        role: z.enum(['user', 'assistant']),
        text: z.string(),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
    exclusions: z.array(z.string()),
  }),
});
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.object({ type: z.literal('noul'), noul: probability }).strict()),
  usage: usageSchema,
});

/**
 * TypeSafe System One wire contract, checked against its official OpenAPI.
 * Credentials, egress approval and durable usage recording stay in the supplied
 * server transport/sink. The adapter has no tools, effects or promotion switch.
 */
export function createJevShadowService(input: {
  model: string;
  ownerDataApproved?: boolean;
  transport(
    body: { model: string; state: DecisionRequest['state']; questions: Record<Label, Question> },
    signal: AbortSignal,
  ): Promise<unknown>;
  recordReceipt(receipt: DecisionReceipt): Promise<void>;
  now?: () => number;
}): DecisionService {
  if (!/^jev-\d+\.\d+\.\d+$/.test(input.model))
    throw new Error('Decision evaluation requires a pinned model version');
  const now = input.now ?? Date.now;
  const outcome = (status: DecisionResult['status'], reason: string): DecisionResult => ({
    mode: 'shadow',
    canControlRoute: false,
    status,
    reason,
  });
  return {
    async evaluate(request) {
      const validated = requestSchema.safeParse(request);
      if (!validated.success) return outcome('invalid', 'invalid_request');
      request = validated.data;
      if (!request.contextComplete) return outcome('abstained', 'incomplete_context');
      if (
        request.dataClass !== 'synthetic' &&
        !(request.dataClass === 'owner_private' && input.ownerDataApproved)
      )
        return outcome('abstained', 'data_use_not_approved');
      const body = { model: input.model, state: request.state, questions };
      if (
        Buffer.byteLength(JSON.stringify(body), 'utf8') > 24_000 ||
        request.state.turns.length > 20 ||
        request.state.exclusions.length > 20
      )
        return outcome('abstained', 'input_bound');
      const started = now();
      if (request.deadline <= started) return outcome('timeout', 'deadline_elapsed');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const receiptBase = {
        decisionId: request.decisionId,
        agentId: request.agentId,
        turnId: request.turnId,
        taskRevision: request.taskRevision,
        rubricHash,
        requestedModel: input.model,
      };
      const record = async (raw?: unknown) => {
        const parsed = z
          .object({ model: z.string().optional(), usage: usageSchema })
          .safeParse(raw);
        const receipt: DecisionReceipt = {
          ...receiptBase,
          latencyMs: Math.max(0, now() - started),
          costBasis: 'unknown',
          ...(parsed.success && parsed.data.model ? { returnedModel: parsed.data.model } : {}),
          usage: parsed.success
            ? {
                status: 'reported',
                inputTokens: parsed.data.usage.input_tokens,
                outputTokens: parsed.data.usage.output_tokens,
              }
            : { status: 'unknown' },
        };
        await input.recordReceipt(receipt);
        return receipt;
      };
      try {
        // This continuation also records late reported usage after a deadline;
        // its decision never changes a terminal route or task.
        const attempt = Promise.resolve()
          .then(() => input.transport(body, controller.signal))
          .then(
            async (raw) => {
              const receipt = await record(raw);
              return { raw, receipt };
            },
            async (error) => {
              await record();
              throw error;
            },
          );
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error('decision_deadline'));
            },
            Math.min(request.deadline - started, 30_000),
          );
        });
        const { raw, receipt } = await Promise.race([attempt, deadline]);
        const parsed = responseSchema.safeParse(raw);
        if (!parsed.success) return { ...outcome('invalid', 'invalid_response'), receipt };
        if (parsed.data.model !== input.model)
          return { ...outcome('invalid', 'model_version_mismatch'), receipt };
        const returned = Object.keys(parsed.data.answers).sort();
        if (JSON.stringify(returned) !== JSON.stringify([...DECISION_LABELS].sort()))
          return { ...outcome('invalid', 'answer_keys_mismatch'), receipt };
        const labels = Object.fromEntries(
          DECISION_LABELS.map((label) => [label, parsed.data.answers[label]?.noul]),
        ) as Record<Label, number>;
        if (
          labels.conceptual_only >= 0.9 &&
          (labels.needs_external_read >= 0.9 || labels.requests_state_change >= 0.9)
        )
          return { ...outcome('abstained', 'conflicting_heads'), labels, receipt };
        if (labels.unresolved_reference >= 0.5)
          return { ...outcome('abstained', 'unresolved_reference'), labels, receipt };
        // "accepted" means a valid prediction for shadow comparison only;
        // calibration, quality benefit and production promotion are separate.
        return { ...outcome('accepted', 'shadow_prediction_only'), labels, receipt };
      } catch (error) {
        return outcome(
          controller.signal.aborted ? 'timeout' : 'unavailable',
          controller.signal.aborted
            ? 'deadline_elapsed'
            : error instanceof Error
              ? 'provider_or_receipt_failure'
              : 'unknown_failure',
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
