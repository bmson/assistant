import type { Config } from '@assistant/config';
import type { ModelRouter } from '@assistant/core';
import type { Db, TaskRow } from '@assistant/db';
import type {
  EmailObserverClaim,
  EmailObserverEffectFence,
  EmailObserverIdentity,
  EmailObserverSource,
  ExecutionPersistence,
  FinalChannelDeliveryResult,
  NotificationDeliveryResult,
} from '@assistant/persistence';
import type { ToolDispatcher } from '@assistant/tools/dispatcher';
import type { ToolRegistry } from '@assistant/tools/registry';
import type { PortableReminderTools } from '@assistant/tools/reminders';
import type { WorkspaceStore } from '@assistant/tools/workspace';
import type { ModuleMeta } from './contract.js';

/**
 * The runtime half of the module contract. Unlike `contract.ts`, this reaches
 * into core, db, and tools, so only the agent composition root imports it —
 * never the web app or the deployment scripts.
 */

/**
 * Infrastructure every module receives. It stays deliberately small: modules
 * consume the platform through this context and *produce* their own provider
 * clients as exports, rather than the platform growing a field per provider.
 */
export interface ModulePlatformContext {
  config: Config;
  db: Db;
  registry: ToolRegistry;
  router: ModelRouter;
  workspace: WorkspaceStore;
  workspacePrefix: string;
  workspaceRoot: string;
  repoRoot: string;
  persistence: ExecutionPersistence;
  /** Present only in Firestore agent mode, where reminder tools use portable storage. */
  portableReminders?: PortableReminderTools;
}

/**
 * Cross-module port: reach the owner out-of-band (SMS today). Modules never
 * import each other — a channel module *provides* this and everyone else
 * consumes it through `ModuleServices`. Best-effort: when no installed module
 * provides one, the platform substitutes a no-op.
 */
/**
 * How hard a notice may push. 'ambient' (a briefing, a watch hit, an arrival
 * nudge — things the owner did not just ask for) is governed by the nudge
 * policy: quiet hours and the daily cap can hold its out-of-band legs while
 * the dashboard copy still posts. 'interrupt' — the default — always goes
 * through: it names things the owner is actively waiting on (an approval, a
 * stall in work they asked for), and gating those would hide a question they
 * already said yes to answering.
 */
export type OwnerNoticeUrgency = 'ambient' | 'interrupt';

export interface OwnerNotifier {
  notifyOwner(input: {
    text: string;
    /** Stable logical notice identity, reused when the source event is replayed. */
    deliveryKey?: string;
    taskId?: string;
    /**
     * The dashboard thread that already owns this notice, when one exists.
     * The dashboard notifier uses it to avoid mirroring a second copy into
     * the same primary conversation; phone notifications use it as their
     * authenticated navigation destination, while SMS ignores it.
     */
    conversationId?: string | null;
    urgency?: OwnerNoticeUrgency;
    /** Optional source fence propagated only by durable email-observer notices. */
    emailObserverEffectFence?: EmailObserverEffectFence;
    /** Task lineage used for delayed application-confirmation result notices. */
    applicationConfirmationNoticeFence?: import('@assistant/persistence').ApplicationConfirmationNoticeFence;
  }): Promise<NotificationDeliveryResult | void>;
  notifyApprovals(
    approvals: ReadonlyArray<{
      taskId: string;
      /** Stable owner-notice batch identity. */
      deliveryKey?: string;
      /** See notifyOwner.conversationId. */
      conversationId?: string | null;
      shortCode: string;
      summary: string;
      toolName?: string;
      /** Concise owner-facing reason the parked task was started. */
      purpose?: string;
    }>,
  ): Promise<NotificationDeliveryResult | void>;
}

export const noopOwnerNotifier: OwnerNotifier = {
  notifyOwner: async () => ({ legs: [{ channel: 'none', status: 'skipped' }] }),
  notifyApprovals: async () => ({ legs: [{ channel: 'none', status: 'skipped' }] }),
};

/** An authenticated inbound email another module may observe (side effects only). */
export interface InboundEmailEvent {
  agentId: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  /** Receiver-authenticated (SPF/DKIM/DMARC at the receiving provider). */
  authenticated: boolean;
  now?: Date;
}

export type EmailObserverPreparation =
  | { kind: 'prepared'; result: unknown }
  | { kind: 'no_op' }
  | { kind: 'budget_blocked'; mode: 'park' | 'block' }
  | { kind: 'unknown'; errorCode: string };

export type EmailObserverEffect =
  | { kind: 'complete' }
  | { kind: 'no_op' }
  | { kind: 'retryable_failed'; errorCode: string }
  | { kind: 'unknown'; errorCode: string };

/** A versioned handler installed before the first source admission. */
export type LegacyInboundEmailObserver = (
  services: ModuleServices,
  event: InboundEmailEvent,
) => Promise<void>;

export interface InboundEmailObserver {
  identity: EmailObserverIdentity;
  /** Dynamic feature gate checked before claims and again at each effect boundary. */
  shouldRun?(services: ModuleServices): Promise<boolean> | boolean;
  /** Called only after the persistence claim and authoritative source re-read. */
  prepare(
    services: ModuleServices,
    source: EmailObserverSource,
    claim: EmailObserverClaim,
  ): Promise<EmailObserverPreparation>;
  /** Must be deterministic/idempotent for a persisted prepared result. */
  apply(
    services: ModuleServices,
    source: EmailObserverSource,
    claim: EmailObserverClaim,
    preparedResult: unknown,
  ): Promise<EmailObserverEffect>;
}

