import type { OwnerIntent, StagedJobPending, Trust } from '@assistant/core';
import type { Db, SpendSource } from '@assistant/db';
import type {
  CostEvidence,
  ExternalEffectProgress,
  ReminderEventDependency,
  ReservationActual,
} from '@assistant/persistence';
import type { z } from 'zod';

export type RiskTier = 'autonomous' | 'approval' | 'forbidden';

export interface ToolExecutionIdentity {
  dbToolCallId: string;
  modelToolCallId: string;
  toolName: string;
}

export interface StagedBrowserJob extends ToolExecutionIdentity {
  pending: StagedJobPending;
}

export interface ToolContext {
  taskId: string;
  /** Lease token from the currently claimed durable task, when running one. */
  taskLeaseToken?: string | null;
  agentId: string;
  conversationId?: string;
  trust: Trust;
  /** True once externally controlled content has entered this workflow's model context. */
  tainted: boolean;
  /** Typed owner-authored intent; external text never contributes authorized scopes. */
  ownerIntent?: OwnerIntent;
  /**
   * Email addresses and phone numbers the owner/thread actually provided (from
   * the seed conversation window + trigger payload). The dispatcher treats a
   * recipient outside this set ∪ contacts as unverified and escalates the send
   * to owner approval, so the model cannot silently email a fabricated address.
   */
  knownAddresses?: { emails: string[]; phones: string[] };
  db: Db;
  now: () => Date;
  /** Immutable request clock and timezone for owner-relative one-time schedules. */
  requestAt?: Date;
  requestTimeZone?: string;
  /** Runtime-bound fixture copied from a successful current-task sports result. */
  verifiedReminderEvent?: ReminderEventDependency;
  /** Durable booking revision bound when a mail-derived suggestion was accepted. */
  bookingOccurrence?: {
    agentId: string;
    bookingKey: string;
    version: number;
    operation?: 'cancel_existing';
    calendarEventId?: string;
    bookingIdentity?: string;
  };
  /** Revalidate a mail-derived booking revision immediately before calendar write. */
  assertBookingOccurrenceCurrent?: () => Promise<boolean>;
  signal: AbortSignal;
  log: (type: string, payload: unknown) => Promise<void>;
  /** Present only while the dispatcher is executing a persisted tool_calls row. */
  execution?: ToolExecutionIdentity;
  /** Dispatcher-bound operation identity; independent of generated display/content. */
  operationId?: string;
  checkpointExternalEffect?: (
    progress: Omit<ExternalEffectProgress, 'payloadDigest'>,
  ) => Promise<void>;
  /** Browser launch intent must be checkpointed before the external job request. */
  stageBrowserJob?: (job: StagedBrowserJob) => Promise<void>;
  /** Roll back a staged intent after a definitive pre-launch/provider rejection. */
  clearStagedBrowserJob?: (job: StagedBrowserJob) => Promise<void>;
}

/**
 * The tool contract. `risk` may be a function for dynamic tiers (e.g. a
 * calendar event with no attendees is autonomous; with attendees it needs
 * approval). Tools with `acceptsUntrustedInput: false` are rejected by the
 * dispatcher when their args derive from untrusted-origin content, regardless
 * of the task's trust tier.
 */
export interface AssistantTool<S extends z.ZodType = z.ZodType, Out = unknown> {
  name: string;
  description: string;
  inputSchema: S;
  risk: RiskTier | ((args: z.infer<S>, ctx: ToolContext) => RiskTier);
  acceptsUntrustedInput: boolean;
  /**
   * Optional args transform run after validation, before risk evaluation and
   * approval-card creation (e.g. voice rewrite of outbound text) — so what
   * the owner approves is exactly what executes.
   */
  prepare?: (args: z.infer<S>, ctx: ToolContext) => Promise<z.infer<S>>;
  /** Mandatory security binding, unlike cosmetic preparation: failure blocks dispatch. */
  prepareSecurity?: (
    args: z.infer<S>,
    ctx: ToolContext,
    phase: 'dispatch' | 'approved',
  ) => Promise<z.infer<S>>;
  /** Human-readable action line shown on approval cards. */
  approvalSummary?: (args: z.infer<S>) => string;
  idempotencyKey?: (args: z.infer<S>, ctx: ToolContext) => string;
  cacheTtlSeconds?: number;
  /**
   * Pre-flight cost estimate (Phase 27): declared by tools that start
   * expensive work (job launches, outbound calls). The dispatcher reserves
   * quantity × rate_table[rateKey] against remaining budget BEFORE execute —
   * insufficient budget defers the call (task parks as waiting_budget)
   * instead of launching and overshooting.
   */
  estimateCost?: (args: z.infer<S>) => {
    source: SpendSource;
    rateKey: string;
    quantity: number;
    /** Override a legacy rate-table unit when the configured price is per SMS segment. */
    unit?: string;
    description?: string;
    evidence?: CostEvidence;
  } | null;
  /** Provider-reported usage/price that should replace the preflight estimate. */
  reconcileCost?: (args: z.infer<S>, result: Out) => Partial<ReservationActual>;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<Out>;
}

