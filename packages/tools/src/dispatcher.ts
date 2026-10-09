import { createHash } from 'node:crypto';
import { outboundEmailAllowed } from '@assistant/config';
import {
  activeAutonomyGrant,
  autonomyFloorBlocks,
  BrowserPlanSchema,
  isGoalWorkEvidence,
  isJobPending,
  isReadOnlyPlan,
  type OwnerIntentScope,
  withSpan,
} from '@assistant/core';
import { createApproval } from '@assistant/core/workflow/approvals';
import { detectLiveLookups } from '@assistant/core/workflow/live-lookup';
import {
  createPostgresApprovalPolicyRepository,
  createPostgresApprovalRepository,
  createPostgresCostRepository,
  createPostgresToolExecutionRepository,
  type Db,
  type TaskRow,
} from '@assistant/db';
import type {
  ApprovalPolicyAuthority,
  ApprovalPolicyRepository,
  ApprovalRepository,
  CostRepository,
  ExpectedMcpApprovalBinding,
  Records,
  ToolExecutionRepository,
} from '@assistant/persistence';
import { approvalPolicyFingerprint } from '@assistant/persistence';
import { approvalFallbackSummary } from './approval-summaries.js';
import { isAmbiguousGoogleMutationError } from './google/client.js';
import { PartialGoogleArtifactError } from './google/effect-progress.js';
import { isAmbiguousMcpMutationError } from './mcp-transport.js';
import { matchPolicies, matchPolicyRows } from './policies.js';
import type { ToolRegistry } from './registry.js';
import { isAmbiguousTwilioDeliveryError } from './twilio/client.js';
import {
  ownerVisibleOnlyFor,
  type RegisteredTool,
  type RiskTier,
  type ToolContext,
} from './types.js';

export interface DispatchInput {
  task: TaskRow;
  step: number;
  /** AI SDK tool-call id, persisted so async tools can rebuild the transcript after a crash. */
  modelToolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  ctx: ToolContext;
  /** Provenance for tool_calls.decision. */
  provenance: { plannerVersion: number; promptVersion: number; model: string };
}

const MISSION_ROOT_TOOLS = new Set([
  'mission.create',
  'mission.start',
  'task.schedule',
  'goals.create',
]);

const OWNER_READ_PROHIBITION_SOURCES: Readonly<Record<string, readonly string[]>> = {
  gmail: [
    'gmail',
    'email',
    'emails',
    'e-mail',
    'e-mails',
    'mail',
    'mails',
    'mailbox',
    'mailboxes',
    'inbox',
    'inboxes',
  ],
  email: [
    'gmail',
    'email',
    'emails',
    'e-mail',
    'e-mails',
    'mail',
    'mails',
    'mailbox',
    'mailboxes',
    'inbox',
    'inboxes',
  ],
  mail: [
    'gmail',
    'email',
    'emails',
    'e-mail',
    'e-mails',
    'mail',
    'mails',
    'mailbox',
    'mailboxes',
    'inbox',
    'inboxes',
  ],
  calendar: ['calendar', 'calendars', 'schedule', 'schedules'],
  docs: ['google doc', 'google docs', 'doc', 'docs', 'document', 'documents'],
  drive: ['google drive', 'drive'],
  sheets: ['google sheet', 'google sheets', 'sheet', 'sheets', 'spreadsheet', 'spreadsheets'],
  maps: ['maps', 'map', 'directions', 'location', 'locations'],
  contacts: ['contacts', 'contact', 'address book'],
};