/**
 * Invocation-time services for module hooks. Built by the composition root
 * AFTER `installModules` — that ordering is why hooks receive these as an
 * argument instead of `create(ctx)` carrying them: the dispatcher can only
 * exist once every module has registered its tools.
 */
export interface ModuleServices {
  config: Config;
  db: Db;
  router: ModelRouter;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  workspace: WorkspaceStore;
  ownerNotifier: OwnerNotifier;
  /** Existing fan-out retained until admission call sites switch to the ledger. */
  emailObservers: readonly LegacyInboundEmailObserver[];
  durableEmailObservers: readonly InboundEmailObserver[];
  persistence: ExecutionPersistence;
  /**
   * True only when this installation may perform provider-backed operations.
   * Firestore imports remain fenced until explicit activation. Modules that
   * do durable ingress work should call this immediately before writes.
   */
  operationalReady?: () => Promise<boolean>;
}

/** The narrow, framework-free request a webhook handler receives. */
export interface ModuleWebhookRequest {
  /** Parsed JSON body, or null when absent or invalid. */
  json<T = unknown>(): Promise<T | null>;
  /** URL-encoded form fields; pre-parsed by twilioSignature auth. */
  form(): Promise<Record<string, string>>;
  header(name: string): string | undefined;
}

export type ModuleHttpResponse =
  | { status: number; json: unknown }
  | { status: number; text: string; contentType?: string };

export type ModuleWebhookHandler = (
  services: ModuleServices,
  request: ModuleWebhookRequest,
) => Promise<ModuleHttpResponse>;

export type ModuleInternalHandler = (services: ModuleServices) => Promise<ModuleHttpResponse>;

/** A maintenance step run from both sweep drivers (poller and /internal/sweep). */
export interface ModuleSweepStep {
  name: string;
  /** Key under which /internal/sweep reports this step's count; defaults to name. */
  reportKey?: string;
  /**
   * True when the step reaches storage only through `services.persistence`
   * ports. Only portable steps run in the Firestore composition.
   */
  portable?: boolean;
  run(services: ModuleServices): Promise<number>;
}

/** Recurring local-poller work (one tick ≈ 2s). Errors are caught and logged. */
export interface ModuleTick {
  name: string;
  everyTicks: number;
  /** As for sweep steps: only portable ticks run in the Firestore composition. */
  portable?: boolean;
  run(services: ModuleServices): Promise<void>;
}

export type ModuleTaskResult = { outcome: 'done' | 'needs_attention' | 'not_claimable' } & Record<
  string,
  unknown
>;

/** A deterministic executor for internal tasks matched on trigger.payload.kind. */
export interface ModuleTaskHandler {
  kind: string;
  /** Pass a supplied generation into the atomic task claim; a pre-read alone is not a fence. */
  run(services: ModuleServices, taskId: string, generation?: number): Promise<ModuleTaskResult>;
}

/** An owner-facing delivery channel (email, SMS) composed into the executor. */
export interface ModuleChannel {
  /** Stable delivery-leg name used to preserve per-channel outcomes on throws. */
  name?: string;
  /** Deliver a finished task's final text; must self-guard by conversation channel. */
  deliverFinal(
    services: ModuleServices,
    task: TaskRow,
    text: string,
    attemptId: string,
  ): Promise<FinalChannelDeliveryResult>;
  /** Throw when a task of this shape requires this channel but it is unconfigured. */
  assertDeliverable?(task: Pick<TaskRow, 'type' | 'trust'>): void;
  /** In-thread notice when approvals park a task (email today). */
  deliverApprovalNotice?(services: ModuleServices, task: TaskRow, text: string): Promise<void>;
}

/**
 * Everything a module can plug into the running agent beyond tools. The
 * matching plain-data declarations (`meta.webhooks`, `meta.internalRoutes`)
 * stay in the contract so deployment and docs can see them; `installModules`
 * verifies the two sides agree at boot.
 */
export interface ModuleHooks {
  webhooks?: ReadonlyArray<{ path: string; handler: ModuleWebhookHandler }>;
  internalRoutes?: ReadonlyArray<{ path: string; handler: ModuleInternalHandler }>;
  sweepSteps?: readonly ModuleSweepStep[];
  ticks?: readonly ModuleTick[];
  taskHandlers?: readonly ModuleTaskHandler[];
  channel?: ModuleChannel;
  ownerNotifier?: OwnerNotifier;
  emailObservers?: readonly LegacyInboundEmailObserver[];
  durableEmailObservers?: readonly InboundEmailObserver[];
}

/**
 * What installing a module produced. Tools are registered as a side effect on
 * `context.registry` — the only path into the risk-gated dispatcher — so they
 * do not appear here.
 */
export interface ModuleRuntime<Exports = void> {
  exports?: Exports;
  hooks?: ModuleHooks;
}

export interface ModuleDefinition<Exports = void> {
  meta: ModuleMeta;
  /** Called only when the module is installed. */
  create: (context: ModulePlatformContext) => ModuleRuntime<Exports>;
  /**
   * What this module's exports look like when it is *not* installed.
   *
   * Providers that callers query unconditionally — `deps.googleClient`,
   * `deps.twilio` — declare a null object here whose `configured()` reports
   * false. `requireExports` then always has a value to return, so the
   * composition root holds a plain field rather than an optional one.
   */
  absent?: () => Exports;
}

/** Identity helper that infers a module's export type from its factory. */
export function defineModule<Exports = void>(
  definition: ModuleDefinition<Exports>,
): ModuleDefinition<Exports> {
  return definition;
}