/** Security capabilities used to remove tools from untrusted task registries. */
export interface ToolFlags {
  /** Hidden from models and callable only by this exact internal event kind. */
  internalEventKind?: string;
  /** Argument whose value must equal the same-named internal event payload field. */
  internalEventArgument?: string;
  /** Stripped from the registry for tasks triggered by untrusted content. */
  outwardFacing?: boolean;
  /** Stripped for untrusted-trigger tasks (prevents memory-persistence attacks). */
  writesMemory?: boolean;
  /** Reads owner-private data such as mail, calendars, memory, goals, or files. */
  confidentialRead?: boolean;
  /** Mutates the owner's private workspace. */
  writesWorkspace?: boolean;
  /** Writes private assistant state outside the workspace (for example Gmail drafts). */
  privateWrite?: boolean;
  /**
   * The result may contain attacker-controlled instructions/content — text a
   * third party authored (a web page, a mail thread, a filed attachment, an
   * event body from an external invite). Owner-vetted own state (quarantine-
   * filtered memory, free/busy times, the calendar roster) deliberately does
   * NOT set this: tainting a task for grounding in its own state strips the
   * owner card and recall from every later step for no security gain.
   */
  returnsUntrustedContent?: boolean;
  /** Sends an attacker-observable network request even though it is nominally a read. */
  networkEgress?: boolean;
  /** Never eligible for a blanket "always allow" policy. */
  blanketAllowIneligible?: boolean;
  /** Explicit bounded templates that may allow this tool; taint still requires approval. */
  scopedAllowTemplates?: readonly string[];
  /** Explicit owner consent to any arguments for an identity-bound remote tool. */
  scopedAllowUnderTaintTemplates?: readonly string[];
  /**
   * Part of the free-range hard floor: even an owner-armed autonomy grant never
   * downgrades this tool's approval to autonomous. Set on the highest-consequence
   * capabilities (interactive/logged-in browser sessions, network-enabled code)
   * so "approve everything for this task" still stops at them. The read-only
   * variants of these tools are already autonomous, so the grant is never needed
   * for those; this only keeps the dangerous variant gated.
   */
  autonomyFloor?: boolean;
  /**
   * The tool's ONLY sink is the owner's own dashboard/conversation/calendar — it
   * cannot reach a third party or the network. Such a tool stays autonomous even
   * under taint: gating a message the owner sends to themselves behind the
   * owner's own approval is pure friction (they would have to approve being told
   * something), and it conveys no capability the model's normal reply text does
   * not already have. Use with extreme care — set it ONLY when the recipient is
   * hardwired to the owner and no argument can redirect it.
   *
   * A predicate form exists for tools where that property holds for SOME calls
   * and not others — `calendar.create_event` sends invitations when it has
   * attendees and is inert when it does not. It is evaluated per call against
   * the validated arguments, mirroring how `risk` is already allowed to vary.
   * A predicate must be conservative: it may only return true when the
   * arguments themselves prove nothing leaves the owner's own account. If it
   * throws, the dispatcher treats the call as NOT owner-visible.
   */
  ownerVisibleOnly?: boolean | ((args: unknown) => boolean);
}

/**
 * Resolve `ownerVisibleOnly` for one call. Fails closed: an argument shape the
 * predicate cannot evaluate is treated as reaching beyond the owner, so a bug
 * here costs an approval card rather than an unapproved outward action.
 */
export function ownerVisibleOnlyFor(flags: ToolFlags, args: unknown): boolean {
  const flag = flags.ownerVisibleOnly;
  if (typeof flag !== 'function') return flag === true;
  try {
    return flag(args) === true;
  } catch {
    return false;
  }
}

export type RegisteredTool = { tool: AssistantTool; flags: ToolFlags };