const EXPLICIT_READ_PROHIBITION =
  /\b(?:do\s+not|don['’]t|never|without)\s+(?:(?:want\s+you\s+to|you\s+to)\s+)?(?:read(?:ing)?|search(?:ing)?|access(?:ing)?|check(?:ing)?|open(?:ing)?|review(?:ing)?|fetch(?:ing)?|scan(?:ning)?|look(?:\s+(?:at|through|up))?)(?:\s+through)?[\s:]+([^.!?;\n]{0,120})/giu;

function ownerExplicitlyProhibitsPrivateRead(
  toolName: string,
  ctx: ToolContext,
  flags: RegisteredTool['flags'],
  args?: unknown,
): boolean {
  if (ctx.trust !== 'owner' || flags.confidentialRead !== true) return false;
  const intent = ctx.ownerIntent;
  if (
    !intent ||
    (intent.sourceActor !== 'owner' && intent.sourceActor !== 'mixed') ||
    !intent.ownerAuthoredText.trim()
  ) {
    return false;
  }

  const toolFamily = toolName.split('.', 1)[0]?.toLowerCase();
  const aliases = OWNER_READ_PROHIBITION_SOURCES[toolFamily ?? ''];
  if (!aliases) return false;
  const sourcePattern = new RegExp(
    `\\b(?:${aliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'iu',
  );
  const authoredText = intent.ownerAuthoredText;
  if (toolFamily === 'docs') {
    const requestedDocumentId =
      args &&
      typeof args === 'object' &&
      'documentId' in args &&
      typeof (args as { documentId?: unknown }).documentId === 'string'
        ? (args as { documentId: string }).documentId
        : undefined;
    const deniedDocumentIds = new Set<string>();
    let sourceWideDocsProhibition = false;
    const documentUrl =
      /https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{10,200})(?:[/?#][^\s]*)?/gi;
    for (const match of authoredText.matchAll(
      new RegExp(EXPLICIT_READ_PROHIBITION.source, 'giu'),
    )) {
      const matchStart = match.index ?? 0;
      const clauseText = authoredText.slice(matchStart).split(/[;\n]|[.!?](?=\s)/, 1)[0] ?? '';
      const prohibitedClause =
        clauseText
          .split(
            /\b(?:but|however|instead|just|then)\b|\band\s+(?:(?:do|please)\s+)?(?:read|search|access|check|open|review|fetch|scan|look)\b/i,
            1,
          )[0]
          ?.trim() ?? '';
      const targetUrl = new RegExp(documentUrl.source, 'i').exec(prohibitedClause);
      const directObject = targetUrl
        ? prohibitedClause.slice(0, targetUrl.index)
        : (match[1] ?? '');
      const directUrlRemainder = directObject.replace(
        /^\s*(?:do\s+not|don['’]t|never|without)\s+(?:(?:want\s+you\s+to|you\s+to)\s+)?(?:read(?:ing)?|search(?:ing)?|access(?:ing)?|check(?:ing)?|open(?:ing)?|review(?:ing)?|fetch(?:ing)?|scan(?:ning)?|look(?:\s+(?:at|through|up))?)(?:\s+through)?(?:\s*[:,-]\s*|\s+)/i,
        '',
      );
      const directUrlNamesDocs =
        !!targetUrl &&
        /^(?:(?:either|both|these|those|any(?:\s+of\s+(?:these|those))?|the\s+following)\s*)?(?:(?:this|that|the)\s+)?(?:google\s+)?(?:docs?|documents?|urls?)?$/i.test(
          directUrlRemainder.trim(),
        );
      const sourcePhrase = directObject.replace(/^(?:(?:in|from|through|at|on)\s+)+/i, '');
      const prohibitedTargets = sourcePhrase
        .split(/\b(?:about|regarding|for|with|of|on|in|at|from|containing|named|called)\b/i, 1)[0]
        ?.trim();
      if (!prohibitedTargets || (!sourcePattern.test(prohibitedTargets) && !directUrlNamesDocs))
        continue;
      if (!targetUrl) {
        sourceWideDocsProhibition = true;
        continue;
      }
      const targetIds = [...prohibitedClause.matchAll(new RegExp(documentUrl.source, 'gi'))]
        .map((urlMatch) => urlMatch[1])
        .filter((id): id is string => typeof id === 'string');
      if (targetIds.length === 0) sourceWideDocsProhibition = true;
      else for (const id of targetIds) deniedDocumentIds.add(id);
    }
    if (sourceWideDocsProhibition) return true;
    if (deniedDocumentIds.size === 0) return false;
    if (!requestedDocumentId || deniedDocumentIds.has(requestedDocumentId)) return true;

    // A different Docs target is exempt only when the owner directly names
    // that exact URL in an affirmative read clause. Unqualified and unknown
    // targets remain denied; this does not authorize a scope or bypass policy.
    const affirmativeDocumentIds = new Set<string>();
    for (const clause of authoredText.split(
      /[;\n]|[.!?](?=\s)|\b(?:but|however|instead|just|then)\b|\band\s+(?=(?:(?:do|please)\s+)?(?:read|open|access|fetch|review)\b)/i,
    )) {
      for (const urlMatch of clause.matchAll(new RegExp(documentUrl.source, 'gi'))) {
        const id = urlMatch[1];
        const urlIndex = urlMatch.index ?? 0;
        const prefix = clause.slice(0, urlIndex);
        const directReadRequest =
          /^(?:(?:and|but|however|instead|just|then)\s+)*(?:(?:(?:can|could|would)\s+you|i\s+(?:want|would like|['’]d like)\s+you\s+to)\s+(?:please\s+)?)?(?:please\s+)?(?:read|open|access|fetch|review)\b(?:\s+(?:(?:this|that|the|a|an|my|our)\s+)?(?:(?:(?:shared|linked|attached|existing|current)\s+)?(?:google\s+)?(?:docs?|documents?)|urls?|links?)(?:\s+(?:url|link))?(?:\s+(?:at|on))?)?\s*:?$/i.test(
            prefix.trim(),
          );
        if (id && directReadRequest) affirmativeDocumentIds.add(id);
      }
    }
    return !affirmativeDocumentIds.has(requestedDocumentId);
  }

  for (const match of authoredText.matchAll(EXPLICIT_READ_PROHIBITION)) {
    // A contrast clause can name another source the owner still permits, as in
    // “Don't read Gmail, but check my calendar.” Keep the deny scoped to the
    // source named before that change of instruction.
    const prohibitedClause =
      (match[1] ?? '')
        .split(
          /\b(?:but|however|instead|just|then)\b|\band\s+(?:(?:do|please)\s+)?(?:read|search|access|check|open|review|fetch|scan|look)\b/i,
          1,
        )[0]
        ?.trim() ?? '';
    // Bind the deny to the direct object list. A source mentioned later as
    // context ("the email about the calendar invite") is not itself denied;
    // coordinated direct objects ("Gmail or calendar") remain a source list.
    const sourcePhrase = prohibitedClause.replace(/^(?:(?:in|from|through|at|on)\s+)+/i, '');
    const prohibitedTargets = sourcePhrase
      .split(/\b(?:about|regarding|for|with|of|on|in|at|from|containing|named|called)\b/i, 1)[0]
      ?.trim();
    if (prohibitedTargets && sourcePattern.test(prohibitedTargets)) return true;
  }
  return false;
}

function readProhibitionReason(toolName: string): string {
  return `owner explicitly prohibited reading data from ${toolName.split('.', 1)[0]}`;
}

function requiredOwnerIntentScopes(
  toolName: string,
  flags: RegisteredTool['flags'],
  acceptsUntrustedInput: boolean,
  args: unknown,
): OwnerIntentScope[] {
  if (ownerVisibleOnlyFor(flags, args)) return [];
  // A public, anonymous read-only browser plan is a network read. It still
  // retains the ordinary taint-to-exact-plan approval below, but its scope
  // comes from the owner's request to browse rather than implying a separate
  // send or workspace-write request from static capabilities shared with
  // interactive/profile browser plans.
  if (toolName === 'browser.execute' && isAnonymousReadOnlyBrowserPlan(args)) {
    return ['external_read'];
  }
  const required = new Set<OwnerIntentScope>();
  if (flags.outwardFacing === true) required.add('external_send');
  if (flags.networkEgress === true) {
    required.add(flags.outwardFacing === true ? 'external_send' : 'external_read');
  }
  if (flags.confidentialRead === true) required.add('private_read');
  if (flags.writesWorkspace === true) required.add('workspace_write');
  if (flags.writesMemory === true) required.add('memory_write');
  if (flags.privateWrite === true) {
    if (toolName === 'watch.create' || toolName === 'watch.web') {
      required.add('watch_create');
    } else if (
      /^(?:calendar|reminder|reminders|watches|goals|tasks)\./.test(toolName) ||
      toolName === 'watch.cancel' ||
      toolName === 'applications.watch_confirmation' ||
      toolName === 'applications.cancel_confirmation'
    ) {
      required.add('personal_write');
    } else if (/^(?:docs|sheets|slides|drive)\./.test(toolName)) {
      required.add('workspace_write');
    } else if (/^(?:gmail|mail)\./.test(toolName)) {
      required.add('private_write');
    } else {
      required.add('private_write');
    }
  }
  if (
    toolName === 'applications.watch_confirmation' &&
    args &&
    typeof args === 'object' &&
    ('trackerUpdate' in args || 'documentUpdate' in args)
  ) {
    required.add('workspace_write');
  }
  if (toolName === 'improvement.report') required.add('feedback_write');
  if (toolName === 'task.schedule') required.add('personal_write');
  if (toolName === 'goals.create') required.add('memory_write');
  // Unknown sensitive tools do not inherit an owner-intent category merely
  // because their schema permits tainted arguments; callers must declare an
  // effect capability. This conservative fallback handles the legacy
  // untrusted-input rejection flag without expanding the tool registry.
  if (acceptsUntrustedInput === false && required.size === 0) {
    required.add('private_write');
  }
  return [...required];
}

function isAnonymousReadOnlyBrowserPlan(args: unknown): boolean {
  if (!args || typeof args !== 'object' || !('plan' in args)) return false;
  const parsed = BrowserPlanSchema.safeParse(args.plan);
  if (!parsed.success) return false;
  const plan = parsed.data;
  if (
    plan.useProfile ||
    (plan.rung !== 'headless' && plan.rung !== 'visual') ||
    plan.steps.length === 0 ||
    !isReadOnlyPlan(plan)
  ) {
    return false;
  }
  const start = plan.steps[0];
  if (start?.action !== 'goto' || !start.url) return false;
  for (const step of plan.steps) {
    if (step.action !== 'goto') continue;
    if (!step.url) return false;
    try {
      const url = new URL(step.url);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isMissionSession(
  task: Pick<TaskRow, 'type' | 'parentTaskId' | 'trust' | 'trigger'>,
): boolean {
  if (
    task.type !== 'adhoc' ||
    (task.trust !== 'owner' && task.trust !== 'assistant') ||
    !task.parentTaskId
  ) {
    return false;
  }
  const trigger = task.trigger as { source?: unknown; payload?: { missionId?: unknown } } | null;
  return trigger?.source === 'mission_wake' && trigger.payload?.missionId === task.parentTaskId;
}

function missionRootToolRejection(toolName: string): string {
  return `tool ${toolName} cannot create separate work from inside an existing mission session`;
}

/** The read may only reuse an exact URL already disclosed by a search the owner requested. */
async function authorizedPublicSourceRead(
  repository: ToolExecutionRepository,
  input: DispatchInput,
  args: Record<string, unknown>,
): Promise<boolean> {
  const trigger = input.task.trigger as { source?: string; payload?: { text?: string } } | null;
  if (
    input.toolName !== 'web.fetch' ||
    input.task.type !== 'chat_turn' ||
    input.task.trust !== 'owner' ||
    input.ctx.trust !== 'owner' ||
    trigger?.source !== 'chat' ||
    typeof trigger.payload?.text !== 'string' ||
    typeof args.url !== 'string'
  )
    return false;
  let lookups = detectLiveLookups([{ role: 'user', content: trigger.payload.text }]);
  if (lookups.length === 0 && input.task.conversationId) {
    // A terse retry may refer to an earlier owner question. Resolve only
    // persisted owner words from this chat before this task was created.
    const owners = await repository.ownerMessageHistory(
      input.task.agentId,
      input.task.conversationId,
      input.task.createdAt,
    );
    const history = owners.map((text) => ({ role: 'user' as const, content: text }));
    if (history.at(-1)?.content !== trigger.payload.text)
      history.push({ role: 'user', content: trigger.payload.text });
    lookups = detectLiveLookups(history);
  }
  // A sports lookup falls back to search-then-fetch for an uncovered league.
  // Any part of a compound question may be the one that searched.
  if (!lookups.some((lookup) => lookup.kind === 'web' || lookup.kind === 'sports')) return false;
  const searches = await repository.searchResults(input.task.id);
  return searches.some((result) => {
    const value = result as { results?: Array<{ url?: unknown }>; error?: unknown } | null;
    return (
      !value?.error &&
      Array.isArray(value?.results) &&
      value.results.some((row) => row.url === args.url)
    );
  });
}

export type DispatchOutcome =
  | { kind: 'executed'; toolCallId: string; result: unknown; cached: boolean }
  | {
      kind: 'recorded';
      toolCallId: string;
      effectOutcome: 'completed' | 'failed' | 'unknown' | 'not_executed';
      detailsExpired: true;
      requestedArgumentsVerified: false;
    }
  | {
      kind: 'awaiting_approval';
      toolCallId: string;
      approvalId: string;
      shortCode: string;
      summary: string;
    }
  | { kind: 'rejected'; reason: string }
  /** Pre-flight reservation failed — the executor parks the task as waiting_budget. */
  | { kind: 'budget_blocked'; reason: string; resumeAt: Date };

/** Tools whose recipient must be provenance-checked before an autonomous send. */
const RECIPIENT_TOOLS = new Set([
  'gmail.send',
  'gmail.create_draft',
  'calendar.create_event',
  'sms.send',
]);

const normalizeEmail = (value: string): string => value.trim().toLowerCase();
const normalizePhone = (value: string): string => value.replace(/[^\d+]/g, '');

/** The email/phone recipients a send-style tool call would actually reach. */
function recipientsFrom(
  toolName: string,
  args: Record<string, unknown>,
): { emails: string[]; phones: string[] } {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  if (toolName === 'sms.send') {
    return { emails: [], phones: typeof args.to === 'string' ? [args.to] : [] };
  }
  if (toolName === 'calendar.create_event') {
    return { emails: strings(args.attendees), phones: [] };
  }
  return { emails: strings(args.to), phones: [] };
}

type ToolReservation =
  | {
      ok: true;
      reservationId: string;
      estimatedUsd: number;
      quantity: number;
      unit: string;
      unitPriceUsd: number;
      description: string;
      evidence?: import('@assistant/persistence').CostEvidence;
    }
  | { ok: false; reason: string; resumeAt: Date };

function cacheKey(agentId: string, toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${agentId}:${toolName}:${JSON.stringify(args)}`)
    .digest('hex');
}

function reconciledToolCost(
  registered: RegisteredTool,
  args: Record<string, unknown>,
  result: unknown,
  reserved: Extract<ToolReservation, { ok: true }>,
  toolCallId: string,
  descriptionSuffix = '',
) {
  const actual = registered.tool.reconcileCost?.(args, result);
  const quantity = actual?.quantity ?? reserved.quantity;
  const usd =
    actual?.usd ??
    (actual?.quantity !== undefined ? quantity * reserved.unitPriceUsd : reserved.estimatedUsd);
  return {
    evidence: actual?.evidence ?? reserved.evidence,
    usd,
    quantity,
    unit: actual?.unit ?? reserved.unit,
    unitPriceUsd:
      actual?.unitPriceUsd ??
      (actual?.usd !== undefined && quantity > 0 ? actual.usd / quantity : reserved.unitPriceUsd),
    toolCallId,
    description: `${actual?.description ?? reserved.description}${descriptionSuffix}`,
  };
}

function recordedReadArguments(
  call: Records['toolCalls'],
  approval?: Records['approvals'] | null,
): unknown {
  if (!call.approvalId) return call.args;
  if (approval?.id !== call.approvalId || approval.toolCallId !== call.id) return undefined;
  return approval.resolutionPayload ?? call.args;
}

function recoveredOutcome(
  prior: Awaited<ReturnType<NonNullable<ToolExecutionRepository['findByModelToolCallId']>>>,
): DispatchOutcome | null {
  if (!prior) return null;
  const { toolCall, approval } = prior;
  if (toolCall.status === 'succeeded') {
    return {
      kind: 'executed',
      toolCallId: toolCall.id,
      result: toolCall.result,
      cached: false,
    };
  }
  if (toolCall.status === 'awaiting_approval' || toolCall.status === 'approved') {
    if (!approval || approval.toolCallId !== toolCall.id) {
      return { kind: 'rejected', reason: 'approval receipt is missing; execution was not retried' };
    }
    if (approval.status === 'pending' || approval.status === 'approved') {
      return {
        kind: 'awaiting_approval',
        toolCallId: toolCall.id,
        approvalId: approval.id,
        shortCode: approval.shortCode,
        summary: approval.summary,
      };
    }
    return {
      kind: 'rejected',
      reason:
        approval.status === 'expired'
          ? 'approval expired before the executor checkpointed it'
          : 'the owner denied this action',
    };
  }
  if (toolCall.status === 'failed' || toolCall.status === 'denied') {
    return { kind: 'rejected', reason: toolCall.error ?? `tool call is ${toolCall.status}` };
  }
  if (toolCall.status === 'executing') {
    return {
      kind: 'rejected',
      reason: 'the provider outcome is unknown; the call was not retried automatically',
    };
  }
  return {
    kind: 'rejected',
    reason: `tool call is in unexpected state ${toolCall.status}; the call was not retried`,
  };
}

function compactRecordedOutcome(
  receipt: import('@assistant/persistence').Records['toolCallReceipts'],
): Extract<DispatchOutcome, { kind: 'recorded' }> {
  return {
    kind: 'recorded',
    toolCallId: receipt.toolCallId,
    effectOutcome: receipt.effectOutcome,
    detailsExpired: true,
    requestedArgumentsVerified: false,
  };
}

/**
 * The risk gate — the enforcement boundary between model output and the world.
 * Evaluation order is part of the security contract:
 *   1. tool exists & is in this task's trust-scoped registry (forbidden-by-construction)
 *   2. taint check (acceptsUntrustedInput)
 *   3. approval_policies match (deny, then allow)
 *   4. dynamic risk function → default tier
 *   5. rate limits, cache, idempotent execution
 */
export class ToolDispatcher {
  constructor(
    db: Db,
    private registry: ToolRegistry,
    executionRepository?: ToolExecutionRepository,
    costRepository?: CostRepository,
    approvalRepository?: ApprovalRepository,
    policyRepository?: ApprovalPolicyRepository,
  ) {
    this.executionRepository = executionRepository ?? createPostgresToolExecutionRepository(db);
    this.costRepository = costRepository ?? createPostgresCostRepository(db);
    this.approvalRepository = approvalRepository ?? createPostgresApprovalRepository(db);
    this.policyRepository = policyRepository ?? createPostgresApprovalPolicyRepository(db);
  }

  private executionRepository: ToolExecutionRepository;
  private costRepository: CostRepository;
  private approvalRepository: ApprovalRepository;
  private policyRepository: ApprovalPolicyRepository;

  /**
   * Model-facing tool definitions for a task's trust level (no execute
   * functions). Taint deliberately does not narrow this set for a privileged
   * task — it changes the risk tier at dispatch instead. See `toolsForTask`.
   */
  toolDefs(
    trust: ToolContext['trust'],
    scope: { isMissionSession: boolean } = { isMissionSession: false },
  ) {
    return (
      this.registry
        .toolsForTask(trust)
        // mission.update writes the parent mission. A normal chat task has no
        // parent, so exposing it lets the model manufacture a progress update
        // that can only fail after it has already narrated the work.
        .filter((tool) => tool.name !== 'mission.update' || scope.isMissionSession)
        // A mission wake is one bounded increment of an existing root. It may
        // update that parent, but cannot manufacture another mission, goal, or
        // scheduled child as a side effect of the current session.
        .filter((tool) => !scope.isMissionSession || !MISSION_ROOT_TOOLS.has(tool.name))
        // Deterministic internal tools are never model capabilities.
        .filter((tool) => !this.registry.get(tool.name)?.flags.internalEventKind)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))
    );
  }

  /** Used by the workflow to durably propagate tool-result provenance. */
  resultIsUntrusted(toolName: string): boolean {
    return this.registry.resultIsUntrusted(toolName);
  }

  /**
   * Execute a tool call the owner approved (possibly with edited args in the
   * approval's resolution_payload). Idempotent: if a crash-retry finds the
   * call already succeeded, the recorded result is returned.
   */
  async executeApproved(
    toolCallId: string,
    ctx: ToolContext,
    expectedToolName?: string,
  ): Promise<
    | { kind: 'executed'; result: unknown }
    | {
        kind: 'recorded';
        toolCallId: string;
        effectOutcome: 'completed' | 'failed' | 'unknown' | 'not_executed';
        detailsExpired: true;
        requestedArgumentsVerified: false;
      }
    | { kind: 'failed'; error: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  > {
    const compactReceipt = await this.executionRepository.findReceiptByToolCallId?.(
      ctx.agentId,
      ctx.taskId,
      toolCallId,
    );
    if (
      compactReceipt &&
      ownerExplicitlyProhibitsPrivateRead(
        compactReceipt.toolName,
        ctx,
        this.registry.get(compactReceipt.toolName)?.flags ?? {},
      )
    ) {
      return { kind: 'failed', error: readProhibitionReason(compactReceipt.toolName) };
    }
    if (compactReceipt && expectedToolName && compactReceipt.toolName !== expectedToolName)
      return {
        kind: 'failed',
        error:
          'recorded approval belongs to a different tool; refusing to present it as this action',
      };
    if (compactReceipt) return compactRecordedOutcome(compactReceipt);
    const loaded = await this.executionRepository.load(ctx.agentId, ctx.taskId, toolCallId);
    const call = loaded?.toolCall;
    if (!loaded || !call) return { kind: 'failed', error: 'tool call not found' };
    if (expectedToolName && call.toolName !== expectedToolName)
      return {
        kind: 'failed',
        error: 'approval belongs to a different tool; refusing to execute it as this action',
      };
    const replayArgs =
      call.approvalId && loaded.approval?.resolutionPayload
        ? (loaded.approval.resolutionPayload as Record<string, unknown>)
        : call.args;
    if (
      ownerExplicitlyProhibitsPrivateRead(
        call.toolName,
        ctx,
        this.registry.get(call.toolName)?.flags ?? {},
        replayArgs,
      )
    ) {
      if (call.status === 'approved') {
        const persisted = await this.executionRepository.outcome({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          toolCallId,
          status: 'failed',
          fromStatus: 'approved',
          error: readProhibitionReason(call.toolName),
        });
        return {
          kind: 'failed',
          error: persisted
            ? readProhibitionReason(call.toolName)
            : 'approved tool failure could not be persisted',
        };
      }
      return { kind: 'failed', error: readProhibitionReason(call.toolName) };
    }
    if (isJobPending(call.result)) return { kind: 'executed', result: call.result };
    if (call.status === 'succeeded') return { kind: 'executed', result: call.result };
    if (call.status !== 'approved') {
      return { kind: 'failed', error: `tool call is ${call.status}, not approved` };
    }

    const failApproved = async (error: string) => {
      const persisted = await this.executionRepository.outcome({
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        toolCallId,
        status: 'failed',
        fromStatus: 'approved',
        error,
      });
      return {
        kind: 'failed' as const,
        error: persisted ? error : 'approved tool failure could not be persisted',
      };
    };

    if (isMissionSession(loaded.task) && MISSION_ROOT_TOOLS.has(call.toolName)) {
      return failApproved(missionRootToolRejection(call.toolName));
    }

    const registered = this.registry.get(call.toolName);
    if (!registered) {
      return failApproved(`tool ${call.toolName} no longer registered; approval cannot execute`);
    }

    let args = (call.args ?? {}) as Record<string, unknown>;
    if (call.approvalId) {
      if (loaded.approval?.resolutionPayload) {
        args = loaded.approval.resolutionPayload as Record<string, unknown>;
      }
    }

    const parsed = registered.tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      const persisted = await this.executionRepository.outcome({
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        toolCallId,
        status: 'failed',
        fromStatus: 'approved',
        error: `invalid approved args: ${parsed.error.message}`,
      });
      if (!persisted)
        return { kind: 'failed', error: 'approved tool failure could not be persisted' };
      return { kind: 'failed', error: 'approved args failed validation' };
    }

    // The model-facing schema strips internal binding metadata. Restore only
    // the original dispatcher snapshot, never one supplied in edited arguments.
    if (call.toolName === 'mcp.call') {
      const original = call.args as Record<string, unknown> | null;
      if (original?._approvalMcpScope) {
        (parsed.data as Record<string, unknown>)._approvalMcpScope = original._approvalMcpScope;
      }
    }

    const approvedArgs = parsed.data as Record<string, unknown>;
    // Re-run mandatory identity/scope preparation on the approved payload.
    // Legacy calls without a binding fail closed; cosmetic preparation remains
    // deliberately limited to the pre-approval path.
    if (registered.tool.prepareSecurity) {
      try {
        await registered.tool.prepareSecurity(approvedArgs, ctx, 'approved');
      } catch {
        return failApproved('security binding is missing or changed; request fresh approval');
      }
    }

    // Approval is a snapshot of owner intent, not a permanent capability.
    // Re-evaluate current trust, deny rules, hard risk, outbound restrictions,
    // and cancellation immediately before reserving and claiming the effect.
    const taskTrust = loaded.task.trust as ToolContext['trust'];
    if (taskTrust !== ctx.trust) {
      return failApproved('task trust changed; request fresh approval');
    }
    if (
      call.toolName === 'improvement.report' &&
      (taskTrust !== 'owner' || !ctx.ownerIntent?.authorizedScopes.includes('feedback_write'))
    ) {
      return failApproved(
        'a direct owner feedback request is no longer present; request fresh approval',
      );
    }
    if (!this.registry.toolsForTask(taskTrust).some((tool) => tool.name === call.toolName)) {
      return failApproved('tool capability is no longer available for this task');
    }
    if (ctx.signal.aborted || loaded.task.status !== 'running') {
      return failApproved('task was cancelled or is no longer running');
    }
    let expectedPolicyFingerprint: string;
    let expectedMcpBinding: ExpectedMcpApprovalBinding | undefined;
    try {
      const policyRows = await this.policyRepository.list(ctx.agentId, {
        toolName: call.toolName,
      });
      const currentPolicy = matchPolicyRows(policyRows, {
        agentId: ctx.agentId,
        toolName: call.toolName,
        args: approvedArgs,
        ctx,
      });
      expectedPolicyFingerprint = approvalPolicyFingerprint(
        policyRows as ApprovalPolicyAuthority[],
      );
      if (currentPolicy?.effect === 'deny') return failApproved('denied by current policy');
    } catch {
      return failApproved('current policy could not be verified');
    }
    if (call.toolName === 'mcp.call') {
      const scope = (approvedArgs as Record<string, unknown>)._approvalMcpScope as
        | { connectionId?: unknown; fingerprint?: unknown }
        | undefined;
      if (
        !scope ||
        scope.connectionId !== approvedArgs.connectionId ||
        typeof scope.connectionId !== 'string' ||
        typeof scope.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(scope.fingerprint)
      ) {
        return failApproved('security binding is missing or changed; request fresh approval');
      }
      expectedMcpBinding = {
        connectionId: scope.connectionId,
        fingerprint: scope.fingerprint,
      };
    }
    let currentTier: RiskTier;
    try {
      currentTier =
        typeof registered.tool.risk === 'function'
          ? registered.tool.risk(approvedArgs, ctx)
          : registered.tool.risk;
    } catch {
      return failApproved('current tool risk could not be verified');
    }
    if (currentTier === 'forbidden') return failApproved('tool is currently forbidden');
    const blockedRecipients = (
      RECIPIENT_TOOLS.has(call.toolName) ? recipientsFrom(call.toolName, approvedArgs).emails : []
    ).filter((email) => !outboundEmailAllowed(email));
    if (blockedRecipients.length)
      return failApproved('recipient is outside permitted email domains');

    // Approved calls reserve too — approval grants permission, not budget.
    const reserved = await this.reserveForTool(registered, approvedArgs, call.taskId);
    if (reserved && !reserved.ok) {
      return {
        kind: 'budget_blocked',
        reason: reserved.reason,
        resumeAt: reserved.resumeAt,
      };
    }
    const decision = {
      ...((call.decision ?? {}) as Record<string, unknown>),
      ...(reserved?.ok ? { reservationId: reserved.reservationId } : {}),
    };

    let claimed: Awaited<ReturnType<ToolExecutionRepository['claim']>>;
    try {
      claimed = await this.executionRepository.claim({
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        toolCallId,
        args: approvedArgs,
        decision,
        expectedApprovalId: call.approvalId,
        expectedResolutionPayload: loaded.approval?.resolutionPayload ?? null,
        expectedPolicyFingerprint,
        expectedTaskTrust: taskTrust,
        ...(expectedMcpBinding ? { expectedMcpBinding } : {}),
        expectedTaskStatus: 'running',
      });
    } catch {
      // A thrown claim may be a pre-commit failure or a lost commit response.
      // The provider is never entered on this path. Release this invocation's
      // reservation, but leave any uncertain concurrent/committed claim alone.
      if (reserved?.ok) await this.costRepository.release(reserved.reservationId).catch(() => {});
      return {
        kind: 'failed',
        error: 'authorization claim could not be confirmed; provider was not invoked',
      };
    }
    if (claimed && 'type' in claimed && claimed.type === 'stale_authorization') {
      if (reserved?.ok) await this.costRepository.release(reserved.reservationId).catch(() => {});
      return { kind: 'failed', error: claimed.error };
    }
    if (!claimed) {
      if (reserved?.ok) await this.costRepository.release(reserved.reservationId).catch(() => {});
      const current = await this.executionRepository.load(ctx.agentId, ctx.taskId, toolCallId);
      if (current?.toolCall.status === 'succeeded')
        return { kind: 'executed', result: current.toolCall.result };
      if (current?.toolCall.status === 'approved') {
        const error = 'approval authority changed before execution; request fresh approval';
        return {
          kind: 'failed',
          error: `${error}; execution authority could not be reconciled`,
        };
      }
      return {
        kind: 'failed',
        error: `tool call is ${current?.toolCall.status ?? 'missing'}; provider was not invoked`,
      };
    }

    // Cancellation can arrive while preparation or the reservation is in
    // flight. The repository claim fences the task state atomically; this
    // second read also honors an aborted worker signal before provider entry.
    const afterClaim = await this.executionRepository.load(ctx.agentId, ctx.taskId, toolCallId);
    if (ctx.signal.aborted || afterClaim?.task.status !== 'running') {
      const persisted = await this.executionRepository.outcome({
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        toolCallId,
        status: 'failed',
        fromStatus: 'executing',
        error: 'task was cancelled before provider execution',
      });
      if (reserved?.ok) await this.costRepository.release(reserved.reservationId).catch(() => {});
      return {
        kind: 'failed',
        error: persisted ? 'task was cancelled before provider execution' : 'tool claim was lost',
      };
    }

    let providerCompleted = false;
    let completedResult: unknown;
    try {
      const result = await withSpan(
        'tool.execute',
        { tool: call.toolName, taskId: call.taskId, step: call.step, approved: true },
        async () =>
          registered.tool.execute(
            approvedArgs,
            this.executionContext(
              ctx,
              toolCallId,
              call.toolName,
              ((call.decision ?? {}) as { modelToolCallId?: string }).modelToolCallId,
              loaded.task.leaseToken,
            ),
          ),
      );
      completedResult = result;
      providerCompleted = true;
      if (reserved?.ok && !isJobPending(result)) {
        await this.costRepository
          .reconcile(
            reserved.reservationId,
            reconciledToolCost(registered, approvedArgs, result, reserved, toolCallId),
          )
          .catch((error) => console.error('approved tool cost reconciliation failed', error));
      }
      const persisted = await this.executionRepository.outcome({
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        toolCallId,
        status: 'succeeded',
        ...(isJobPending(result) ? {} : { result: result ?? null }),
      });
      if (!persisted)
        return { kind: 'failed', error: 'tool success could not be persisted; retry suppressed' };
      return { kind: 'executed', result };
    } catch (err) {
      if (providerCompleted) {
        if (reserved?.ok)
          await this.costRepository
            .reconcile(
              reserved.reservationId,
              reconciledToolCost(
                registered,
                approvedArgs,
                completedResult,
                reserved,
                toolCallId,
                ' (persistence outcome unknown)',
              ),
            )
            .catch(() => {});
        return {
          kind: 'failed',
          error: 'provider completed but outcome persistence failed; retry suppressed',
        };
      }
      if (
        isAmbiguousTwilioDeliveryError(err) ||
        isAmbiguousGoogleMutationError(err) ||
        isAmbiguousMcpMutationError(err) ||
        err instanceof PartialGoogleArtifactError
      ) {
        const result = {
          deliveryStatus: 'unknown',
          ...(err instanceof PartialGoogleArtifactError
            ? { externalEffect: err.progress, partialCompletion: true }
            : {}),
          retrySuppressed: true,
          note: 'The provider may have accepted this mutation; do not retry automatically.',
          ...(reserved?.ok && reserved.evidence?.sms
            ? { smsAccounting: reserved.evidence.sms }
            : {}),
        };
        if (reserved?.ok) {
          await this.costRepository
            .reconcile(reserved.reservationId, {
              usd: reserved.estimatedUsd,
              quantity: reserved.quantity,
              unit: reserved.unit,
              unitPriceUsd: reserved.unitPriceUsd,
              evidence: reserved.evidence,
              toolCallId,
              description: `${reserved.description} (delivery outcome unknown)`,
            })
            .catch((error) =>
              console.error('ambiguous approved tool cost reconciliation failed', error),
            );
        }
        const persisted = await this.executionRepository.outcome({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          toolCallId,
          status: 'succeeded',
          result,
        });
        if (!persisted)
          return {
            kind: 'failed',
            error: 'ambiguous delivery state could not be persisted; retry suppressed',
          };
        return { kind: 'executed', result };
      }
      if (reserved?.ok) await this.costRepository.release(reserved.reservationId).catch(() => {});
      const persisted = await this.executionRepository.outcome({
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        toolCallId,
        status: 'failed',
        error: String(err).slice(0, 2000),
      });
      if (!persisted)
        return { kind: 'failed', error: 'tool failure could not be persisted; retry suppressed' };
      return { kind: 'failed', error: String(err).slice(0, 500) };
    }
  }

  /**
   * Recipients a send would reach that are neither in the owner/thread-provided
   * set nor a saved contact. An empty result means every recipient is accounted
   * for. Contacts are queried per call (small, single-agent table); this only
   * runs for RECIPIENT_TOOLS on the non-policy-allow path.
   */
  private async unverifiedRecipients(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string[]> {
    const { emails, phones } = recipientsFrom(toolName, args);
    if (emails.length === 0 && phones.length === 0) return [];
    const verifiedEmails = new Set((ctx.knownAddresses?.emails ?? []).map(normalizeEmail));
    const verifiedPhones = new Set((ctx.knownAddresses?.phones ?? []).map(normalizePhone));
    const rows = await this.executionRepository.contacts();
    for (const row of rows) {
      for (const e of row.emails) verifiedEmails.add(normalizeEmail(e));
      for (const p of row.phones) verifiedPhones.add(normalizePhone(p));
    }
    const unverified: string[] = [];
    for (const e of emails) if (!verifiedEmails.has(normalizeEmail(e))) unverified.push(e);
    for (const p of phones) if (!verifiedPhones.has(normalizePhone(p))) unverified.push(p);
    return unverified;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    const registered = this.registry.get(input.toolName);
    const allowedForTrust = this.registry
      .toolsForTask(input.ctx.trust)
      .some((t) => t.name === input.toolName);
    if (!registered || !allowedForTrust) {
      return {
        kind: 'rejected',
        reason: `tool ${input.toolName} is not available for this task`,
      };
    }
    if (isMissionSession(input.task) && MISSION_ROOT_TOOLS.has(input.toolName)) {
      return {
        kind: 'rejected',
        reason: missionRootToolRejection(input.toolName),
      };
    }
    if (
      ownerExplicitlyProhibitsPrivateRead(input.toolName, input.ctx, registered.flags, input.args)
    ) {
      return { kind: 'rejected', reason: readProhibitionReason(input.toolName) };
    }
    if (input.modelToolCallId && this.executionRepository.findByModelToolCallId) {
      const compactReceipt = await this.executionRepository.findReceiptByModelToolCallId?.(
        input.task.agentId,
        input.task.id,
        input.modelToolCallId,
      );
      const prior = await this.executionRepository.findByModelToolCallId(
        input.task.agentId,
        input.task.id,
        input.modelToolCallId,
      );
      if (compactReceipt && prior)
        return {
          kind: 'rejected',
          reason: 'conflicting live and compact tool receipts; refusing to replay the action',
        };
      if (compactReceipt && compactReceipt.toolName !== input.toolName)
        return {
          kind: 'rejected',
          reason: 'recorded tool-call identity belongs to a different tool; refusing to replay it',
        };
      if (prior && prior.toolCall.toolName !== input.toolName)
        return {
          kind: 'rejected',
          reason: 'recorded tool-call identity belongs to a different tool; refusing to replay it',
        };
      if (
        (compactReceipt &&
          ownerExplicitlyProhibitsPrivateRead(input.toolName, input.ctx, registered.flags)) ||
        (prior &&
          ownerExplicitlyProhibitsPrivateRead(
            input.toolName,
            input.ctx,
            registered.flags,
            recordedReadArguments(prior.toolCall, prior.approval),
          ))
      )
        return { kind: 'rejected', reason: readProhibitionReason(input.toolName) };
      if (compactReceipt) return compactRecordedOutcome(compactReceipt);
      if (prior?.toolCall.status === 'executing') {
        const error = 'the provider outcome is unknown; the call was not retried automatically';
        const recorded = await this.executionRepository.outcome({
          agentId: input.task.agentId,
          taskId: input.task.id,
          toolCallId: prior.toolCall.id,
          status: 'failed',
          fromStatus: 'executing',
          error,
        });
        if (recorded) return { kind: 'rejected', reason: error };
        // The first worker may have persisted its terminal receipt while this
        // retry was reconciling. Re-read once and use that durable result.
        const latest = await this.executionRepository.findByModelToolCallId(
          input.task.agentId,
          input.task.id,
          input.modelToolCallId,
        );
        const compactLatest = await this.executionRepository.findReceiptByModelToolCallId?.(
          input.task.agentId,
          input.task.id,
          input.modelToolCallId,
        );
        if (compactLatest && latest)
          return {
            kind: 'rejected',
            reason: 'conflicting live and compact tool receipts; refusing to replay the action',
          };
        if (compactLatest && compactLatest.toolName !== input.toolName)
          return {
            kind: 'rejected',
            reason:
              'recorded tool-call identity belongs to a different tool; refusing to replay it',
          };
        if (latest && latest.toolCall.toolName !== input.toolName)
          return {
            kind: 'rejected',
            reason:
              'recorded tool-call identity belongs to a different tool; refusing to replay it',
          };
        if (
          (compactLatest &&
            ownerExplicitlyProhibitsPrivateRead(input.toolName, input.ctx, registered.flags)) ||
          (latest &&
            ownerExplicitlyProhibitsPrivateRead(
              input.toolName,
              input.ctx,
              registered.flags,
              recordedReadArguments(latest.toolCall, latest.approval),
            ))
        )
          return { kind: 'rejected', reason: readProhibitionReason(input.toolName) };
        if (compactLatest) return compactRecordedOutcome(compactLatest);
        if (latest) {
          const outcome = recoveredOutcome(latest);
          if (outcome) return outcome;
        }
        return { kind: 'rejected', reason: error };
      }
      const outcome = recoveredOutcome(prior);
      if (outcome) return outcome;
    }
    if (registered.flags.internalEventKind) {
      const trigger = input.task.trigger as
        | { source?: unknown; payload?: Record<string, unknown> }
        | undefined;
      if (
        input.ctx.trust !== 'assistant' ||
        trigger?.source !== 'internal' ||
        trigger.payload?.kind !== registered.flags.internalEventKind ||
        (registered.flags.internalEventArgument !== undefined &&
          input.args[registered.flags.internalEventArgument] !==
            trigger.payload?.[registered.flags.internalEventArgument])
      ) {
        return {
          kind: 'rejected',
          reason: `tool ${input.toolName} is restricted to internal ${registered.flags.internalEventKind} events`,
        };
      }
    }
    // Hiding a tool from the model is not an enforcement boundary: models can
    // still emit a guessed tool name. Mission progress may only be written by
    // the bounded child session created from an actual mission.
    if (input.toolName === 'mission.update') {
      if (!input.task.parentTaskId) {
        return {
          kind: 'rejected',
          reason: 'mission.update is available only inside a mission work session',
        };
      }
      if (
        !(await this.executionRepository.parentIsMission(
          input.task.agentId,
          input.task.parentTaskId,
        ))
      ) {
        return {
          kind: 'rejected',
          reason: 'mission.update requires a mission as its parent task',
        };
      }
    }
    // goals.update_progress writes an owner-owned goal row and is intentionally
    // kept available under taint (see builtin/index.ts) so a research-then-report
    // goal loop can record progress without an approval on every step. Because it
    // slips the taint-approval gate, bind the write to the goal this task is
    // actually working: it may only update the task's own goal (scheduled goal
    // automation / goal work task) or the goal its work chat belongs to. Untrusted
    // content that entered the session therefore cannot redirect the write to a
    // different goal or drive one from a task that owns no goal at all.
    if (input.toolName === 'goals.update_progress') {
      const argGoalId =
        typeof input.args.goalId === 'string' ? (input.args.goalId as string) : null;
      let boundGoalId = input.task.goalId ?? null;
      if (!boundGoalId && input.task.conversationId) {
        boundGoalId = await this.executionRepository.conversationGoalId(
          input.task.agentId,
          input.task.conversationId,
        );
      }
      if (!argGoalId || !boundGoalId || argGoalId !== boundGoalId) {
        return {
          kind: 'rejected',
          reason:
            'goals.update_progress may only update the goal this task or its work chat is bound to',
        };
      }
      const unattended = input.task.type !== 'chat_turn' && input.task.type !== 'sms_turn';
      if (unattended) {
        const prior = await this.executionRepository.goalWorkEvidence(
          input.task.agentId,
          input.task.id,
        );
        if (!prior.some(isGoalWorkEvidence)) {
          return {
            kind: 'rejected',
            reason: 'record progress only after this goal session completes a verified work step',
          };
        }
      }
    }
    const { tool } = registered;

    // Taint: an external sender may never reach a tool that declares it cannot
    // consume externally-derived arguments. There is no owner in the loop to
    // adjudicate, so this stays a hard rejection.
    //
    // A privileged owner/assistant task is the case with a human present. The
    // call is NOT rejected here — it falls through to `taintNeedsApproval`
    // below, which pins it to the approval path so the owner confirms the exact
    // arguments before anything executes. The workflow also propagates taint
    // from marked tool results.
    if (
      !tool.acceptsUntrustedInput &&
      (input.ctx.trust === 'unknown' || input.ctx.trust === 'known')
    ) {
      return {
        kind: 'rejected',
        reason: `tool ${input.toolName} does not accept externally sourced input`,
      };
    }

    const parsed = tool.inputSchema.safeParse(input.args);
    if (!parsed.success) {
      return { kind: 'rejected', reason: `invalid args: ${parsed.error.message}` };
    }
    let args = parsed.data as Record<string, unknown>;

    if (
      input.toolName === 'improvement.report' &&
      (input.ctx.trust !== 'owner' ||
        !input.ctx.ownerIntent?.authorizedScopes.includes('feedback_write'))
    ) {
      return {
        kind: 'rejected',
        reason: 'no direct owner feedback-report request authorized this action',
      };
    }

    // A source can be present in an authenticated owner message without being
    // an owner request. Every direct owner chat turn must therefore carry the
    // parsed scope for a sensitive action, even when its context is otherwise
    // clean. Earlier completed actions and recalled material are evidence, not
    // fresh authority. Tainted owner/assistant workflows keep the same guard;
    // non-chat autonomous task classes retain their existing policy.
    const directOwnerChat = input.task.type === 'chat_turn' && input.ctx.trust === 'owner';
    const enforceFullIntentScopes =
      input.ctx.tainted && (input.ctx.trust === 'owner' || input.ctx.trust === 'assistant');
    if (directOwnerChat || enforceFullIntentScopes) {
      const requiredScopes = requiredOwnerIntentScopes(
        input.toolName,
        registered.flags,
        tool.acceptsUntrustedInput,
        args,
      );
      // Clean owner chat keeps the existing autonomous read path. A fresh
      // owner-authored scope is required only for writes, outward actions, and
      // other mutation scopes. Once context is tainted, preserve the full
      // existing intent check, including private/external reads.
      const guardedScopes =
        directOwnerChat && !input.ctx.tainted
          ? requiredScopes.filter((scope) => scope !== 'private_read' && scope !== 'external_read')
          : requiredScopes;
      const authorizedScopes = new Set(input.ctx.ownerIntent?.authorizedScopes ?? []);
      const missing = guardedScopes.filter((scope) => !authorizedScopes.has(scope));
      if (missing.length > 0) {
        return {
          kind: 'rejected',
          reason: `no positively authored owner request authorized this action (${missing.join(', ')}); ask the owner to state the intended action directly`,
        };
      }
    }

    // Prepare hook (e.g. voice rewrite) — runs BEFORE the approval card is
    // built so what the owner approves is exactly what executes. It is
    // best-effort: today's only hook is the voice rewrite, which is explicitly
    // documented to fail safe to the original draft. A rewrite/embed error (or
    // its budget reservation) must therefore never propagate — that would park
    // or dead-letter the owner's outbound message itself instead of sending it.
    if (tool.prepare) {
      try {
        args = (await tool.prepare(args, input.ctx)) as Record<string, unknown>;
      } catch (err) {
        console.error(
          `tool ${input.toolName} prepare hook failed; dispatching with un-prepared args`,
          err,
        );
      }
    }

    // Security preparation creates the binding that an approval records. Unlike
    // a cosmetic rewrite, it is mandatory: a transient lookup failure must not
    // leave an unbound approval that could execute later.
    if (tool.prepareSecurity) {
      try {
        args = (await tool.prepareSecurity(args, input.ctx, 'dispatch')) as Record<string, unknown>;
      } catch {
        return {
          kind: 'rejected',
          reason: 'required security preparation failed; no approval or execution was created',
        };
      }
    }

    // Preparation may resolve or normalize a resource reference. Check the
    // resource that will actually execute before policies or cache can use it.
    if (ownerExplicitlyProhibitsPrivateRead(input.toolName, input.ctx, registered.flags, args)) {
      return { kind: 'rejected', reason: readProhibitionReason(input.toolName) };
    }

    // Outbound domain allowlist. Mirrors a restriction the mail provider itself
    // enforces (a bot account blocked from mailing outside its own org), so a
    // send outside it cannot succeed no matter who approves it. Rejected here
    // rather than gated: queuing an approval card for mail that will bounce
    // teaches the owner to approve things that never happen, and it must not be
    // overridable by a policy allow rule or an autonomy grant, both of which are
    // evaluated below.
    const blockedRecipients = (
      RECIPIENT_TOOLS.has(input.toolName) ? recipientsFrom(input.toolName, args).emails : []
    ).filter((email) => !outboundEmailAllowed(email));
    if (blockedRecipients.length > 0) {
      return {
        kind: 'rejected',
        reason:
          `cannot send to ${blockedRecipients.join(', ')}: outside the domains this assistant ` +
          'is permitted to email (EMAIL_OUTBOUND_DOMAINS)',
      };
    }

    // Policy match (templates only; unknown templates fail closed)
    const policyMatch = await matchPolicies(this.policyRepository, {
      agentId: input.task.agentId,
      toolName: input.toolName,
      args,
      ctx: input.ctx,
    });
    if (policyMatch?.effect === 'deny') {
      return {
        kind: 'rejected',
        reason: `denied by policy ${policyMatch.policy.templateKey}`,
      };
    }

    // Tier: policy allow overrides an 'approval' tier; dynamic fn otherwise.
    const baseTier: RiskTier =
      typeof tool.risk === 'function' ? tool.risk(args, input.ctx) : tool.risk;
    if (baseTier === 'forbidden') {
      return { kind: 'rejected', reason: `tool ${input.toolName} is forbidden` };
    }
    // Once attacker-controlled content enters a privileged owner/assistant
    // workflow, persistence into durable memory, network egress, any
    // outward-facing action, and anything declaring acceptsUntrustedInput:false
    // need exact-argument owner approval. Private reads and writes to the
    // assistant's own workspace remain autonomous: they cannot disclose data by
    // themselves, and the eventual outward/network sink is still gated here.
    // acceptsUntrustedInput is included because the registry now keeps those
    // tools visible under privileged taint (see toolsForTask): this gate is what
    // makes that safe, and without it such a tool could run autonomously on
    // arguments lifted straight out of a forwarded email.
    // Ordinary policy allow rules cannot override this provenance boundary.
    // An explicit any-arguments grant for one identity-bound MCP tool is the
    // only exception, checked against that tool's prepared binding below.
    // outwardFacing is listed explicitly so a future outward tool that accepts
    // untrusted input but is NOT marked networkEgress still cannot act
    // autonomously under taint (today every such tool also carries networkEgress,
    // so this is defense-in-depth that makes the invariant enforced, not merely
    // conventional).
    const privilegedTaint =
      input.ctx.tainted && (input.ctx.trust === 'owner' || input.ctx.trust === 'assistant');
    // Public research does not need another approval for an unchanged search
    // result URL. This never permits a model-built query, a new destination,
    // a private-data lookup, or an outward mutation. URL/redirect SSRF checks
    // and explicit policy denies still apply in their existing layers.
    const sourceRead =
      privilegedTaint && (await authorizedPublicSourceRead(this.executionRepository, input, args));
    // A tool flagged blanketAllowIneligible may never be downgraded to
    // autonomous by a standing "always allow" policy, except for explicitly
    // registered bounded templates. Otherwise its risk must always be
    // decided per-call. Enforced here at match time (not just at policy
    // creation) so a hand-inserted or legacy allow row for such a tool still
    // fails closed. The taint gate below still overrides ordinary policy allow.
    const policyAllows =
      policyMatch?.effect === 'allow' &&
      (registered.flags.blanketAllowIneligible !== true ||
        registered.flags.scopedAllowTemplates?.includes(policyMatch.policy.templateKey) === true);
    const explicitlyAllowedUnderTaint =
      policyAllows &&
      input.ctx.trust === 'owner' &&
      registered.flags.scopedAllowUnderTaintTemplates?.includes(policyMatch.policy.templateKey) ===
        true;
    const taintNeedsApproval =
      privilegedTaint &&
      !explicitlyAllowedUnderTaint &&
      !sourceRead &&
      // A tool whose only sink is the owner's own dashboard cannot exfiltrate or
      // reach a third party, so it stays autonomous under taint (D6). Every
      // other capability that could disclose data or act outward is gated.
      // Evaluated per call, because for some tools the property depends on the
      // arguments — an event with attendees mails them, one without does not.
      !ownerVisibleOnlyFor(registered.flags, args) &&
      (tool.acceptsUntrustedInput === false ||
        registered.flags.writesMemory === true ||
        registered.flags.networkEgress === true ||
        registered.flags.outwardFacing === true);
    // Provenance guard: a send to a recipient the owner/thread never provided
    // (and that is not a saved contact) is held for owner confirmation, so the
    // model cannot autonomously email or text a fabricated address. A matching
    // allow policy is recipient-specific, so it still wins. Never a hard block —
    // the owner approving the card IS the confirmation.
    const unverifiedRecipients =
      !policyAllows && RECIPIENT_TOOLS.has(input.toolName)
        ? await this.unverifiedRecipients(input.toolName, args, input.ctx)
        : [];
    const recipientUnverified = unverifiedRecipients.length > 0;
    const computedTier: RiskTier = taintNeedsApproval
      ? 'approval'
      : policyAllows
        ? 'autonomous'
        : recipientUnverified
          ? 'approval'
          : baseTier;

    // Free-range grant: an owner-armed grant downgrades an otherwise
    // approval-gated call to autonomous, unless the call is on the hard floor
    // (memory write under taint, unverified recipient, or a floor-flagged
    // high-consequence tool). Policy denies already returned above, and budget
    // is still reserved on the autonomous path — both stay enforced.
    const grant = computedTier === 'approval' ? activeAutonomyGrant(input.task, Date.now()) : null;
    const grantApplied =
      grant !== null &&
      !autonomyFloorBlocks({
        flags: registered.flags,
        tainted: input.ctx.tainted,
        recipientUnverified,
      });
    const tier: RiskTier = grantApplied ? 'autonomous' : computedTier;

    const decision = {
      riskTier: tier,
      reason: grantApplied
        ? `autonomous under your free-range grant (armed via ${grant?.grantedVia})`
        : taintNeedsApproval
          ? 'owner approval required because untrusted content entered this workflow'
          : policyAllows
            ? `allowed by policy ${policyMatch?.policy.templateKey}`
            : recipientUnverified
              ? `owner approval required: unverified recipient (${unverifiedRecipients.join(', ')}) — not in this conversation or your contacts`
              : sourceRead
                ? 'read of an unchanged URL returned by this owner-requested public search'
                : `tool default (${baseTier})`,
      policyId: policyMatch?.policy.id,
      policyVersion: policyMatch?.policy.version,
      plannerVersion: input.provenance.plannerVersion,
      promptVersion: input.provenance.promptVersion,
      model: input.provenance.model,
      modelToolCallId: input.modelToolCallId,
    };

    if (tier === 'approval') {
      return this.parkForApproval({ input, args, decision, registered });
    }

    // Rate limit (autonomous executions only — approvals are human-gated anyway)
    if (
      !(await this.executionRepository.underRateLimit(`tool:${input.toolName}`, input.toolName))
    ) {
      return { kind: 'rejected', reason: `rate limit exceeded for ${input.toolName}` };
    }

    // Cache
    const key = cacheKey(input.task.agentId, input.toolName, args);
    if (tool.cacheTtlSeconds) {
      const hit = await this.executionRepository.cacheGet(key);
      if (hit) {
        const row = await this.executionRepository.cached({
          taskId: input.task.id,
          agentId: input.task.agentId,
          step: input.step,
          toolName: input.toolName,
          args,
          idempotencyKey: null,
          result: hit.result,
          decision: { ...decision, cached: true },
        });
        return {
          kind: 'executed',
          toolCallId: row.id,
          result: hit.result,
          cached: true,
        };
      }
    }

    return this.execute({ input, args, decision, registered });
  }

  /** Reserve a tool's declared cost estimate. null = tool has no estimate (nothing to reserve). */
  private async reserveForTool(
    registered: RegisteredTool,
    args: Record<string, unknown>,
    taskId: string,
  ): Promise<ToolReservation | null> {
    const estimate = registered.tool.estimateCost?.(args);
    if (!estimate) return null;
    const rate = await this.costRepository.getRate(estimate.rateKey);
    if (!rate) return null;
    const estimatedUsd = estimate.quantity * rate.unitPriceUsd;
    if (estimatedUsd <= 0) return null;
    const reservation = await this.costRepository.reserve({
      source: estimate.source,
      estimatedUsd,
      taskId,
      description: estimate.description ?? registered.tool.name,
    });
    return reservation.ok
      ? {
          ...reservation,
          estimatedUsd,
          quantity: estimate.quantity,
          unit: estimate.unit ?? rate.unit,
          unitPriceUsd: rate.unitPriceUsd,
          description: estimate.description ?? registered.tool.name,
          ...(estimate.evidence ? { evidence: estimate.evidence } : {}),
        }
      : reservation;
  }

  private async parkForApproval(opts: {
    input: DispatchInput;
    args: Record<string, unknown>;
    decision: Record<string, unknown>;
    registered: RegisteredTool;
  }): Promise<DispatchOutcome> {
    const { input, args, decision, registered } = opts;
    const summary =
      registered.tool.approvalSummary?.(args) ?? approvalFallbackSummary(input.toolName, args);

    const parked = await createApproval(this.approvalRepository, {
      taskId: input.task.id,
      step: input.step,
      toolName: input.toolName,
      args,
      decision,
      summary,
    });
    return { kind: 'awaiting_approval', ...parked };
  }

  private async execute(opts: {
    input: DispatchInput;
    args: Record<string, unknown>;
    decision: Record<string, unknown>;
    registered: RegisteredTool;
  }): Promise<DispatchOutcome> {
    const { input, args, decision, registered } = opts;
    const idempotencyKey = registered.tool.idempotencyKey?.(args, {
      ...input.ctx,
      operationId: input.modelToolCallId,
    });

    // Crash-retry protection: if this exact side effect already succeeded,
    // return the recorded result instead of executing again.
    if (idempotencyKey) {
      const compactReceipt = await this.executionRepository.findReceiptByIdempotencyKey?.(
        input.task.agentId,
        input.task.id,
        idempotencyKey,
      );
      const prior = await this.executionRepository.findIdempotent(
        input.task.agentId,
        input.task.id,
        idempotencyKey,
      );
      if (compactReceipt && prior)
        return {
          kind: 'rejected',
          reason: 'conflicting live and compact tool receipts; refusing to replay the action',
        };
      if (compactReceipt && compactReceipt.toolName !== input.toolName)
        return {
          kind: 'rejected',
          reason: 'idempotency identity belongs to a different tool; refusing to replay it',
        };
      if (prior && prior.toolName !== input.toolName)
        return {
          kind: 'rejected',
          reason: 'idempotency identity belongs to a different tool; refusing to replay it',
        };
      let priorArgs: unknown = prior?.args;
      if (
        prior?.approvalId &&
        ownerExplicitlyProhibitsPrivateRead(input.toolName, input.ctx, registered.flags)
      ) {
        const loaded = await this.executionRepository.load(
          input.task.agentId,
          input.task.id,
          prior.id,
        );
        priorArgs =
          loaded &&
          loaded.task.id === input.task.id &&
          loaded.task.agentId === input.task.agentId &&
          loaded.toolCall.id === prior.id &&
          loaded.toolCall.toolName === input.toolName
            ? recordedReadArguments(loaded.toolCall, loaded.approval)
            : undefined;
      }
      if (
        (compactReceipt &&
          ownerExplicitlyProhibitsPrivateRead(input.toolName, input.ctx, registered.flags)) ||
        (prior &&
          ownerExplicitlyProhibitsPrivateRead(
            input.toolName,
            input.ctx,
            registered.flags,
            priorArgs,
          ))
      )
        return { kind: 'rejected', reason: readProhibitionReason(input.toolName) };
      if (compactReceipt) return compactRecordedOutcome(compactReceipt);
      if (prior?.status === 'succeeded') {
        return { kind: 'executed', toolCallId: prior.id, result: prior.result, cached: false };
      }
      if (prior && prior.status === 'executing') {
        return { kind: 'rejected', reason: 'identical call already executing' };
      }
      if (prior) {
        return {
          kind: 'rejected',
          reason: `identical call is already recorded as ${prior.status}; refusing an ambiguous side-effect retry`,
        };
      }
    }

    // Reserve only after cache/idempotency shortcuts. A free replay must not
    // strand a budget hold until the stale-reservation sweeper runs.
    const reserved = await this.reserveForTool(registered, args, input.task.id);
    if (reserved && !reserved.ok) {
      return { kind: 'budget_blocked', reason: reserved.reason, resumeAt: reserved.resumeAt };
    }
    if (reserved?.ok) decision.reservationId = reserved.reservationId;

    const row = await this.executionRepository.start({
      agentId: input.task.agentId,
      taskId: input.task.id,
      step: input.step,
      toolName: input.toolName,
      args,
      idempotencyKey: idempotencyKey ?? null,
      decision,
    });
    if (!row) {
      // lost an idempotency race to a concurrent executor
      if (reserved?.ok) await this.costRepository.release(reserved.reservationId).catch(() => {});
      return { kind: 'rejected', reason: 'identical call already in flight' };
    }

    let providerCompleted = false;
    let completedResult: unknown;
    try {
      // The span brackets only the provider call itself — risk gating, budget
      // reservation, and ledger writes are the dispatcher's own fast work.
      const result = await withSpan(
        'tool.execute',
        {
          tool: input.toolName,
          taskId: input.task.id,
          step: input.step,
          trust: input.ctx.trust,
        },
        async () =>
          registered.tool.execute(
            args,
            this.executionContext(
              input.ctx,
              row.id,
              input.toolName,
              input.modelToolCallId,
              input.task.leaseToken,
            ),
          ),
      );
      completedResult = result;
      providerCompleted = true;
      if (reserved?.ok && !isJobPending(result)) {
        await this.costRepository
          .reconcile(
            reserved.reservationId,
            reconciledToolCost(registered, args, result, reserved, row.id),
          )
          .catch(() => {});
      }
      const persisted = await this.executionRepository.outcome({
        agentId: input.task.agentId,
        taskId: input.task.id,
        toolCallId: row.id,
        status: 'succeeded',
        fromStatus: 'executing',
        ...(isJobPending(result) ? {} : { result: result ?? null }),
      });
      if (!persisted)
        return {
          kind: 'rejected',
          reason: 'tool success could not be persisted; retry suppressed',
        };

      if (registered.tool.cacheTtlSeconds) {
        await this.executionRepository.cachePut({
          cacheKey: cacheKey(input.task.agentId, input.toolName, args),
          toolName: input.toolName,
          result: result ?? null,
          expiresAt: new Date(Date.now() + registered.tool.cacheTtlSeconds * 1000),
        });
      }

      return { kind: 'executed', toolCallId: row.id, result, cached: false };
    } catch (err) {
      if (providerCompleted) {
        if (reserved?.ok)
          await this.costRepository
            .reconcile(
              reserved.reservationId,
              reconciledToolCost(
                registered,
                args,
                completedResult,
                reserved,
                row.id,
                ' (persistence outcome unknown)',
              ),
            )
            .catch(() => {});
        return {
          kind: 'rejected',
          reason: 'provider completed but outcome persistence failed; retry suppressed',
        };
      }
      if (
        isAmbiguousTwilioDeliveryError(err) ||
        isAmbiguousGoogleMutationError(err) ||
        isAmbiguousMcpMutationError(err) ||
        err instanceof PartialGoogleArtifactError
      ) {
        const result = {
          deliveryStatus: 'unknown',
          ...(err instanceof PartialGoogleArtifactError
            ? { externalEffect: err.progress, partialCompletion: true }
            : {}),
          retrySuppressed: true,
          note: 'The provider may have accepted this mutation; do not retry automatically.',
          ...(reserved?.ok && reserved.evidence?.sms
            ? { smsAccounting: reserved.evidence.sms }
            : {}),
        };
        if (reserved?.ok) {
          await this.costRepository
            .reconcile(reserved.reservationId, {
              usd: reserved.estimatedUsd,
              quantity: reserved.quantity,
              unit: reserved.unit,
              unitPriceUsd: reserved.unitPriceUsd,
              evidence: reserved.evidence,
              toolCallId: row.id,
              description: `${reserved.description} (delivery outcome unknown)`,
            })
            .catch((error) => console.error('ambiguous tool cost reconciliation failed', error));
        }
        const persisted = await this.executionRepository.outcome({
          agentId: input.task.agentId,
          taskId: input.task.id,
          toolCallId: row.id,
          status: 'succeeded',
          fromStatus: 'executing',
          result,
        });
        if (!persisted)
          return {
            kind: 'rejected',
            reason: 'ambiguous delivery state could not be persisted; retry suppressed',
          };
        return { kind: 'executed', toolCallId: row.id, result, cached: false };
      }

      // A definitive rejection means the reserved work never happened.
      const reservationId = (decision as Record<string, unknown>).reservationId;
      if (typeof reservationId === 'string') {
        await this.costRepository.release(reservationId).catch(() => {});
      }
      const persisted = await this.executionRepository.outcome({
        agentId: input.task.agentId,
        taskId: input.task.id,
        toolCallId: row.id,
        status: 'failed',
        fromStatus: 'executing',
        error: String(err).slice(0, 2000),
      });
      if (!persisted)
        return {
          kind: 'rejected',
          reason: 'tool failure could not be persisted; retry suppressed',
        };
      return { kind: 'rejected', reason: `execution failed: ${String(err).slice(0, 500)}` };
    }
  }

  private executionContext(
    ctx: ToolContext,
    dbToolCallId: string,
    toolName: string,
    modelToolCallId?: string,
    taskLeaseToken?: string | null,
  ): ToolContext {
    return {
      ...ctx,
      taskLeaseToken,
      operationId: modelToolCallId ?? dbToolCallId,
      checkpointExternalEffect: async (progress) => {
        const current = await this.executionRepository.load(ctx.agentId, ctx.taskId, dbToolCallId);
        if (!current || !this.executionRepository.checkpointExternalEffect)
          throw new Error('External effect checkpoint is unavailable');
        const payloadDigest = createHash('sha256')
          .update(JSON.stringify(current.toolCall.args))
          .digest('hex');
        const saved = await this.executionRepository.checkpointExternalEffect({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          toolCallId: dbToolCallId,
          progress: { ...progress, payloadDigest },
        });
        if (!saved) throw new Error('External effect checkpoint lost its execution fence');
      },
      execution: {
        dbToolCallId,
        modelToolCallId: modelToolCallId ?? '',
        toolName,
      },
    };
  }
}
