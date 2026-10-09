import type {
  DirectEmailRecoveryReason,
  DirectEmailRouting,
  DocumentExtractionMetadata,
  EmailContentProvenanceSnapshot,
  ImportArchiveDiagnostics,
  ImportUnitProvenance,
} from '@assistant/persistence';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  interval,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// Situation packs keep bounded planning state, not a second scheduler. Source
// snapshots and dependencies are reviewed explicitly before a correction lands.
export const situationPacks = pgTable(
  'situation_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    creationKey: text('creation_key').notNull(),
    title: text('title').notNull(),
    version: integer('version').notNull().default(1),
    archived: boolean('archived').notNull().default(false),
    data: jsonb('data').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('situation_packs_creation_idx').on(t.agentId, t.creationKey),
    index('situation_packs_agent_idx').on(t.agentId, t.archived),
  ],
);

export const situationPreviews = pgTable(
  'situation_previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packId: uuid('pack_id')
      .notNull()
      .references(() => situationPacks.id, { onDelete: 'cascade' }),
    baseVersion: integer('base_version').notNull(),
    sourceHash: text('source_hash').notNull(),
    data: jsonb('data').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('situation_preview_status', sql`${t.status} IN ('pending','applied','dismissed')`)],
);

// ── Identity ─────────────────────────────────────────────────────────────────

/** The assistant itself. One row today; agent_id everywhere so multi-agent later is data, not migration. */
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  calendarId: text('calendar_id'),
  phoneE164: text('phone_e164'),
  avatarUrl: text('avatar_url'),
  signature: text('signature').notNull().default(''),
  timezone: text('timezone').notNull().default('Atlantic/Reykjavik'),
  locale: text('locale').notNull().default('en'),
  /** GCS prefix for this agent's Workspace (browser profile, downloads, documents, artifacts). */
  workspacePrefix: text('workspace_prefix').notNull(),
  browserProfilePath: text('browser_profile_path'),
  /** Secret Manager secret NAMES (never raw secrets): { googleRefreshToken, twilioFrom, ... } */
  credentialRefs: jsonb('credential_refs').notNull().default({}),
  ...timestamps,
});

// ── External MCP connections ────────────────────────────────────────────────

/**
 * Owner-configured remote Model Context Protocol servers. The endpoint and
 * server-advertised tool metadata are durable; bearer credentials are stored
 * separately as authenticated encryption and are never selected for UI/model
 * summaries.
 */
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Human name selected by the owner, e.g. "Linear" or "Home Assistant". */
    name: text('name').notNull(),
    /** One Streamable HTTP endpoint, normalized and validated before persistence. */
    endpoint: text('endpoint').notNull(),
    /** AES-GCM payload for the optional bearer token; never expose this field. */
    bearerTokenEncrypted: text('bearer_token_encrypted'),
    /** ready | checking | authorization_required | error | disabled */
    status: text('status').notNull().default('checking'),
    enabled: boolean('enabled').notNull().default(true),
    serverName: text('server_name'),
    serverVersion: text('server_version'),
    instructions: text('instructions'),
    /** Sanitized `tools/list` response; never trusted as an instruction source. */
    tools: jsonb('tools').notNull().default([]),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    check(
      'mcp_connections_status_check',
      sql`${t.status} IN ('ready','checking','authorization_required','error','disabled')`,
    ),
    uniqueIndex('mcp_connections_agent_name_idx').on(t.agentId, t.name),
    index('mcp_connections_agent_status_idx').on(t.agentId, t.status),
  ],
);

// ── Goals & long-horizon work ────────────────────────────────────────────────

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('active'),
    priority: smallint('priority').notNull().default(3),
    progress: text('progress').notNull().default(''),
    nextAction: text('next_action').notNull().default(''),
    targetDate: timestamp('target_date', { withTimezone: true }),
    /**
     * Opt-in: also post this goal's autonomous mission updates into the owner's
     * primary chat thread, so background work shows up in the one discussion
     * (long-running-chat design, option B). Off by default to avoid noise.
     */
    mirrorToPrimary: boolean('mirror_to_primary').notNull().default(false),
    /**
     * True when this goal was created from a tainted (externally-influenced)
     * session — e.g. the model proposed goals.create while a forwarded email or
     * fetched page was in context. Its recurring automation sessions then start
     * tainted, so any web egress or outward action they attempt is owner-gated
     * instead of autonomous. A goal the owner creates directly is untainted.
     */
    taintedOrigin: boolean('tainted_origin').notNull().default(false),
    /**
     * Owner opt-in "free-range" mode: every automatic work session this goal
     * spawns is armed with an autonomy grant, so it may consult memory AND act
     * outward without parking each call for approval (the same hard floor as a
     * per-task grant still applies: memory writes under taint, unverified
     * recipients, interactive browser/networked code, and policy denies). A
     * tainted-origin goal can never be armed. Off by default.
     */
    autonomy: boolean('autonomy').notNull().default(false),
    /** Owner-hidden goal history. Linked chats, tasks, and evidence stay intact. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('goals_status_check', sql`${t.status} IN ('active','paused','done','abandoned')`),
    index('goals_agent_status_idx').on(t.agentId, t.status),
  ],
);

// ── Conversations & messages ─────────────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    channel: text('channel').notNull(),
    title: text('title').notNull().default(''),
    trust: text('trust').notNull().default('unknown'),
    /** Per-conversation model override for the chat switcher (models.id), null = role default. */
    modelOverride: text('model_override'),
    /**
     * The single canonical chat thread the UI opens by default (Phase 3 of the
     * long-running-chat design). At most one per agent, enforced below.
     */
    isPrimary: boolean('is_primary').notNull().default(false),
    /** Monotonic commit-ordered sequence assigned to messages in this thread. */
    messageSequence: bigint('message_sequence', { mode: 'number' }).notNull().default(0),
    metadata: jsonb('metadata').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * The owner's read cursor: when they last opened this thread. Drives the
     * unread marker in the chat list (activity newer than this). Null means
     * "never opened" — the list falls back to createdAt so old threads don't
     * all light up on migration day.
     */
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('conversations_channel_check', sql`${t.channel} IN ('chat','sms','email')`),
    check('conversations_trust_check', sql`${t.trust} IN ('owner','known','unknown','assistant')`),
    index('conversations_agent_idx').on(t.agentId, t.updatedAt),
    uniqueIndex('conversations_primary_idx').on(t.agentId).where(sql`${t.isPrimary}`),
  ],
);

/** Maps external thread identifiers (Gmail threadId, SMS peer E.164, web session) to conversations. */
export const channelBindings = pgTable(
  'channel_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    ...timestamps,
  },
  (t) => [
    check('channel_bindings_channel_check', sql`${t.channel} IN ('chat','sms','email')`),
    uniqueIndex('channel_bindings_channel_external_idx').on(t.channel, t.externalId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    role: text('role').notNull(),
    /** AI SDK UIMessage parts. */
    parts: jsonb('parts').notNull().default([]),
    /** Denormalized plain text (search, previews, embedding source). */
    text: text('text').notNull().default(''),
    origin: text('origin').notNull(),
    /** Gmail message id / Twilio MessageSid — idempotency for inbound events. */
    channelMessageId: text('channel_message_id'),
    /** Stable native client identity for owner-request/delivery readiness proof. */
    clientId: uuid('client_id'),
    /** Set by an authenticated native client only after this durable reply is visible. */
    clientDeliveredAt: timestamp('client_delivered_at', { withTimezone: true }),
    clientDeliveredBy: uuid('client_delivered_by'),
    /** Populated async for semantic search over conversations. */
    embedding: vector('embedding', { dimensions: 1536 }),
    /** Null for legacy vectors whose provider/model revision is unknown. */
    embeddingSpaceKey: text('embedding_space_key'),
    /** Owner-hidden from the chat log. The row stays; reads skip it. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Commit-ordered cursor assigned by the conversation append trigger. */
    appendSequence: text('append_sequence').notNull().default('00000000000000000000'),
  },
  (t) => [
    check('messages_role_check', sql`${t.role} IN ('user','assistant','system','tool')`),
    check(
      'messages_origin_check',
      sql`${t.origin} IN ('owner','known_contact','unknown','web','assistant','system')`,
    ),
    check(
      'messages_client_delivery_check',
      sql`(${t.clientDeliveredAt} IS NULL) = (${t.clientDeliveredBy} IS NULL)`,
    ),
    uniqueIndex('messages_channel_message_id_idx')
      .on(t.channelMessageId)
      .where(sql`${t.channelMessageId} IS NOT NULL`),
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    index('messages_conversation_visible_idx')
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.hiddenAt} IS NULL`),
    index('messages_conversation_append_idx').on(t.conversationId, t.appendSequence),
    index('messages_created_idx').on(t.createdAt),
    index('messages_task_created_idx')
      .on(t.taskId, t.createdAt)
      .where(sql`${t.taskId} IS NOT NULL`),
    index('messages_embedding_backfill_idx')
      .on(t.createdAt)
      .where(
        sql`${t.embedding} IS NULL AND ${t.role} IN ('user','assistant') AND length(${t.text}) > 20`,
      ),
    index('messages_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('messages_embedding_space_idx').on(t.conversationId, t.embeddingSpaceKey),
  ],
);

// ── Generative cards ────────────────────────────────────────────────────────

/**
 * The current saved-card lifecycle. Chat messages keep an immutable copy of
 * the revision they displayed; this table points the Cards hub at the newest
 * grounded revision without rewriting transcript history.
 */
export const generatedCards = pgTable(
  'generated_cards',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'),
    sourceLabel: text('source_label').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    currentRevisionId: uuid('current_revision_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('generated_cards_status_check', sql`${t.status} IN ('active','dismissed','expired')`),
    uniqueIndex('generated_cards_agent_source_idx').on(t.agentId, t.sourceFingerprint),
    index('generated_cards_agent_status_idx').on(t.agentId, t.status, t.updatedAt),
  ],
);

/** Immutable, auditable snapshots. The JSON value is a validated CardSpecV1. */
export const generatedCardRevisions = pgTable(
  'generated_card_revisions',
  {
    id: uuid('id').primaryKey(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => generatedCards.id, { onDelete: 'cascade' }),
    version: smallint('version').notNull().default(1),
    spec: jsonb('spec').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('generated_card_revisions_card_idx').on(t.cardId, t.createdAt)],
);

/**
 * Explicit conversational open loops. These are owner-private continuity
 * records, not instructions: extraction may create or update them, but only
 * the normal task/approval machinery may perform work.
 */
export const commitments = pgTable(
  'commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    sourceMessageId: uuid('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    sourceTaskId: uuid('source_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    /** Stable evidence identity; retained across status changes to fence replay. */
    sourceOccurrenceKey: text('source_occurrence_key'),
    /** Owner-authored reopen creates a new occurrence while preserving the closed source row. */
    reopenedFromId: uuid('reopened_from_id'),
    reopenOperationId: uuid('reopen_operation_id'),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    details: text('details').notNull().default(''),
    nextAction: text('next_action').notNull().default(''),
    status: text('status').notNull().default('open'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.9'),
    contentHash: text('content_hash').notNull(),
    ...timestamps,
  },
  (t) => [
    check(
      'commitments_kind_check',
      sql`${t.kind} IN ('decision','question','promise','waiting_on')`,
    ),
    check(
      'commitments_status_check',
      sql`${t.status} IN ('open','resolved','snoozed','dismissed','stale')`,
    ),
    check('commitments_confidence_check', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    uniqueIndex('commitments_agent_source_occurrence_idx')
      .on(t.agentId, t.sourceOccurrenceKey)
      .where(sql`${t.sourceOccurrenceKey} IS NOT NULL`),
    uniqueIndex('commitments_agent_reopen_operation_idx')
      .on(t.agentId, t.reopenOperationId)
      .where(sql`${t.reopenOperationId} IS NOT NULL`),
    uniqueIndex('commitments_agent_reopened_from_idx')
      .on(t.agentId, t.reopenedFromId)
      .where(sql`${t.reopenedFromId} IS NOT NULL`),
    index('commitments_agent_status_idx').on(t.agentId, t.status, t.updatedAt),
    index('commitments_conversation_idx').on(t.conversationId, t.status, t.createdAt),
  ],
);

/**
 * Topic segments over the single long-running chat (Phase 2 of the
 * long-running-chat design). Each segment is a contiguous run of messages on
 * one topic within a conversation, with a rolling summary + embedding. Recall
 * matches the SUMMARY embedding — a far better retrieval unit than lone
 * messages — and injects the summary plus a key line. Produced offline by the
 * `chat.segment` code job; never written on the chat hot path.
 */
export const conversationSegments = pgTable(
  'conversation_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    /** Inclusive message range this segment summarizes. */
    startMessageId: uuid('start_message_id')
      .notNull()
      .references(() => messages.id),
    endMessageId: uuid('end_message_id')
      .notNull()
      .references(() => messages.id),
    /** Rolling topic summary — the recall retrieval unit. */
    summary: text('summary').notNull().default(''),
    embedding: vector('embedding', { dimensions: 1536 }),
    embeddingSpaceKey: text('embedding_space_key'),
    messageCount: integer('message_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index('conversation_segments_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('conversation_segments_embedding_space_idx').on(t.agentId, t.embeddingSpaceKey),
    index('conversation_segments_conversation_idx').on(t.conversationId, t.endedAt),
    index('conversation_segments_agent_idx').on(t.agentId, t.endedAt),
    // Idempotent re-runs: a given start message anchors at most one segment.
    uniqueIndex('conversation_segments_start_idx').on(t.conversationId, t.startMessageId),
  ],
);

// ── Workflows (tasks) ────────────────────────────────────────────────────────

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    goalId: uuid('goal_id').references(() => goals.id),
    /** Short human title for activity/approval UIs (planner-authored; falls back to the instruction). */
    title: text('title'),
    /**
     * Owner-armed "free-range" grant (Phase 3). When present, unexpired, and
     * unrevoked, the dispatcher downgrades an otherwise approval-gated call to
     * autonomous — EXCEPT the hard floor (memory writes under taint, unverified
     * recipients, interactive browser / networked code, policy denies, budget).
     * Never armed from a tainted-origin task. See workflow/autonomy.ts.
     */
    autonomyGrant: jsonb('autonomy_grant'),
    /** Normalized InboundEvent that triggered this workflow. */
    trigger: jsonb('trigger').notNull().default({}),
    /** Idempotency for event → task creation (Gmail historyId+msgId, Twilio SID, ...). */
    externalEventId: text('external_event_id'),
    /** Planner output (PlanSchema) — persisted before execution. */
    plan: jsonb('plan'),
    /**
     * Authoritative checkpoint:
     * { phase, completedToolCallIds[], pendingApprovalId?, plannerState, scratchpad, contextWindow }
     * contextWindow = compacted working context; full tool results live in tool_calls.
     */
    state: jsonb('state').notNull().default({}),
    /** Mission-facing, dashboard-rendered. */
    progress: text('progress').notNull().default(''),
    progressPercent: smallint('progress_percent'),
    nextAction: text('next_action').notNull().default(''),
    deadline: timestamp('deadline', { withTimezone: true }),
    reflectEvery: interval('reflect_every'),
    lastReflectedAt: timestamp('last_reflected_at', { withTimezone: true }),
    trust: text('trust').notNull().default('unknown'),
    runAfter: timestamp('run_after', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Opaque fencing token independent of timestamp precision; null for legacy leases. */
    leaseToken: uuid('lease_token'),
    /** Monotonic delivery generation used to deduplicate queue pokes per runnable transition. */
    queueGeneration: integer('queue_generation').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    /**
     * Times this task's lease was reclaimed after expiring while 'running'
     * (a worker that hung or was killed without throwing, so it never recorded
     * a failed attempt). Reset to 0 whenever a step checkpoints. Bounds the
     * poison-pill loop: a task reclaimed this many times without progress
     * dead-letters to needs_attention instead of churning forever.
     */
    reclaimCount: integer('reclaim_count').notNull().default(0),
    maxSteps: integer('max_steps').notNull().default(12),
    budgetUsdLimit: numeric('budget_usd_limit', { precision: 8, scale: 4 })
      .notNull()
      .default('0.50'),
    spentUsd: numeric('spent_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id),
    /** Owner-hidden terminal history. Evidence stays intact and can be restored. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * Set when the owner has been told this task needs them (needs_attention or
     * waiting_event). Nulled on every entry into those states and on wake, so the
     * re-notify sweep (workflow/attention.ts) can re-emit a notice for any task
     * whose park→notify was lost to a crash. Mirrors approvals.notified_channels.
     */
    attentionNotifiedAt: timestamp('attention_notified_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check(
      'tasks_type_check',
      sql`${t.type} IN ('chat_turn','sms_turn','email_triage','scheduled','mission','browser_job','adhoc')`,
    ),
    check(
      'tasks_status_check',
      sql`${t.status} IN ('pending','running','waiting_approval','waiting_event','sleeping','waiting_budget','done','failed','needs_attention','cancelled')`,
    ),
    check('tasks_trust_check', sql`${t.trust} IN ('owner','known','unknown','assistant')`),
    check(
      'tasks_progress_percent_check',
      sql`${t.progressPercent} IS NULL OR (${t.progressPercent} >= 0 AND ${t.progressPercent} <= 100)`,
    ),
    uniqueIndex('tasks_external_event_id_idx')
      .on(t.externalEventId)
      .where(sql`${t.externalEventId} IS NOT NULL`),
    index('tasks_status_run_after_idx').on(t.status, t.runAfter),
    index('tasks_agent_status_idx').on(t.agentId, t.status, t.updatedAt),
    index('tasks_parent_idx').on(t.parentTaskId),
    // The chat view and its status poller filter by conversation on every
    // render/poll; goal views filter by goal. Postgres does not index FKs.
    index('tasks_conversation_idx').on(t.conversationId, t.status),
    index('tasks_goal_idx').on(t.goalId),
    index('tasks_pending_updated_idx').on(t.updatedAt).where(sql`${t.status} = 'pending'`),
    index('tasks_sleeping_run_after_idx')
      .on(t.runAfter)
      .where(sql`${t.status} IN ('sleeping','waiting_budget')`),
    index('tasks_running_locked_idx').on(t.lockedUntil).where(sql`${t.status} = 'running'`),
  ],
);

/** Durable reports for mission transitions. Chat append keys are the stable event ids. */
export const missionReports = pgTable(
  'mission_reports',
  {
    id: text('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    goalId: uuid('goal_id').references(() => goals.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    outcome: text('outcome').notNull(),
    text: text('text').notNull(),
    chatStatus: text('chat_status').notNull().default('pending'),
    ownerStatus: text('owner_status').notNull().default('pending'),
    mirrorStatus: text('mirror_status').notNull().default('pending'),
    claimToken: uuid('claim_token'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    chatDeliveredAt: timestamp('chat_delivered_at', { withTimezone: true }),
    ownerDeliveredAt: timestamp('owner_delivered_at', { withTimezone: true }),
    mirrorDeliveredAt: timestamp('mirror_delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'mission_reports_chat_status_check',
      sql`${t.chatStatus} IN ('pending','delivered','skipped','failed')`,
    ),
    check(
      'mission_reports_owner_status_check',
      sql`${t.ownerStatus} IN ('pending','delivered','skipped','failed','unknown')`,
    ),
    check(
      'mission_reports_mirror_status_check',
      sql`${t.mirrorStatus} IN ('pending','delivered','skipped','failed')`,
    ),
    index('mission_reports_pending_idx').on(t.nextAttemptAt, t.createdAt),
    index('mission_reports_mission_idx').on(t.agentId, t.missionId, t.createdAt),
  ],
);

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    step: integer('step').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').notNull().default({}),
    risk: text('risk').notNull(),
    status: text('status').notNull().default('proposed'),
    idempotencyKey: text('idempotency_key'),
    result: jsonb('result'),
    error: text('error'),
    approvalId: uuid('approval_id').references((): AnyPgColumn => approvals.id),
    /**
     * Decision provenance:
     * { riskTier, reason, policyId?, policyVersion?, plannerVersion, promptVersion, model }
     */
    decision: jsonb('decision').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tool_calls_risk_check', sql`${t.risk} IN ('autonomous','approval','forbidden')`),
    check(
      'tool_calls_status_check',
      sql`${t.status} IN ('proposed','awaiting_approval','approved','denied','executing','succeeded','failed')`,
    ),
    uniqueIndex('tool_calls_idempotency_key_idx')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('tool_calls_task_idx').on(t.taskId, t.step),
    index('tool_calls_rate_idx').on(t.toolName, t.status, t.createdAt),
  ],
);

/** Minimal non-replayable effect receipt retained after private call payload expiry. */
export const toolCallReceipts = pgTable(
  'tool_call_receipts',
  {
    /** Reuses the original call UUID for direct retry/reconciliation lookup. */
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Intentionally not an FK: receipt outlives pruned task history. */
    taskId: uuid('task_id').notNull(),
    toolCallId: uuid('tool_call_id').notNull().unique(),
    modelToolCallIdHash: text('model_tool_call_id_hash'),
    idempotencyKeyHash: text('idempotency_key_hash'),
    toolName: text('tool_name').notNull(),
    effectOutcome: text('effect_outcome').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'tool_call_receipts_outcome_check',
      sql`${t.effectOutcome} IN ('completed','failed','unknown','not_executed')`,
    ),
    check(
      'tool_call_receipts_model_hash_check',
      sql`${t.modelToolCallIdHash} IS NULL OR ${t.modelToolCallIdHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'tool_call_receipts_idempotency_hash_check',
      sql`${t.idempotencyKeyHash} IS NULL OR ${t.idempotencyKeyHash} ~ '^[a-f0-9]{64}$'`,
    ),
    index('tool_call_receipts_agent_task_idx').on(t.agentId, t.taskId),
    uniqueIndex('tool_call_receipts_model_lookup_idx')
      .on(t.modelToolCallIdHash)
      .where(sql`${t.modelToolCallIdHash} IS NOT NULL`),
    uniqueIndex('tool_call_receipts_global_idempotency_idx')
      .on(t.idempotencyKeyHash)
      .where(sql`${t.idempotencyKeyHash} IS NOT NULL`),
  ],
);

/** Digest-only serialization keys shared by active-call start and receipt compaction. */
export const toolCallReceiptKeys = pgTable(
  'tool_call_receipt_keys',
  {
    id: text('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Intentionally not an FK: key locks receipt identity beyond task pruning. */
    taskId: uuid('task_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    kind: text('kind').notNull(),
    digest: text('digest').notNull(),
  },
  (t) => [
    check('tool_call_receipt_keys_kind_check', sql`${t.kind} IN ('model_tool_call','idempotency')`),
    check('tool_call_receipt_keys_id_check', sql`${t.id} ~ '^[a-f0-9]{64}$'`),
    check('tool_call_receipt_keys_digest_check', sql`${t.digest} ~ '^[a-f0-9]{64}$'`),
    uniqueIndex('tool_call_receipt_keys_global_idempotency_idx')
      .on(t.digest)
      .where(sql`${t.kind} = 'idempotency'`),
    uniqueIndex('tool_call_receipt_keys_model_scope_idx')
      .on(t.agentId, t.taskId, t.digest)
      .where(sql`${t.kind} = 'model_tool_call'`),
    index('tool_call_receipt_keys_receipt_idx').on(t.receiptId),
  ],
);

/** One outbound phone call the assistant placed for the owner (calls module). */
export const callSessions = pgTable(
  'call_sessions',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    toolCallId: uuid('tool_call_id')
      .notNull()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    to: text('to').notNull(),
    contactName: text('contact_name'),
    brief: jsonb('brief').notNull(),
    voiceModel: text('voice_model').notNull(),
    /** Credential-free immutable route selected before reservation and dialing. */
    voiceRoute: jsonb('voice_route'),
    lineRate: jsonb('line_rate'),
    maxMinutes: integer('max_minutes').notNull(),
    twilioCallSid: text('twilio_call_sid'),
    streamTokenHash: text('stream_token_hash'),
    callbackToken: text('callback_token').notNull(),
    reservationId: text('reservation_id'),
    answeredBy: text('answered_by'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    transcript: jsonb('transcript').notNull().default([]),
    transcriptState: jsonb('transcript_state')
      .notNull()
      .default({ nextSequence: 1, pending: [], acknowledged: [] }),
    notes: jsonb('notes').notNull().default([]),
    checkins: jsonb('checkins').notNull().default([]),
    hangupRequested: boolean('hangup_requested').notNull().default(false),
    outcome: text('outcome'),
    summary: text('summary'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    error: text('error'),
    finishDelivery: jsonb('finish_delivery'),
    capacityReleasedAt: timestamp('capacity_released_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('call_sessions_agent_created_idx').on(t.agentId, t.createdAt),
    uniqueIndex('call_sessions_twilio_sid_idx').on(t.twilioCallSid),
    check(
      'call_sessions_status_check',
      sql`${t.status} IN ('dialing','ringing','in_progress','completed','no_answer','busy','failed','canceled')`,
    ),
  ],
);

/** Idempotent callback receipts for terminal external jobs such as phone calls. */
export const executionJobCallbackReceipts = pgTable(
  'execution_job_callback_receipts',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    queueGeneration: integer('queue_generation').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('execution_job_callback_receipts_task_idx').on(t.taskId)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    toolCallId: uuid('tool_call_id')
      .notNull()
      .references(() => toolCalls.id),
    /** Short human code (A7) — unique among *pending* approvals, for SMS replies. */
    shortCode: text('short_code').notNull(),
    summary: text('summary').notNull(),
    /** Exact args snapshot shown to the owner. */
    payload: jsonb('payload').notNull().default({}),
    /** Edited args from edit-then-approve; used at execution instead of payload. */
    resolutionPayload: jsonb('resolution_payload'),
    status: text('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedVia: text('resolved_via'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    notifiedChannels: text('notified_channels').array().notNull().default([]),
    /** Always/Never policy ID, retained after rule deletion (like anomalies.policyId). */
    createdPolicyId: uuid('created_policy_id'),
  },
  (t) => [
    check('approvals_status_check', sql`${t.status} IN ('pending','approved','denied','expired')`),
    check(
      'approvals_resolved_via_check',
      sql`${t.resolvedVia} IS NULL OR ${t.resolvedVia} IN ('web','sms')`,
    ),
    uniqueIndex('approvals_pending_short_code_idx')
      .on(t.shortCode)
      .where(sql`${t.status} = 'pending'`),
    index('approvals_status_idx').on(t.status, t.expiresAt),
    index('approvals_task_requested_idx').on(t.taskId, t.requestedAt),
  ],
);

// ── Pre-authorized cross-event workflows ────────────────────────────────────

/**
 * One owner-approved application-confirmation watch. The untrusted email never
 * supplies a Sheet destination or values: those exact arguments are frozen in
 * tracker_update when the owner approves the watch.
 */
export const applicationConfirmations = pgTable(
  'application_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    sourceTaskId: uuid('source_task_id')
      .notNull()
      .references(() => tasks.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    company: text('company').notNull(),
    role: text('role').notNull(),
    expectedSenderEmails: text('expected_sender_emails').array().notNull(),
    /** SHA-256 of an opaque, case-normalized receipt/requisition token. */
    confirmationTokenHash: text('confirmation_token_hash').notNull(),
    /** Non-sensitive last four characters for owner-facing audit messages. */
    confirmationTokenHint: text('confirmation_token_hint').notNull(),
    /** { spreadsheetId, sheetName, startCell, rows } approved before email arrival. */
    trackerUpdate: jsonb('tracker_update'),
    /** { documentId, content } approved before email arrival. */
    documentUpdate: jsonb('document_update'),
    /** Per-action durable state: { sheet?: { status }, document?: { status } }. */
    actionState: jsonb('action_state').notNull().default({}),
    status: text('status').notNull().default('awaiting_confirmation'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmationMessageId: text('confirmation_message_id'),
    confirmationFrom: text('confirmation_from'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    producerPrivacyGeneration: text('producer_privacy_generation'),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    check(
      'application_confirmations_producer_privacy_generation_check',
      sql`${t.producerPrivacyGeneration} IS NULL OR length(${t.producerPrivacyGeneration}) <= 128`,
    ),
    check(
      'application_confirmations_status_check',
      sql`${t.status} IN ('awaiting_confirmation','confirmation_received','updated','partially_updated','update_unknown','update_failed','cancelled','expired')`,
    ),
    uniqueIndex('application_confirmations_message_idx')
      .on(t.confirmationMessageId)
      .where(sql`${t.confirmationMessageId} IS NOT NULL`),
    uniqueIndex('application_confirmations_active_token_idx')
      .on(t.agentId, t.confirmationTokenHash)
      .where(sql`${t.status} = 'awaiting_confirmation'`),
    index('application_confirmations_pending_idx').on(t.agentId, t.status, t.expiresAt),
    index('application_confirmations_source_task_idx').on(t.sourceTaskId),
  ],
);

/**
 * User-authored autonomy rules created from the approval dialog (Always/Never) or /settings.
 * Constrained per-tool templates — never free-form predicates. Consulted by the risk gate
 * after the forbidden check, before dynamic risk functions.
 */
export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    toolName: text('tool_name').notNull(),
    /** e.g. 'sms.reply_to_owner', 'calendar.self_only_events', 'gmail.send.to_recipient' */
    templateKey: text('template_key').notNull(),
    /** Template params, e.g. { recipient: 'jon@x.is' }. */
    match: jsonb('match').notNull().default({}),
    effect: text('effect').notNull(),
    version: integer('version').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdVia: text('created_via').notNull(),
    ...timestamps,
  },
  (t) => [
    check('approval_policies_effect_check', sql`${t.effect} IN ('allow','deny')`),
    check(
      'approval_policies_created_via_check',
      sql`${t.createdVia} IN ('approval_dialog','settings','seed')`,
    ),
    index('approval_policies_tool_idx').on(t.agentId, t.toolName, t.enabled),
    uniqueIndex('approval_policies_identity_idx').on(
      t.agentId,
      t.toolName,
      t.templateKey,
      t.match,
      t.effect,
    ),
  ],
);

/**
 * Approval anomaly detection (Phase 18): a nightly scan over `tool_calls.decision`
 * flags policies auto-executing far above their baseline, outward-facing actions
 * at unusual hours, or bursts. Each row cites the triggering tool_calls. Suspend
 * reuses `approval_policies.enabled`; dismissing raises the effective baseline.
 */
export const anomalies = pgTable(
  'anomalies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    kind: text('kind').notNull(),
    /** The policy whose auto-executions triggered this — plain id, no FK (policies can be deleted). */
    policyId: uuid('policy_id'),
    toolName: text('tool_name').notNull(),
    observed: integer('observed').notNull(),
    /** The baseline/threshold the observation exceeded. */
    expected: integer('expected').notNull().default(0),
    /** tool_calls.id values that evidence this anomaly (citations). */
    toolCallIds: text('tool_call_ids').array().notNull().default([]),
    detail: text('detail').notNull().default(''),
    /** Stable window key for dedup, e.g. '2026-07-21' (daily) or a burst-start ISO minute. */
    windowLabel: text('window_label').notNull(),
    /** policyId or toolName — the dedup subject (policyId may be null). */
    subjectKey: text('subject_key').notNull(),
    status: text('status').notNull().default('open'),
    ...timestamps,
  },
  (t) => [
    check('anomalies_kind_check', sql`${t.kind} IN ('frequency','off_hours','burst')`),
    check('anomalies_status_check', sql`${t.status} IN ('open','dismissed','suspended')`),
    uniqueIndex('anomalies_dedup_idx').on(t.agentId, t.kind, t.subjectKey, t.windowLabel),
    index('anomalies_status_idx').on(t.agentId, t.status),
  ],
);

/**
 * Deterministic operational alerts for one assistant. Unlike approval
 * anomalies, these track a currently unhealthy subsystem across monitor runs
 * so a persistent incident is visible without creating a daily notification
 * storm.
 */
export const assistantHealthAlerts = pgTable(
  'assistant_health_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    detail: text('detail').notNull().default(''),
    status: text('status').notNull().default('open'),
    observationCount: integer('observation_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('assistant_health_alerts_status_check', sql`${t.status} IN ('open','resolved')`),
    uniqueIndex('assistant_health_alerts_agent_kind_idx').on(t.agentId, t.kind),
    index('assistant_health_alerts_open_idx').on(t.agentId, t.status, t.lastSeenAt),
  ],
);

/**
 * Skill library (Phase 26): Voyager-style competence memory, kept separate from
 * facts. A post-task reflection distills a named procedure — preconditions,
 * steps (advice, never auto-run code), gotchas, and provenance — from a task
 * that succeeded a non-obvious way. Embedded for retrieval into planning; carries
 * a use/success lifecycle and is revised or deprecated on failure. Only
 * owner/assistant-trust (non-tainted) work may write a skill.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    /** When this procedure applies. */
    preconditions: text('preconditions').notNull().default(''),
    /** The procedure itself — advice the model reads before acting, not executable code. */
    steps: text('steps').notNull(),
    /** Pitfalls learned the hard way. */
    gotchas: text('gotchas').notNull().default(''),
    embedding: vector('embedding', { dimensions: 1536 }),
    embeddingSpaceKey: text('embedding_space_key'),
    /** The task that taught it (plain id, no FK — a skill outlives its source task). */
    sourceTaskId: uuid('source_task_id'),
    originTrust: text('origin_trust').notNull().default('assistant'),
    ownerAuthored: boolean('owner_authored').notNull().default(false),
    useCount: integer('use_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    deprecated: boolean('deprecated').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check('skills_origin_trust_check', sql`${t.originTrust} IN ('owner','assistant')`),
    uniqueIndex('skills_name_idx').on(t.agentId, t.name),
    index('skills_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('skills_embedding_space_idx').on(t.agentId, t.embeddingSpaceKey),
    index('skills_active_idx').on(t.agentId, t.deprecated),
  ],
);

/**
 * Monotonic owner-library generation used to fence slow, model-authored skill
 * reflections against every manual create/edit/rename/deprecate/delete.
 */
export const skillLibraryRevisions = pgTable('skill_library_revisions', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Self-improvement proposals (Phase 12): a nightly eval mines failures, retries,
 * dead-letters, and cost outliers into concrete, owner-approved change proposals
 * — a model-role swap, an approval-policy adjustment, or an advisory prompt/note.
 * NEVER auto-applied: the owner approves, dismisses, and only then is an
 * applyable change (model_role, policy) enacted. `change` is kind-specific.
 */
export const improvementProposals = pgTable(
  'improvement_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    rationale: text('rationale').notNull().default(''),
    /** The concrete change to enact on approval, kind-specific (empty for advisory kinds). */
    change: jsonb('change').notNull().default({}),
    /** tool_calls.id / task.id values that evidence the pattern. */
    evidenceIds: text('evidence_ids').array().notNull().default([]),
    status: text('status').notNull().default('open'),
    ...timestamps,
  },
  (t) => [
    check(
      'improvement_proposals_kind_check',
      sql`${t.kind} IN ('model_role','policy','prompt','note')`,
    ),
    check('improvement_proposals_status_check', sql`${t.status} IN ('open','applied','dismissed')`),
    uniqueIndex('improvement_proposals_dedup_idx').on(t.agentId, t.kind, t.title),
    index('improvement_proposals_status_idx').on(t.agentId, t.status),
  ],
);

// ── Memory ───────────────────────────────────────────────────────────────────

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** knowledge: durable, similarity-retrieved. experience: expiring, recency/task-scoped. */
    category: text('category').notNull(),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull().unique(),
    embedding: vector('embedding', { dimensions: 1536 }),
    /** Provider/model/width revision for the stored vector; null means legacy/unknown. */
    embeddingSpaceKey: text('embedding_space_key'),
    importance: smallint('importance').notNull().default(3),
    /** Extracted memories are often uncertain. 0..1 */
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.7'),
    /** Untrusted-origin saves are quarantined until owner review. */
    originTrust: text('origin_trust').notNull().default('owner'),
    quarantined: boolean('quarantined').notNull().default(false),
    /** Who this fact is ABOUT (the owner contact row, or an auto-created person). */
    subjectContactId: uuid('subject_contact_id').references(() => contacts.id),
    /** Lifecycle-tree domain (PersonaTree): identity → life domains → facts. */
    domain: text('domain'),
    /** Temporal validity ("worked at X 2019–2023"): null = open-ended. */
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    /** Set by consolidation when a newer/better fact supersedes this one. */
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => memories.id),
    /** Owner clicked confirm/correct on the Profile page — consolidation never expires these lightly. */
    ownerConfirmed: boolean('owner_confirmed').notNull().default(false),
    /** Owner pinned this fact: always included in the compiled owner card. */
    pinned: boolean('pinned').notNull().default(false),
    /** Import provenance (e.g. 'takeout-mail-2021') — purge-by-source uses this. */
    source: text('source'),
    sourceTaskId: uuid('source_task_id').references(() => tasks.id),
    goalId: uuid('goal_id').references(() => goals.id),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    /** Rotation cursor: when consolidation last reviewed this fact. Null = never. */
    lastConsolidatedAt: timestamp('last_consolidated_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('memories_category_check', sql`${t.category} IN ('knowledge','experience')`),
    check(
      'memories_kind_check',
      sql`${t.kind} IN ('fact','preference','person','project','episode')`,
    ),
    check(
      'memories_origin_trust_check',
      sql`${t.originTrust} IN ('owner','known','unknown','assistant')`,
    ),
    check(
      'memories_domain_check',
      sql`${t.domain} IS NULL OR ${t.domain} IN ('identity','work','home','relationships','preferences','health','other')`,
    ),
    index('memories_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('memories_agent_category_idx').on(t.agentId, t.category, t.createdAt),
    index('memories_subject_idx').on(t.subjectContactId),
    index('memories_source_idx').on(t.source),
    uniqueIndex('memories_agent_id_id_unique_idx').on(t.agentId, t.id),
  ],
);

/**
 * A refresh receipt is one paid embedding attempt for one exact source revision
 * and target space. Prepared vectors survive process restarts; ambiguous
 * dispatches remain reviewable and are never called again automatically.
 */
export const memoryEmbeddingRefreshes = pgTable(
  'memory_embedding_refreshes',
  {
    id: text('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    targetSpaceKey: text('target_space_key').notNull(),
    targetDimensions: integer('target_dimensions').notNull(),
    observedSpaceKey: text('observed_space_key'),
    status: text('status').notNull(),
    preparedVector: vector('prepared_vector', { dimensions: 1536 }),
    privacyGeneration: text('privacy_generation'),
    claimToken: text('claim_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    unknownReason: text('unknown_reason'),
    ...timestamps,
  },
  (t) => [
    check(
      'memory_embedding_refresh_status_check',
      sql`${t.status} IN ('dispatching','prepared','unknown','retry_authorized','completed','stale','abandoned')`,
    ),
    check(
      'memory_embedding_refresh_dimensions_check',
      sql`${t.targetDimensions} BETWEEN 1 AND 1536`,
    ),
    index('memory_embedding_refresh_identity_idx').on(
      t.agentId,
      t.memoryId,
      t.targetSpaceKey,
      t.sourceHash,
      t.updatedAt,
    ),
    index('memory_embedding_refresh_owner_status_idx').on(t.agentId, t.status, t.updatedAt),
    foreignKey({
      columns: [t.agentId, t.memoryId],
      foreignColumns: [memories.agentId, memories.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Forgotten facts stay forgotten: a tombstoned content hash can never be
 * re-saved by extraction, import, or memory.save. Only the hash is kept —
 * the content itself is gone.
 */
export const memoryTombstones = pgTable('memory_tombstones', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentHash: text('content_hash').notNull().unique(),
  reason: text('reason').notNull().default('owner_forget'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Compiled owner profile card (single row, id = 1) — rebuilt by consolidation
 * and injected into planner/executor system prompts. Computed once, not
 * re-derived per task.
 */
export const ownerCard = pgTable(
  'owner_card',
  {
    id: smallint('id').primaryKey().default(1),
    content: text('content').notNull().default(''),
    compiledAt: timestamp('compiled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('owner_card_singleton_check', sql`${t.id} = 1`)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Prior/manual names used by entity resolution after a canonical rename. */
    aliases: text('aliases').array().notNull().default([]),
    emails: text('emails').array().notNull().default([]),
    phones: text('phones').array().notNull().default([]),
    relationship: text('relationship').notNull().default(''),
    trust: text('trust').notNull().default('unknown'),
    notes: text('notes').notNull().default(''),
    ...timestamps,
  },
  (t) => [check('contacts_trust_check', sql`${t.trust} IN ('owner','known','unknown')`)],
);

// ── Knowledge graph ────────────────────────────────────────────────────────

/**
 * GraphRAG is an explainable index over the existing durable-memory store, not
 * a second source of truth. A node's canonical key is stable across spelling
 * and contact-label changes; people also retain a direct link to contacts.
 */
export const knowledgeGraphEntities = pgTable(
  'knowledge_graph_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** `contact:<id>` for people, otherwise `<kind>:<normalized label>`. */
    canonicalKey: text('canonical_key').notNull(),
    label: text('label').notNull(),
    /** Owner-curated display name; extraction keeps the stable canonical key. */
    preferredLabel: text('preferred_label'),
    kind: text('kind').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    check(
      'knowledge_graph_entities_kind_check',
      sql`${t.kind} IN ('person','organization','project','place','event','date','topic')`,
    ),
    uniqueIndex('knowledge_graph_entities_agent_key_idx').on(t.agentId, t.canonicalKey),
    index('knowledge_graph_entities_contact_idx').on(t.contactId),
  ],
);

/**
 * Canonical keys that the owner merged into another graph entity. Extraction
 * resolves these aliases before it creates a node, so a curation decision
 * survives a future source edit or a backfill.
 */
export const knowledgeGraphEntityAliases = pgTable(
  'knowledge_graph_entity_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    canonicalKey: text('canonical_key').notNull(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_graph_entity_aliases_agent_key_idx').on(t.agentId, t.canonicalKey),
    index('knowledge_graph_entity_aliases_entity_idx').on(t.entityId),
  ],
);

/**
 * Per-memory extraction checkpoint. `content_hash` means edits naturally make
 * a source dirty without requiring every memory writer to know about GraphRAG.
 */
export const knowledgeGraphSources = pgTable(
  'knowledge_graph_sources',
  {
    memoryId: uuid('memory_id')
      .primaryKey()
      .references(() => memories.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    /** Tracks contact reassignment/merges separately from content edits. */
    subjectContactId: uuid('subject_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('pending'),
    /** Bump when extraction requirements change so old edges are rebuilt safely. */
    extractionVersion: integer('extraction_version').notNull().default(1),
    /** Automatic retry deadline after a transient extraction failure. */
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    check(
      'knowledge_graph_sources_status_check',
      sql`${t.status} IN ('pending','ready','failed','quarantined')`,
    ),
    index('knowledge_graph_sources_status_idx').on(t.status, t.updatedAt),
  ],
);

/**
 * A direct relationship explicitly supported by exactly one memory fact.
 * Traversal can connect these edges at read time, but never writes inferred
 * relationships back into the graph.
 */
export const knowledgeGraphRelations = pgTable(
  'knowledge_graph_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    subjectEntityId: uuid('subject_entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    predicate: text('predicate').notNull(),
    assertion: jsonb('assertion')
      .$type<{
        tense: 'present' | 'past' | 'future' | 'unspecified';
        polarity: 'positive' | 'negative';
        modality:
          | 'asserted'
          | 'possible'
          | 'conditional'
          | 'reported'
          | 'hypothetical'
          | 'unverified';
      }>()
      .notNull()
      .default(sql`'{"tense":"unspecified","polarity":"positive","modality":"unverified"}'::jsonb`),
    objectEntityId: uuid('object_entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    /** Canonical semantic claim shared by this source edge and other evidence rows. */
    assertionId: uuid('assertion_id').references(() => knowledgeGraphAssertions.id, {
      onDelete: 'set null',
    }),
    sourceMemoryId: uuid('source_memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    /** Exact source phrase supplied by the extractor for this direct edge. */
    evidenceQuote: text('evidence_quote'),
    /** Stable endpoint/predicate identity within a source memory. */
    sourceFingerprint: text('source_fingerprint').notNull(),
    /** The source fact can yield several direct relationships. */
    ordinal: smallint('ordinal').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.70'),
    /**
     * Optional temporal qualifiers as canonical date keys (`2026-03-06`,
     * `2026-03`, `--03-06`, `2026`), e.g. a job's span on a `worked_at` edge.
     * Text keys rather than date columns because partial precision is the
     * common case, and only ever populated from wording quoted in the source.
     */
    validFrom: text('valid_from'),
    validUntil: text('valid_until'),
    /** Owner curation; rejected edges are excluded from graph recall. */
    reviewStatus: text('review_status').notNull().default('unreviewed'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Durable idempotency receipt for an owner correction. */
    correctedByRelationId: uuid('corrected_by_relation_id'),
    correctionSourceContentHash: text('correction_source_content_hash'),
    correctionDisposition: text('correction_disposition'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'knowledge_graph_relations_predicate_check',
      sql`length(${t.predicate}) BETWEEN 1 AND 80`,
    ),
    check(
      'knowledge_graph_relations_assertion_check',
      sql`${t.assertion}->>'tense' IN ('present','past','future','unspecified') AND ${t.assertion}->>'polarity' IN ('positive','negative') AND ${t.assertion}->>'modality' IN ('asserted','possible','conditional','reported','hypothetical','unverified')`,
    ),
    check(
      'knowledge_graph_relations_review_status_check',
      sql`${t.reviewStatus} IN ('unreviewed','confirmed','rejected')`,
    ),
    check(
      'knowledge_graph_relations_correction_disposition_check',
      sql`${t.correctionDisposition} IS NULL OR ${t.correctionDisposition} IN ('graph_only','whole_fact')`,
    ),
    uniqueIndex('knowledge_graph_relations_source_fingerprint_idx').on(
      t.sourceMemoryId,
      t.sourceFingerprint,
    ),
    index('knowledge_graph_relations_subject_idx').on(t.agentId, t.subjectEntityId),
    index('knowledge_graph_relations_object_idx').on(t.agentId, t.objectEntityId),
    index('knowledge_graph_relations_review_idx').on(t.agentId, t.reviewStatus),
  ],
);

/** One semantic assertion, independent of the source edges that support it. */
export const knowledgeGraphAssertions = pgTable(
  'knowledge_graph_assertions',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    semanticKey: text('semantic_key').notNull(),
    subjectEntityId: uuid('subject_entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    predicate: text('predicate').notNull(),
    objectEntityId: uuid('object_entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    assertion: jsonb('assertion')
      .$type<{
        tense: 'present' | 'past' | 'future' | 'unspecified';
        polarity: 'positive' | 'negative';
        modality:
          | 'asserted'
          | 'possible'
          | 'conditional'
          | 'reported'
          | 'hypothetical'
          | 'unverified';
      }>()
      .notNull(),
    qualifiers: jsonb('qualifiers')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    validFrom: text('valid_from'),
    validUntil: text('valid_until'),
    semanticRevision: integer('semantic_revision').notNull().default(1),
    evidenceRevision: integer('evidence_revision').notNull().default(0),
    lifecycle: text('lifecycle').notNull().default('current'),
    reviewStatus: text('review_status').notNull().default('unreviewed'),
    reviewedRevision: integer('reviewed_revision'),
    reviewedPayloadHash: text('reviewed_payload_hash'),
    ownerAuthored: boolean('owner_authored').notNull().default(false),
    supersededById: uuid('superseded_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_graph_assertions_owner_key_idx').on(t.agentId, t.semanticKey),
    index('knowledge_graph_assertions_subject_idx').on(t.agentId, t.subjectEntityId, t.predicate),
    index('knowledge_graph_assertions_object_idx').on(t.agentId, t.objectEntityId, t.predicate),
    check(
      'knowledge_graph_assertions_lifecycle_check',
      sql`${t.lifecycle} IN ('current','superseded','retracted')`,
    ),
    check(
      'knowledge_graph_assertions_review_check',
      sql`${t.reviewStatus} IN ('unreviewed','confirmed','rejected')`,
    ),
    check(
      'knowledge_graph_assertions_revision_check',
      sql`${t.semanticRevision} >= 1 AND ${t.evidenceRevision} >= 0`,
    ),
  ],
);

/** Source spans and provenance are independent records; copies can corroborate one claim. */
export const knowledgeGraphAssertionEvidence = pgTable(
  'knowledge_graph_assertion_evidence',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    assertionId: uuid('assertion_id')
      .notNull()
      .references(() => knowledgeGraphAssertions.id, { onDelete: 'cascade' }),
    sourceMemoryId: uuid('source_memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    sourceFingerprint: text('source_fingerprint').notNull(),
    sourceContentHash: text('source_content_hash').notNull(),
    evidenceQuote: text('evidence_quote').notNull(),
    sourceAuthor: text('source_author').notNull().default('unknown'),
    sourceTrust: text('source_trust').notNull().default('unknown'),
    independent: boolean('independent').notNull().default(false),
    spanStart: integer('span_start'),
    spanEnd: integer('span_end'),
    extractionVersion: integer('extraction_version').notNull(),
    evidenceRevision: integer('evidence_revision').notNull().default(1),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_graph_assertion_evidence_source_idx').on(
      t.agentId,
      t.assertionId,
      t.sourceMemoryId,
      t.sourceFingerprint,
    ),
    index('knowledge_graph_assertion_evidence_lookup_idx').on(t.agentId, t.sourceMemoryId),
    check(
      'knowledge_graph_assertion_evidence_author_check',
      sql`${t.sourceAuthor} IN ('owner','other','unknown')`,
    ),
    check(
      'knowledge_graph_assertion_evidence_span_check',
      sql`${t.spanStart} IS NULL OR (${t.spanStart} >= 0 AND ${t.spanEnd} >= ${t.spanStart})`,
    ),
  ],
);

/**
 * Occasions (Phase 17): recurring dates tied to a contact — birthdays,
 * anniversaries, and custom dates the assistant surfaces at lead time. Month/day
 * drive annual recurrence; `year` is optional (often unknown for a birthday).
 * Provenance mirrors memories: an occasion learned from an untrusted email waits
 * quarantined until the owner reviews it.
 */
export const occasions = pgTable(
  'occasions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    kind: text('kind').notNull(),
    /** Free-text label for a custom occasion (e.g. "graduation"); '' otherwise. */
    label: text('label').notNull().default(''),
    month: smallint('month').notNull(),
    day: smallint('day').notNull(),
    /** Optional — a birthday's year is frequently unknown. */
    year: smallint('year'),
    recurrence: text('recurrence').notNull().default('annual'),
    /** Days before the date to start surfacing it in the brief. */
    leadDays: smallint('lead_days').notNull().default(7),
    /** Gift ideas / context for this occasion. */
    notes: text('notes').notNull().default(''),
    originTrust: text('origin_trust').notNull().default('owner'),
    quarantined: boolean('quarantined').notNull().default(false),
    ownerConfirmed: boolean('owner_confirmed').notNull().default(false),
    source: text('source'),
    ...timestamps,
  },
  (t) => [
    check('occasions_kind_check', sql`${t.kind} IN ('birthday','anniversary','custom')`),
    check('occasions_recurrence_check', sql`${t.recurrence} IN ('annual','once')`),
    check('occasions_month_check', sql`${t.month} >= 1 AND ${t.month} <= 12`),
    check('occasions_day_check', sql`${t.day} >= 1 AND ${t.day} <= 31`),
    check(
      'occasions_origin_trust_check',
      sql`${t.originTrust} IN ('owner','known','unknown','assistant')`,
    ),
    uniqueIndex('occasions_dedup_idx').on(t.agentId, t.contactId, t.kind, t.month, t.day),
    index('occasions_contact_idx').on(t.contactId),
    index('occasions_month_day_idx').on(t.month, t.day),
  ],
);

/**
 * Backstory import sources (Phase 22): one row per archive dropped into the
 * workspace import/ prefix. `source` is the provenance tag stamped on every
 * memory the import produces — re-run or purge a whole source atomically.
 */
export const importSources = pgTable(
  'import_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Provenance tag, e.g. 'takeout-mail-2021'. Stamped on memories.source. */
    source: text('source').notNull().unique(),
    /** Path under the agent workspace prefix, e.g. 'import/mail-2021.mbox'. */
    workspacePath: text('workspace_path').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    taskId: uuid('task_id').references(() => tasks.id),
    itemsTotal: integer('items_total'),
    itemsProcessed: integer('items_processed').notNull().default(0),
    memoriesSaved: integer('memories_saved').notNull().default(0),
    memoriesQuarantined: integer('memories_quarantined').notNull().default(0),
    parseDiagnostics: jsonb('parse_diagnostics').$type<ImportArchiveDiagnostics | null>(),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    check('import_sources_kind_check', sql`${t.kind} IN ('mbox','json','text')`),
    check(
      'import_sources_status_check',
      sql`${t.status} IN ('pending','running','done','failed','purged')`,
    ),
    index('import_sources_agent_source_idx').on(t.agentId, t.source),
    index('import_sources_agent_workspace_path_idx').on(t.agentId, t.workspacePath),
  ],
);

/** Direct and transitive import provenance for memories, including rewritten facts. */
export const memoryImportLineage = pgTable(
  'memory_import_lineage',
  {
    source: text('source')
      .notNull()
      .references(() => importSources.source, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    sourceUnitProvenance: jsonb('source_unit_provenance')
      .$type<ImportUnitProvenance[]>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memory_import_lineage_source_memory_idx').on(t.source, t.memoryId),
    index('memory_import_lineage_memory_idx').on(t.memoryId),
  ],
);

/** Import sources that contributed claims to an occasion, direct or derived. */
export const occasionImportLineage = pgTable(
  'occasion_import_lineage',
  {
    source: text('source')
      .notNull()
      .references(() => importSources.source, { onDelete: 'cascade' }),
    occasionId: uuid('occasion_id')
      .notNull()
      .references(() => occasions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('occasion_import_lineage_source_occasion_idx').on(t.source, t.occasionId),
    index('occasion_import_lineage_occasion_idx').on(t.occasionId),
  ],
);

// ── Models, routing, budgets ─────────────────────────────────────────────────

/**
 * Model providers the owner connected in Settings → AI providers. A model id's
 * namespace names its connection (see connectionIdForModel in
 * @assistant/core/model-router): built-in kinds use their kind as the id,
 * OpenAI-compatible gateways an owner-chosen slug.
 */
export const modelConnections = pgTable(
  'model_connections',
  {
    id: text('id').primaryKey(),
    /** openrouter | openai | vertex | openai_compatible */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    /** OpenAI-compatible gateways only. */
    baseUrl: text('base_url'),
    /** AES-GCM payload sealed with MCP_ENC_KEY; never expose this field. */
    apiKeyEncrypted: text('api_key_encrypted'),
    vertexProject: text('vertex_project'),
    vertexLocation: text('vertex_location'),
    enabled: boolean('enabled').notNull().default(true),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    check(
      'model_connections_kind_check',
      sql`${t.kind} IN ('openrouter','openai','vertex','openai_compatible')`,
    ),
  ],
);

/** Capability matrix — what the router may pick. Swapping models = editing rows. */
export const models = pgTable(
  'models',
  {
    /** OpenRouter model id, e.g. 'minimax/minimax-m2.7'. */
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    /** { tools, vision, json, streaming, thinking } */
    capabilities: jsonb('capabilities').notNull().default({}),
    /** USD per million tokens — hints for routing, not billing (usage.cost is authoritative). */
    promptCostPerMTok: numeric('prompt_cost_per_mtok', { precision: 10, scale: 4 }),
    completionCostPerMTok: numeric('completion_cost_per_mtok', { precision: 10, scale: 4 }),
    latencyClass: text('latency_class').notNull().default('medium'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [check('models_latency_class_check', sql`${t.latencyClass} IN ('fast','medium','slow')`)],
);

export const modelRoles = pgTable(
  'model_roles',
  {
    role: text('role').primaryKey(),
    primaryModel: text('primary_model')
      .notNull()
      .references(() => models.id),
    fallbackModel: text('fallback_model')
      .notNull()
      .references(() => models.id),
    params: jsonb('params').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'model_roles_role_check',
      sql`${t.role} IN ('plan','classify','extract','draft','reason','rewrite','embed','batch','voice')`,
    ),
  ],
);

/** Before/after snapshots make routing changes reviewable and conditionally reversible. */
export const modelRoleRevisions = pgTable(
  'model_role_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role').notNull(),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    source: text('source').notNull(),
    baselineKnown: boolean('baseline_known').notNull(),
    requiresOwnerReview: boolean('requires_owner_review').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('model_role_revisions_role_created_idx').on(t.role, t.createdAt)],
);

/** Usage metering — one row per model call; budget guard sums cost_usd. */
export const modelCalls = pgTable(
  'model_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id),
    role: text('role').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Budget-accounting cost; cost_events.evidence identifies reported versus estimated cost. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    finishReason: text('finish_reason'),
    openrouterGenerationId: text('openrouter_generation_id'),
    /** Cloud Run runtime identity; null locally or when release identity is not configured. */
    runtimeRevision: text('runtime_revision'),
    runtimeReleaseSha: text('runtime_release_sha'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('model_calls_created_idx').on(t.createdAt),
    index('model_calls_task_idx').on(t.taskId),
  ],
);

/**
 * What a model was actually asked and what it actually said.
 *
 * `model_calls` above is a cost ledger: it proves a call happened and what it
 * spent, but it keeps neither the prompt nor the response, so no question about
 * answer *quality* can be asked of production at all. This table is the missing
 * half, and it is off by default because it necessarily holds the owner's mail,
 * calendar and conversations: `LLM_AUDIT_CAPTURE=off|redacted|full` decides
 * whether a row is written and whether identifiers are scrubbed first, and
 * `LLM_AUDIT_RETENTION_DAYS` bounds how long it is kept. Rows are telemetry,
 * never an input to the assistant's own reasoning — nothing reads this table
 * back into a prompt.
 */
export const modelCallAudit = pgTable(
  'model_call_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The cost-ledger row this records, when metering got far enough to make one. */
    modelCallId: uuid('model_call_id').references(() => modelCalls.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id),
    role: text('role').notNull(),
    model: text('model').notNull(),
    /** Which router entry point produced it: generate | stream | step | object. */
    method: text('method').notNull(),
    /** How the stored text was treated on write, so a reader knows what it holds. */
    capture: text('capture').notNull(),
    systemPrompt: text('system_prompt'),
    input: text('input'),
    output: text('output'),
    /** True when any stored field hit the per-field character cap. */
    truncated: boolean('truncated').notNull().default(false),
    finishReason: text('finish_reason'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('model_call_audit_created_idx').on(t.createdAt),
    index('model_call_audit_role_idx').on(t.role),
    index('model_call_audit_task_idx').on(t.taskId),
    check('model_call_audit_capture_check', sql`${t.capture} IN ('redacted','full')`),
  ],
);

/**
 * Every billable event, whatever it costs money for (Phase 27). Model calls,
 * embeddings, SMS, job-seconds — one ledger, one dashboard number. Sources
 * must stay in sync with the CI wiring check in @assistant/core cost.ts.
 */
export const SPEND_SOURCES = [
  'model',
  'embedding',
  'twilio_sms',
  'twilio_voice_min',
  'cloud_run_job_sec',
  'storage_gb_month',
  'external_api',
] as const;
export type SpendSource = (typeof SPEND_SOURCES)[number];

export const costEvents = pgTable(
  'cost_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    evidence: jsonb('evidence')
      .$type<import('@assistant/persistence').CostEvidence>()
      .notNull()
      .default({ basis: 'unknown' }),
    taskId: uuid('task_id').references(() => tasks.id),
    toolCallId: uuid('tool_call_id').references(() => toolCalls.id),
    /** How much of the unit was consumed (tokens, messages, seconds, GB-months). */
    quantity: numeric('quantity', { precision: 14, scale: 4 }),
    unit: text('unit'),
    unitPriceUsd: numeric('unit_price_usd', { precision: 12, scale: 8 }),
    usd: numeric('usd', { precision: 10, scale: 6 }).notNull(),
    description: text('description').notNull().default(''),
    /** Set when this event reconciles a pre-flight reservation. */
    reservationId: uuid('reservation_id').references((): AnyPgColumn => costReservations.id),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'cost_events_source_check',
      sql`${t.source} IN ('model','embedding','twilio_sms','twilio_voice_min','cloud_run_job_sec','storage_gb_month','external_api')`,
    ),
    index('cost_events_created_idx').on(t.createdAt),
    index('cost_events_task_idx').on(t.taskId),
    index('cost_events_source_idx').on(t.source, t.createdAt),
    uniqueIndex('cost_events_reservation_idx')
      .on(t.reservationId)
      .where(sql`${t.reservationId} IS NOT NULL`),
    uniqueIndex('cost_events_idempotency_key_idx')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

/**
 * Pre-flight budget reservations: expensive actions (job launches, outbound
 * calls, batch imports) reserve their estimate BEFORE starting — post-hoc
 * metering alone can't prevent overshoot. Held reservations count against
 * remaining budget until reconciled to actuals or released.
 */
export const costReservations = pgTable(
  'cost_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id),
    source: text('source').notNull(),
    estimatedUsd: numeric('estimated_usd', { precision: 10, scale: 6 }).notNull(),
    status: text('status').notNull().default('held'),
    actualUsd: numeric('actual_usd', { precision: 10, scale: 6 }),
    attemptStartedAt: timestamp('attempt_started_at', { withTimezone: true }),
    attemptMetadata: jsonb('attempt_metadata'),
    unknownReason: text('unknown_reason'),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'cost_reservations_status_check',
      sql`${t.status} IN ('held','dispatching','unknown','reconciled','released')`,
    ),
    index('cost_reservations_status_idx').on(t.status, t.createdAt),
    index('cost_reservations_task_idx').on(t.taskId, t.status),
  ],
);

/** Unit prices for non-model spend (model costs come from OpenRouter usage.cost). */
export const rateTable = pgTable('rate_table', {
  /** e.g. 'twilio_sms', 'cloud_run_job_sec', 'embedding_mtok'. */
  key: text('key').primaryKey(),
  unit: text('unit').notNull(),
  unitPriceUsd: numeric('unit_price_usd', { precision: 12, scale: 8 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const budgets = pgTable(
  'budgets',
  {
    scope: text('scope').primaryKey(),
    limitUsd: numeric('limit_usd', { precision: 8, scale: 2 }).notNull(),
    softPct: integer('soft_pct').notNull().default(80),
    onSoft: text('on_soft').notNull().default('degrade'),
    onHard: text('on_hard').notNull().default('park'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('budgets_scope_check', sql`${t.scope} IN ('task_default','daily','monthly')`),
    check('budgets_on_soft_check', sql`${t.onSoft} IN ('degrade')`),
    check('budgets_on_hard_check', sql`${t.onHard} IN ('park','block')`),
  ],
);

/** Resumable bounded maintenance scans; deleting a cursor safely restarts its scan. */
export const maintenanceCursors = pgTable('maintenance_cursors', {
  name: text('name').primaryKey(),
  cursor: text('cursor'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Caching & rate limiting ──────────────────────────────────────────────────

export const toolCache = pgTable(
  'tool_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    toolName: text('tool_name').notNull(),
    result: jsonb('result').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('tool_cache_expires_idx').on(t.expiresAt)],
);

export const rateLimits = pgTable('rate_limits', {
  /** 'tool:gmail.send' | 'task' | 'channel:sms' | ... */
  scope: text('scope').primaryKey(),
  maxPerHour: integer('max_per_hour'),
  maxPerDay: integer('max_per_day'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Voice ────────────────────────────────────────────────────────────────────

export const writingSamples = pgTable(
  'writing_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    register: text('register').notNull(),
    text: text('text').notNull(),
    context: text('context').notNull().default(''),
    embedding: vector('embedding', { dimensions: 1536 }),
    embeddingSpaceKey: text('embedding_space_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'writing_samples_register_check',
      sql`${t.register} IN ('email_professional','email_casual','sms','chat')`,
    ),
    index('writing_samples_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('writing_samples_embedding_space_idx').on(t.embeddingSpaceKey),
  ],
);

/** Single row (id = 1 enforced by check). */
export const voiceProfile = pgTable(
  'voice_profile',
  {
    id: smallint('id').primaryKey().default(1),
    description: text('description').notNull().default(''),
    dos: jsonb('dos').notNull().default([]),
    donts: jsonb('donts').notNull().default([]),
    signature: text('signature').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('voice_profile_singleton_check', sql`${t.id} = 1`)],
);

// ── Channel sync state & scheduling ──────────────────────────────────────────

export const gmailSyncState = pgTable('gmail_sync_state', {
  mailbox: text('mailbox').primaryKey(),
  lastHistoryId: bigint('last_history_id', { mode: 'bigint' }),
  /** Durable bounded-drain cursor for Gmail history/inbox reconciliation pages. */
  cursor: jsonb('cursor').notNull().default({}),
  watchExpiration: timestamp('watch_expiration', { withTimezone: true }),
  /** Fencing token for a Gmail drain; advanced under the session advisory lock. */
  leaseHolder: text('lease_holder'),
  leaseGeneration: integer('lease_generation').notNull().default(0),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The verdict on one ingested message: what it was about, how much it mattered,
 * and whether that earned a triage task.
 *
 * This exists because in `forwarded` ingest mode nothing is dropped any more —
 * the pipeline stores everything and *decides* rather than filtering. That
 * decision has to be durable for three reasons: the digest reports on it, the
 * memory extraction job walks it (rather than sampling conversations, which
 * badly under-samples a real inbox), and re-delivery must not re-score or
 * re-enqueue. `channelMessageId` carries the same `gmail:<id>` value used as the
 * task's `externalEventId`, so the unique index is the idempotency fence.
 */
export const emailIngest = pgTable(
  'email_ingest',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /** `gmail:<messageId>` — matches tasks.external_event_id for the triage task. */
    channelMessageId: text('channel_message_id').notNull(),
    fromEmail: text('from_email').notNull(),
    /** Display name from the `From` header; null when the sender sent none. */
    fromName: text('from_name'),
    subject: text('subject').notNull().default(''),
    /**
     * Trust derived from the SENDER, kept separate from the task's trust (which
     * in forwarded mode is the OWNER, who directed the ingest). This is the axis
     * memory quarantine and importance scoring read.
     */
    contentTrust: text('content_trust').notNull().default('unknown'),
    /** Receiver-authenticated (aligned SPF/DKIM/DMARC). Forwarding often breaks SPF. */
    authenticated: boolean('authenticated').notNull().default(false),
    /** Direct versus owner-forwarded policy; source authenticity remains a separate axis. */
    ingestMode: text('ingest_mode').notNull().default('direct'),
    /** MIME-aware provenance summary used by voice admission; contains no quoted text. */
    hasExternalOrUnknown: boolean('has_external_or_unknown').notNull().default(true),
    /** Immutable expected observer registry, including [] when no observers were enabled. */
    observerRegistrySnapshot: jsonb('observer_registry_snapshot').$type<Array<{
      key: string;
      version: number;
      workClass: string;
    }> | null>(),
    observerRegistryHash: text('observer_registry_hash'),
    /** Immutable canonical body pointer chosen with the first atomic admission. */
    admittedSourceKind: text('admitted_source_kind'),
    admittedSourceId: text('admitted_source_id'),
    directRouting: text('direct_routing').$type<DirectEmailRouting | null>(),
    directRecoveryReason: text('direct_recovery_reason').$type<DirectEmailRecoveryReason | null>(),
    emailContentProvenance: jsonb(
      'email_content_provenance',
    ).$type<EmailContentProvenanceSnapshot | null>(),
    /** Paid automated-sender classification checkpoint; ambiguous outcomes are terminal. */
    classificationStatus: text('classification_status').notNull().default('not_required'),
    classificationClaimToken: text('classification_claim_token'),
    preparedClassification: jsonb('prepared_classification').$type<{ automated: boolean } | null>(),
    /** Distinguishes paid provider uncertainty from a prepared deterministic fallback. */
    scoreOutcome: text('score_outcome').notNull().default('model_prepared'),
    category: text('category').notNull().default('other'),
    importance: smallint('importance').notNull().default(1),
    actionable: boolean('actionable').notNull().default(false),
    /** One short sentence explaining the score, shown in the digest. */
    reason: text('reason').notNull().default(''),
    /** Dates the scorer found: [{ iso, what }] — the raw material for occasions. */
    dates: jsonb('dates').notNull().default([]),
    /** Stable source identity for staged forwarded-ingest recovery. */
    mailbox: text('mailbox').notNull().default(''),
    providerMessageId: text('provider_message_id'),
    /** RFC Message-ID header, retained as provider/source provenance. */
    sourceMessageId: text('source_message_id'),
    /** Provider thread and timestamp let the owner review only the current source. */
    providerThreadId: text('provider_thread_id'),
    providerReceivedAt: timestamp('provider_received_at', { withTimezone: true }),
    /** Source-quoted security event details; null when attribution is uncertain. */
    securityEvidence: jsonb('security_evidence').$type<{
      providerIncidentRef?: string;
      eventType?: string;
      affectedAccount?: string;
      eventAt?: string;
      device?: string;
      location?: string;
      recoveryCopyOf?: string;
      evidenceQuote?: string;
    } | null>(),
    securityIncidentId: uuid('security_incident_id'),
    /** Classifier output starts unknown; only an explicit owner decision changes it. */
    obligationStatus: text('obligation_status').notNull().default('unknown'),
    obligationVersion: integer('obligation_version').notNull().default(0),
    obligationDecision: text('obligation_decision'),
    obligationDecisionAt: timestamp('obligation_decision_at', { withTimezone: true }),
    obligationSnoozedUntil: timestamp('obligation_snoozed_until', { withTimezone: true }),
    /** Durable pipeline checkpoint; old/direct rows default to complete. */
    pipelineStage: text('pipeline_stage').notNull().default('complete'),
    /** A scoring claim without a prepared verdict is never blindly retried. */
    scoreStatus: text('score_status').notNull().default('prepared'),
    scoreClaimToken: text('score_claim_token'),
    cardCandidate: boolean('card_candidate').notNull().default(false),
    nextStep: text('next_step'),
    messagePersisted: boolean('message_persisted').notNull().default(true),
    triageTaskId: uuid('triage_task_id'),
    /** A triage task was enqueued (i.e. the score cleared the threshold). */
    triaged: boolean('triaged').notNull().default(false),
    /** Set once memory extraction has walked this row. */
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    /** Paid structured output retained until all dependent memory writes succeed. */
    preparedExtraction: jsonb('prepared_extraction'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_ingest_message_idx').on(t.channelMessageId),
    uniqueIndex('email_ingest_owner_source_idx').on(t.agentId, t.mailbox, t.providerMessageId),
    index('email_ingest_agent_created_idx').on(t.agentId, t.createdAt),
    index('email_ingest_thread_current_idx').on(
      t.agentId,
      t.providerThreadId,
      t.providerReceivedAt,
    ),
    index('email_ingest_security_incident_idx').on(t.agentId, t.securityIncidentId),
    index('email_ingest_source_message_idx').on(t.agentId, t.sourceMessageId),
    // The extraction job's scan: un-extracted rows, oldest first.
    index('email_ingest_extract_idx').on(t.extractedAt, t.createdAt),
    check('email_ingest_importance_check', sql`${t.importance} BETWEEN 1 AND 5`),
    check(
      'email_ingest_content_trust_check',
      sql`${t.contentTrust} IN ('owner','known','unknown')`,
    ),
    check('email_ingest_mode_check', sql`${t.ingestMode} IN ('direct','forwarded')`),
    check(
      'email_ingest_classification_status_check',
      sql`${t.classificationStatus} IN ('pending','in_progress','prepared','unknown','not_required')`,
    ),
    check(
      'email_ingest_score_outcome_check',
      sql`${t.scoreOutcome} IN ('model_prepared','deterministic_no_model','fallback_committed_unknown','provider_outcome_unknown','budget_blocked')`,
    ),
    check(
      'email_ingest_direct_routing_check',
      sql`${t.directRouting} IS NULL OR ${t.directRouting} IN ('application_confirmation','email_triage','needs_attention')`,
    ),
    check(
      'email_ingest_direct_recovery_reason_check',
      sql`${t.directRecoveryReason} IS NULL OR ${t.directRecoveryReason} IN ('provider_message_missing','provider_access_denied','provider_temporarily_unavailable','checkpoint_inconsistent')`,
    ),
    check(
      'email_ingest_admitted_source_kind_check',
      sql`${t.admittedSourceKind} IS NULL OR ${t.admittedSourceKind} IN ('message','automated_source')`,
    ),
    check(
      'email_ingest_admitted_source_pair_check',
      sql`(${t.admittedSourceKind} IS NULL) = (${t.admittedSourceId} IS NULL)`,
    ),
  ],
);

/** A canonical email body used only when retained automated direct mail has no transcript row. */
export const emailObserverSources = pgTable(
  'email_observer_sources',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    channelMessageId: text('channel_message_id').notNull(),
    body: text('body').notNull(),
    privacyGeneration: text('privacy_generation'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_observer_source_owner_key_idx').on(t.agentId, t.sourceKey),
    uniqueIndex('email_observer_source_channel_message_idx').on(t.channelMessageId),
    check('email_observer_source_body_length_check', sql`length(${t.body}) <= 20000`),
  ],
);

/** Durable per-owner, per-source, versioned observer state. No source body is copied here. */
export const emailObserverWork = pgTable(
  'email_observer_work',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    channelMessageId: text('channel_message_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    observerKey: text('observer_key').notNull(),
    observerVersion: integer('observer_version').notNull(),
    workClass: text('work_class').notNull(),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    claimToken: text('claim_token'),
    claimGeneration: integer('claim_generation').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    privacyGeneration: text('privacy_generation'),
    budgetKey: text('budget_key'),
    budgetWindowStart: timestamp('budget_window_start', { withTimezone: true }),
    budgetReserved: boolean('budget_reserved').notNull().default(false),
    preparedResult: jsonb('prepared_result'),
    deliveryKey: text('delivery_key'),
    lastErrorCode: text('last_error_code'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_observer_work_owner_source_key_idx').on(
      t.agentId,
      t.sourceKey,
      t.observerKey,
      t.observerVersion,
    ),
    index('email_observer_work_due_idx').on(t.agentId, t.status, t.leaseExpiresAt, t.createdAt),
    index('email_observer_work_source_idx').on(t.agentId, t.sourceKey),
    check(
      'email_observer_work_status_check',
      sql`${t.status} IN ('pending','claimed','prepared','complete','no_op','retryable_failed','unknown','skipped_erased','skipped_budget')`,
    ),
    check(
      'email_observer_work_class_check',
      sql`${t.workClass} IN ('idempotent_db','paid_ambiguous','external_provider')`,
    ),
    check(
      'email_observer_work_source_kind_check',
      sql`${t.sourceKind} IN ('message','automated_source')`,
    ),
    check('email_observer_work_attempts_check', sql`${t.attemptCount} >= 0`),
    check('email_observer_work_generation_check', sql`${t.claimGeneration} >= 0`),
    check(
      'email_observer_work_result_size_check',
      sql`octet_length(${t.preparedResult}::text) <= 100000`,
    ),
  ],
);

/**
 * Durable, opaque-object custody for email attachment publication. Erased rows
 * remain as minimal tombstones so a late conditional marker request can still
 * be discovered and removed without guessing which object generation is ours.
 */
export const emailAttachmentCustodies = pgTable(
  'email_attachment_custodies',
  {
    id: uuid('id').primaryKey(),
    // Restrict owner deletion while any opaque object-custody tombstone remains.
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    observerWorkId: uuid('observer_work_id'),
    claimToken: text('claim_token'),
    claimGeneration: integer('claim_generation').notNull(),
    privacyGeneration: text('privacy_generation'),
    channelMessageId: text('channel_message_id'),
    providerMessageId: text('provider_message_id'),
    providerAttachmentId: text('provider_attachment_id'),
    manifestDigest: text('manifest_digest'),
    attachmentOrdinal: integer('attachment_ordinal').notNull(),
    workspacePath: text('workspace_path').notNull(),
    filename: text('filename'),
    mime: text('mime'),
    advertisedBytes: integer('advertised_bytes').notNull(),
    actualBytes: integer('actual_bytes'),
    sha256: text('sha256'),
    markerGeneration: text('marker_generation'),
    objectGeneration: text('object_generation'),
    status: text('status').notNull().default('marker_pending'),
    fileId: uuid('file_id'),
    documentId: uuid('document_id'),
    duplicateDocumentId: uuid('duplicate_document_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_attachment_custody_source_idx').on(
      t.agentId,
      t.observerWorkId,
      t.providerAttachmentId,
    ),
    uniqueIndex('email_attachment_custody_path_idx').on(t.workspacePath),
    index('email_attachment_custody_cleanup_idx').on(t.agentId, t.status, t.updatedAt),
    check('email_attachment_custody_generation_check', sql`${t.claimGeneration} >= 0`),
    check('email_attachment_custody_ordinal_check', sql`${t.attachmentOrdinal} BETWEEN 0 AND 7`),
    check(
      'email_attachment_custody_advertised_bytes_check',
      sql`${t.advertisedBytes} BETWEEN 0 AND 26214400`,
    ),
    check(
      'email_attachment_custody_actual_bytes_check',
      sql`${t.actualBytes} IS NULL OR ${t.actualBytes} BETWEEN 1 AND 26214400`,
    ),
    check(
      'email_attachment_custody_manifest_check',
      sql`${t.status} = 'erased' OR ${t.manifestDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'email_attachment_custody_sha_check',
      sql`${t.sha256} IS NULL OR ${t.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'email_attachment_custody_status_check',
      sql`${t.status} IN ('marker_pending','marker_ready','content_authorized','object_written','catalogued','cleanup_pending','duplicate_cleaned','erased')`,
    ),
    check(
      'email_attachment_custody_path_check',
      sql`${t.workspacePath} ~ '^email-attachments/custody/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'email_attachment_custody_private_fields_check',
      sql`${t.status} <> 'erased' OR (${t.observerWorkId} IS NULL AND ${t.claimToken} IS NULL AND ${t.privacyGeneration} IS NULL AND ${t.channelMessageId} IS NULL AND ${t.providerMessageId} IS NULL AND ${t.providerAttachmentId} IS NULL AND ${t.manifestDigest} IS NULL AND ${t.filename} IS NULL AND ${t.mime} IS NULL AND ${t.advertisedBytes} = 0 AND ${t.actualBytes} IS NULL AND ${t.sha256} IS NULL AND ${t.fileId} IS NULL AND ${t.documentId} IS NULL AND ${t.duplicateDocumentId} IS NULL)`,
    ),
  ],
);

/** Atomic paid-observer claim budget, independent of deep-triage admission. */
export const emailObserverBudgets = pgTable(
  'email_observer_budgets',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    observerKey: text('observer_key').notNull(),
    utcWindowStart: timestamp('utc_window_start', { withTimezone: true }).notNull(),
    utcWindowEnd: timestamp('utc_window_end', { withTimezone: true }).notNull(),
    reservedCount: integer('reserved_count').notNull().default(0),
    limit: integer('limit').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_observer_budget_owner_window_idx').on(
      t.agentId,
      t.observerKey,
      t.utcWindowStart,
    ),
    check('email_observer_budget_count_check', sql`${t.reservedCount} >= 0`),
    check('email_observer_budget_limit_check', sql`${t.limit} BETWEEN 0 AND 1000`),
  ],
);

/**
 * A bounded, owner-scoped identity for one high-confidence security event.
 * Source messages stay in email_ingest; the separate source table below links
 * every constituent message without duplicating its private body.
 */
export const securityIncidents = pgTable(
  'security_incidents',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    incidentKey: text('incident_key').notNull(),
    confidence: text('confidence').notNull(),
    revision: integer('revision').notNull().default(0),
    disposition: text('disposition').notNull().default('unreviewed'),
    decisionRevision: integer('decision_revision'),
    decisionReason: text('decision_reason'),
    materialChangeReason: text('material_change_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_incidents_owner_key_idx').on(t.agentId, t.incidentKey),
    check(
      'security_incidents_confidence_check',
      sql`${t.confidence} IN ('provider-reference','recovery-reference','source-message','separate-source')`,
    ),
    check(
      'security_incidents_disposition_check',
      sql`${t.disposition} IN ('unreviewed','expected','dismissed')`,
    ),
    check('security_incidents_revision_check', sql`${t.revision} >= 0`),
  ],
);

/** Each source observation is retained and linked to its incident. */
export const securityIncidentSources = pgTable(
  'security_incident_sources',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => securityIncidents.id, { onDelete: 'cascade' }),
    channelMessageId: text('channel_message_id').notNull(),
    sourceMessageId: text('source_message_id'),
    mailboxHash: text('mailbox_hash').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_incident_sources_owner_message_idx').on(t.agentId, t.channelMessageId),
    index('security_incident_sources_incident_idx').on(t.agentId, t.incidentId, t.observedAt),
    index('security_incident_sources_evidence_idx').on(
      t.agentId,
      t.incidentId,
      t.evidenceFingerprint,
    ),
  ],
);

/** One cross-surface attention claim per incident revision. */
export const securityIncidentAttention = pgTable(
  'security_incident_attention',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => securityIncidents.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    producer: text('producer').notNull(),
    deliveryStatus: text('delivery_status').notNull().default('claimed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_incident_attention_revision_idx').on(t.agentId, t.incidentId, t.revision),
    check(
      'security_incident_attention_producer_check',
      sql`${t.producer} IN ('arrival','pulse','briefing')`,
    ),
    check(
      'security_incident_attention_delivery_check',
      sql`${t.deliveryStatus} IN ('claimed','accepted','unknown')`,
    ),
  ],
);

/**
 * Latest verified lifecycle snapshot for an explicitly identified booking.
 * The booking key is a one-way digest of a reference printed in source mail;
 * raw dates/evidence stay with the source ingest row and can be erased there.
 */
export const emailBookingOccurrences = pgTable(
  'email_booking_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    bookingKey: text('booking_key').notNull(),
    lifecycle: text('lifecycle').notNull(),
    dates: jsonb('dates').notNull().default([]),
    sourceChannelMessageId: text('source_channel_message_id').notNull(),
    sourceReceivedAt: timestamp('source_received_at', { withTimezone: true }).notNull(),
    sourceAuthenticated: boolean('source_authenticated').notNull().default(false),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_booking_occurrences_owner_key_idx').on(t.agentId, t.bookingKey),
    index('email_booking_occurrences_source_idx').on(t.agentId, t.sourceChannelMessageId),
    check(
      'email_booking_occurrences_lifecycle_check',
      sql`${t.lifecycle} IN ('confirmed','cancelled','rescheduled','tentative')`,
    ),
  ],
);

/**
 * "I noticed X — want me to Y?"
 *
 * Approvals and needs-attention could not carry this. An approval attaches to a
 * tool call that is already queued and frozen, so it cannot represent work that
 * does not exist yet; needs-attention is a terminal status with nothing on the
 * other side of it. A suggestion is the missing middle: inert text until the
 * owner promotes it, and promotion enqueues an ordinary task that runs the
 * whole normal pipeline — so a suggestion never authored an outward action, it
 * only ever asked.
 *
 * That is what keeps the anticipation layer's invariant intact while letting
 * untrusted content *propose*: the proposal is a sentence, and the owner is the
 * one who turns it into work.
 */
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Where it was surfaced, so accepting can continue in the same thread. */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /** What was noticed, in the owner's terms. */
    summary: text('summary').notNull(),
    /** The planner seed run verbatim on acceptance — never a frozen tool call. */
    proposedAction: text('proposed_action').notNull(),
    /** What produced it: 'briefing' today, a `suggest`-tier watch later. */
    origin: text('origin').notNull().default('briefing'),
    /** Booking lineage for mail-derived proposals; null for all other suggestions. */
    bookingKey: text('booking_key'),
    bookingVersion: integer('booking_version'),
    bookingCancellation: jsonb('booking_cancellation').$type<{
      calendarEventId: string;
      bookingIdentity: string;
    } | null>(),
    /**
     * What it was noticed from (e.g. `gmail:<id>:calendar`). Unique per agent,
     * so re-running the producer re-proposes nothing the owner already saw —
     * or already dismissed.
     */
    sourceRef: text('source_ref').notNull(),
    status: text('status').notNull().default('pending'),
    /** The task acceptance created, for tracing the proposal to its work. */
    acceptedTaskId: uuid('accepted_task_id').references((): AnyPgColumn => tasks.id),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('suggestions_source_idx').on(t.agentId, t.sourceRef),
    index('suggestions_status_idx').on(t.agentId, t.status, t.expiresAt),
    index('suggestions_booking_status_idx').on(t.agentId, t.bookingKey, t.status),
    check(
      'suggestions_status_check',
      sql`${t.status} IN ('pending','accepted','dismissed','snoozed','expired','superseded')`,
    ),
  ],
);

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    /** Template for the task the tick creates: { type, trigger, budgetUsdLimit, ... } */
    taskTemplate: jsonb('task_template').notNull().default({}),
    /** Seed identity/version is separate from the editable display name. */
    seedTemplateKey: text('seed_template_key'),
    seedTemplateRevision: integer('seed_template_revision'),
    seedDefinition: jsonb('seed_definition'),
    seedReviewRequired: boolean('seed_review_required').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('schedules_enabled_next_idx').on(t.enabled, t.nextRunAt),
    uniqueIndex('schedules_agent_name_idx').on(t.agentId, t.name),
  ],
);

// ── Watchers (anticipation layer) ────────────────────────────────────────────

/**
 * An owner-defined condition the assistant waits on ("tell me if X emails").
 * See docs/anticipation-layer.md. The tiers are enforced by the CHECK below,
 * not by prompt: 'notify' only *informs* the owner; 'suggest' additionally
 * drafts a one-tap proposal from the trigger — as reference data, through a
 * model step holding no tools, so untrusted content still never authors an
 * outward action. 'frozen_action' remains unbuilt.
 */
export const watches = pgTable(
  'watches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Where notices for this watch are posted (a chat the owner can see). */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    kind: text('kind').notNull().default('email'),
    tier: text('tier').notNull().default('notify'),
    name: text('name').notNull(),
    /**
     * Match spec. email: { expectedSenderEmails: string[], keywords?: string[] }.
     * web: { url: string, mode: 'change'|'contains'|'absent', pattern?: string }.
     */
    match: jsonb('match').notNull().default({}),
    status: text('status').notNull().default('active'),
    fireCount: integer('fire_count').notNull().default(0),
    /** Stop after this many fires; null = fire on every match until expiry. */
    maxFires: integer('max_fires'),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    /**
     * Polling watches only (kind='web'): when this watch is next due to be
     * polled, and how often. Null for event-driven ('email') watches.
     */
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    pollIntervalSeconds: integer('poll_interval_seconds'),
    /**
     * Poller-owned observation state, e.g. { fingerprint, present, failures }
     * for a web watch. Opaque to everything but the matcher; empty for email.
     */
    state: jsonb('state').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    check('watches_kind_check', sql`${t.kind} IN ('email','web')`),
    check('watches_tier_check', sql`${t.tier} IN ('notify','suggest')`),
    check('watches_status_check', sql`${t.status} IN ('active','fired','expired','cancelled')`),
    index('watches_active_idx').on(t.agentId, t.status, t.kind, t.expiresAt),
    // The web-watch poller's due-selection/claim query.
    index('watches_due_web_idx').on(t.status, t.kind, t.nextPollAt),
  ],
);

/**
 * One recorded firing of a watch. Unique per (watch, trigger) so at-least-once
 * delivery and Gmail history replays never double-notify — the same
 * message-level idempotency the confirmation ledger relies on.
 */
export const watchFires = pgTable(
  'watch_fires',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    watchId: uuid('watch_id')
      .notNull()
      .references(() => watches.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Dedupe key for the triggering event, e.g. 'gmail:<messageId>'. */
    triggerRef: text('trigger_ref').notNull(),
    summary: text('summary').notNull().default(''),
    /**
     * Bounded excerpt of the trigger content (subject + first ~2 KB of body),
     * captured at fire time for the suggest tier's compose step. Tainted by
     * construction: it is third-party text, only ever read as reference data
     * by a model step that holds no tools, and never shown raw to the owner.
     */
    excerpt: text('excerpt').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watch_fires_watch_trigger_idx').on(t.watchId, t.triggerRef)],
);

/** Independently replayable side effects committed atomically with a watch fire. */
export const watchFireEffects = pgTable(
  'watch_fire_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    watchId: uuid('watch_id').notNull(),
    fireId: uuid('fire_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    result: jsonb('result'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('watch_fire_effects_fire_kind_idx').on(t.fireId, t.kind),
    uniqueIndex('watch_fire_effects_agent_idem_idx').on(t.agentId, t.idempotencyKey),
    index('watch_fire_effects_pending_idx').on(t.agentId, t.status, t.createdAt),
    check(
      'watch_fire_effects_kind_check',
      sql`${t.kind} IN ('dashboard_notice','owner_notification','suggestion_enqueue','suggestion_message')`,
    ),
    check(
      'watch_fire_effects_status_check',
      sql`${t.status} IN ('pending','sending','delivered','failed','unknown','skipped')`,
    ),
  ],
);

// ── Proactive delivery policy ────────────────────────────────────────────────

/**
 * When the assistant may INTERRUPT the owner (SMS/push) versus only post to
 * the dashboard. Singleton per agent; an absent row means no quiet hours and
 * no cap — the shipped default, so nothing changes until the owner opts in.
 *
 * Quiet hours are minutes after midnight in the agent's timezone; a start
 * after the end means an overnight window (22:00→07:00). Both null = off.
 */
export const notificationPrefs = pgTable(
  'notification_prefs',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    quietStartMin: integer('quiet_start_min'),
    quietEndMin: integer('quiet_end_min'),
    /** Most ambient pings allowed out-of-band per owner-local day; null = no cap. */
    ambientDailyCap: integer('ambient_daily_cap'),
    ...timestamps,
  },
  (t) => [
    check('notification_prefs_quiet_start_range', sql`${t.quietStartMin} between 0 and 1439`),
    check('notification_prefs_quiet_end_range', sql`${t.quietEndMin} between 0 and 1439`),
    check('notification_prefs_cap_positive', sql`${t.ambientDailyCap} > 0`),
  ],
);

/**
 * One row per out-of-band ping the policy evaluated, delivered or suppressed.
 * The cap counts delivered rows from this ledger, and the owner-facing "what
 * was held" line reads the suppressed ones. Purged after 90 days like the
 * other operational counters — it is telemetry, not history.
 */
export const proactivePings = pgTable(
  'proactive_pings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    urgency: text('urgency').notNull(),
    channel: text('channel').notNull(),
    delivered: boolean('delivered').notNull(),
    /** Suppression reason ('quiet-hours' | 'daily-cap') when not delivered. */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('proactive_pings_urgency_check', sql`${t.urgency} IN ('ambient','interrupt')`),
    index('proactive_pings_agent_created_idx').on(t.agentId, t.createdAt),
  ],
);

/**
 * One durable row per concrete destination leg. A claim that expires while
 * sending is reconciled to `unknown`, never resent automatically: the
 * provider may have accepted it before the worker died.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    deliveryKey: text('delivery_key').notNull(),
    legKey: text('leg_key').notNull(),
    adapter: text('adapter').notNull(),
    status: text('status').notNull().default('pending'),
    /** Owner-bound target reference; provider secrets are forbidden. */
    destination: jsonb('destination'),
    /** Frozen owner-facing body and non-secret delivery options. */
    payload: jsonb('payload'),
    attempts: integer('attempts').notNull().default(0),
    /** True only after a definitive rejection proves no delivery was accepted. */
    retryable: boolean('retryable').notNull().default(false),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    providerMessageId: text('provider_message_id'),
    result: jsonb('result'),
    /** Non-secret producer association used to enforce privacy after observer completion. */
    producerWorkId: text('producer_work_id'),
    producerTaskId: uuid('producer_task_id'),
    producerApplicationId: uuid('producer_application_id'),
    producerConfirmationMessageId: text('producer_confirmation_message_id'),
    producerPrivacyGeneration: text('producer_privacy_generation'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('notification_outbox_agent_delivery_leg_idx').on(
      t.agentId,
      t.deliveryKey,
      t.legKey,
    ),
    index('notification_outbox_due_idx').on(t.agentId, t.status, t.availableAt),
    index('notification_outbox_producer_work_idx').on(t.agentId, t.producerWorkId),
    index('notification_outbox_producer_task_idx')
      .on(t.agentId, t.producerTaskId)
      .where(sql`${t.producerTaskId} IS NOT NULL`),
    check(
      'notification_outbox_status_check',
      sql`${t.status} IN ('pending','sending','delivered','skipped','failed','unknown')`,
    ),
    check('notification_outbox_attempts_nonnegative', sql`${t.attempts} >= 0`),
    check(
      'notification_outbox_retryable_failed_only',
      sql`not ${t.retryable} or ${t.status} = 'failed'`,
    ),
  ],
);

/**
 * One row per proactive "moment" the pulse actually delivered.
 *
 * Two jobs, which is why it is a table rather than a counter. `moment_key` is
 * stable per occurrence — a specific event's lead-time nudge, a specific
 * message's follow-up — so the unique index is the fence that stops the next
 * sweep, or a redelivered task, saying the same thing twice. And `delivered_at`
 * is what the pacing governor counts: independent producers each know nothing
 * about the others, so a shared ledger is the only place "at most one an hour,
 * N a day" can actually be enforced.
 *
 * Distinct from `proactive_pings`, which records *phone* attempts across every
 * producer including held ones. This records what the pulse decided to say.
 * Purged with the other operational counters — it is pacing state, not history.
 */
export const proactiveMoments = pgTable(
  'proactive_moments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Which producer shape this was, for the pacing rules and for telemetry. */
    kind: text('kind').notNull(),
    /** Stable per occurrence (e.g. `event-lead:<eventId>:<startIso>`). */
    momentKey: text('moment_key').notNull(),
    /** What the owner was told, trimmed — so a duplicate is explainable. */
    summary: text('summary').notNull().default(''),
    /** Whether the phone leg was accepted; a held ping still delivered a notice. */
    pinged: boolean('pinged').notNull().default(false),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('proactive_moments_key_idx').on(t.agentId, t.momentKey),
    index('proactive_moments_agent_delivered_idx').on(t.agentId, t.deliveredAt),
  ],
);

/**
 * The last known shape of one still-upcoming calendar event, so the pulse can
 * tell what changed on its next read instead of taking a fresh, stateless
 * snapshot every time (`calendar-diff.ts`). Without this a meeting the
 * organizer cancelled, an invite someone just declined, or a recurring
 * instance that quietly moved were all structurally invisible — nothing had
 * ever compared one calendar read to the last one.
 *
 * Google's event id is only unique WITHIN one calendar, hence the composite
 * key; with `singleEvents` expansion it is also unique PER OCCURRENCE, which
 * is what lets one cancelled Tuesday be told from the rest of the series.
 * Attendee addresses are never stored here — `attendee_response_hash` keys
 * each entry on a hash of the address instead, so this row names no one at
 * rest; the diff still names the real person by re-hashing the CURRENT read's
 * attendee list to look itself up, rather than needing this row to remember
 * it. A cancelled event is deleted outright rather than kept with a
 * `status`, so there is nothing here for a stale row to keep re-reporting.
 */
export const calendarEventSnapshots = pgTable(
  'calendar_event_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id').notNull(),
    eventId: text('event_id').notNull(),
    iCalUID: text('ical_uid'),
    summary: text('summary').notNull().default(''),
    /** Raw ISO datetime or (all-day) date, exactly as the provider sent it. */
    start: text('start').notNull(),
    end: text('end').notNull(),
    status: text('status'),
    attendeeResponseHash: jsonb('attendee_response_hash').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calendar_event_snapshots_event_idx').on(t.agentId, t.calendarId, t.eventId),
    // The pulse's own staleness sweep: rows a read has not touched in a while.
    index('calendar_event_snapshots_agent_updated_idx').on(t.agentId, t.updatedAt),
    check(
      'calendar_event_snapshots_status_check',
      sql`${t.status} IS NULL OR ${t.status} IN ('confirmed','tentative','cancelled')`,
    ),
  ],
);

/** Durable, machine-readable health checks for deployed channel integrations. */
export const canaryRuns = pgTable(
  'canary_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status').notNull().default('running'),
    ok: boolean('ok'),
    checks: jsonb('checks').notNull().default({}),
    error: text('error'),
    /** SHA-256 only: the browser worker receives the raw one-shot callback token. */
    browserCallbackTokenHash: text('browser_callback_token_hash'),
    /** Written exactly once by the credential-free browser worker callback. */
    browserResult: jsonb('browser_result'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('canary_runs_status_check', sql`${t.status} IN ('running','completed','failed')`),
    index('canary_runs_started_idx').on(t.startedAt),
  ],
);

// ── Workspace files ──────────────────────────────────────────────────────────

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    taskId: uuid('task_id').references(() => tasks.id),
    /** Path under the agent's workspace prefix in GCS. */
    workspacePath: text('workspace_path').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256'),
    objectGeneration: text('object_generation'),
    emailAttachmentCustodyId: uuid('email_attachment_custody_id').references(
      () => emailAttachmentCustodies.id,
      { onDelete: 'restrict' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('files_agent_idx').on(t.agentId, t.createdAt)],
);

// ── Document intelligence (Phase 11) ─────────────────────────────────────────

/**
 * A file promoted to a searchable document: an owner upload or an attachment
 * the assistant auto-filed from a trusted sender. The bytes live in the
 * workspace via the files inventory (`fileId`); extracted text is chunked into
 * `document_chunks` with embeddings behind the `documents.search` tool. Text
 * and PDF are extracted in-process; heavy formats (scans, images, office,
 * audio) are parked `status='pending'` with `extractor='pending_processor'`
 * for the future document-processor worker (Phase 14). A document's `trust`
 * carries into search results — a third-party attachment taints downstream.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** The stored bytes in the files inventory (holds the workspace path). */
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    title: text('title').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    /** Where it came from: 'upload' (owner) or 'email' (auto-filed attachment). */
    source: text('source').notNull().default('upload'),
    /** Free-form provenance: sender email, Gmail message id, conversation id. */
    sourceRef: text('source_ref').notNull().default(''),
    /** Trust of the content — a non-owner document taints search downstream. */
    trust: text('trust').notNull().default('owner'),
    /** Content hash: idempotent re-ingest and cross-source dedup. */
    sha256: text('sha256').notNull(),
    /** pending → extracting → ready | unsupported | failed. */
    status: text('status').notNull().default('pending'),
    /** Which extractor handled it: 'text' | 'pdf' | 'pending_processor' | ''. */
    extractor: text('extractor').notNull().default(''),
    chunkCount: integer('chunk_count').notNull().default(0),
    charCount: integer('char_count').notNull().default(0),
    error: text('error'),
    /**
     * Document-processor worker (Phase 14). While a heavy-format doc is out at
     * the credential-free processor, the one-shot callback token's SHA-256 lives
     * here (cleared on settle); processorStartedAt marks the launch for the
     * staleness/relaunch sweep; processedTextPath is the workspace blob of
     * extracted text the callback hands back to the documents.extract pipeline.
     */
    processorTokenHash: text('processor_token_hash'),
    processorStartedAt: timestamp('processor_started_at', { withTimezone: true }),
    /**
     * Launches consumed by this document. A worker that dies without calling
     * back (decompression bomb, OCR hang) would otherwise be relaunched every
     * staleness window forever; after PROCESSOR_MAX_ATTEMPTS the document is
     * marked failed instead.
     */
    processorAttempts: integer('processor_attempts').notNull().default(0),
    processedTextPath: text('processed_text_path'),
    extractionMetadata: jsonb('extraction_metadata').$type<DocumentExtractionMetadata>(),
    ...timestamps,
  },
  (t) => [
    check(
      'documents_status_check',
      sql`${t.status} IN ('pending','extracting','ready','unsupported','failed')`,
    ),
    check('documents_trust_check', sql`${t.trust} IN ('owner','known','unknown','assistant')`),
    uniqueIndex('documents_dedup_idx').on(t.agentId, t.sha256),
    index('documents_agent_status_idx').on(t.agentId, t.status),
  ],
);

/**
 * A contiguous text chunk of a document with its embedding — the retrieval
 * unit for `documents.search`. Chunks are deleted and reinserted whole on
 * re-extraction, so `(document_id, chunk_index)` is unique.
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1536 }),
    embeddingSpaceKey: text('embedding_space_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_chunks_doc_idx').on(t.documentId, t.chunkIndex),
    index('document_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('document_chunks_embedding_space_idx').on(t.agentId, t.embeddingSpaceKey),
    index('document_chunks_agent_idx').on(t.agentId),
  ],
);

// ── Location context (Phase 15) ──────────────────────────────────────────────

/**
 * Owner location pings from an HMAC-signed iOS Shortcut / native app. Kept
 * deliberately transient — never long-term location history: the sweep purges
 * rows older than the owner-configurable retention window (LOCATION_RETENTION_DAYS),
 * and location never enters the semantic memory/embedding space or memory
 * extraction. The latest fresh ping is surfaced as ambient context to the
 * owner's own (non-tainted) prompts and the morning brief.
 */
export const locationPings = pgTable(
  'location_pings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    lat: numeric('lat', { precision: 9, scale: 6 }).notNull(),
    lng: numeric('lng', { precision: 9, scale: 6 }).notNull(),
    /** Optional human label the Shortcut may attach ("home", "office", a city). */
    label: text('label').notNull().default(''),
    accuracyM: integer('accuracy_m'),
    source: text('source').notNull().default('shortcut'),
    /** IANA id of the device's clock when the ping was captured (travel awareness). */
    timeZone: text('time_zone'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Short-lived arrival-only capability. Null for legacy/non-consented pings;
     * callers may resolve the row for arrival admission only before this time.
     */
    arrivalExpiresAt: timestamp('arrival_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('location_pings_agent_idx').on(t.agentId, t.capturedAt)],
);

/**
 * Ambient "right now" context (Phase 25). A cheap, frequently-refreshed fusion
 * of the transient sources (location + weather today; calendar/health later) into
 * one compiled block plus derived flags, cached here so every planning step reads
 * it once instead of re-deriving — the same computed-once pattern as the owner
 * card. Operational cache, NOT memory: it is never read into extraction and never
 * becomes a durable fact; a stale snapshot is superseded by the next refresh.
 */
export const ambientSnapshots = pgTable('ambient_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id)
    .unique(),
  /** The rendered "right now" block injected into the prompt. */
  block: text('block').notNull().default(''),
  /** Derived boolean flags the planner can act on (raining_soon, traveling_away_from_home, …). */
  flags: jsonb('flags').notNull().default({}),
  /** Per-source freshness/values ({ location: {...}, weather: {...} }). */
  sources: jsonb('sources').notNull().default({}),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Dream notes (Phase 20 — offline cognition). A budget-capped nightly session
 * replays the day's failures (counterfactual footnotes), spots behavioral
 * patterns (→ quarantined low-confidence memories, stored in `memories`, not
 * here), and anticipates likely-tomorrow needs. The owner-facing observations
 * land here as short notes surfaced in the morning brief, kept 7 days for
 * inspection then purged by the sweep. Internal-only: the job dispatches no
 * tools, so it can never act outward.
 */
export const dreamNotes = pgTable(
  'dream_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** 'footnote' (while-you-slept observation) | 'anticipation' (likely-tomorrow prep). */
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    /** task/tool_call ids that evidence the note. */
    refIds: text('ref_ids').array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dream_notes_agent_idx').on(t.agentId, t.createdAt)],
);

// ── Push delivery ────────────────────────────────────────────────────────────

/**
 * APNs device tokens for the owner's devices, written by the iOS app on launch
 * (POST /api/mobile/v1/devices) and read by the push module's owner-notifier
 * leg. A token APNs rejects as Unregistered is marked invalidated in place —
 * never deleted — so a stale install re-registering later simply revives it.
 * Carries no content: pushes render the same text the dashboard notice posts.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** The APNs-issued token for one app install (hex string). */
    token: text('token').notNull(),
    platform: text('platform').notNull().default('ios'),
    /** APNs host the token was minted for; sending to the wrong one fails. */
    environment: text('environment').notNull().default('production'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('device_tokens_token_idx').on(t.token),
    index('device_tokens_agent_idx').on(t.agentId),
  ],
);

/**
 * Self-maintenance backlog (Phase 21). Code-shaped findings the bot proposes to
 * fix in its OWN repo. Hard fences live in code (see workflow/self-maintenance.ts):
 * PR-only (never push to main / trigger a deploy), NEVER edit infra/ or the
 * approval/policy/trust code paths (the bot cannot widen its own autonomy), one
 * open self-PR at a time, self-labeled so anomaly detection watches the pattern,
 * and the MERGE IS ALWAYS the owner's. This table only tracks the backlog + PR
 * status; it grants no capability on its own.
 */
export const selfMaintenance = pgTable(
  'self_maintenance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** The self-improvement proposal (Phase 12) this came from, if any. */
    proposalId: uuid('proposal_id'),
    title: text('title').notNull(),
    diagnosis: text('diagnosis').notNull().default(''),
    /** The file/area the fix targets — validated against the fence before any PR. */
    targetArea: text('target_area').notNull().default(''),
    status: text('status').notNull().default('backlog'),
    /** Why a blocked item can't proceed (e.g. touches a protected path). */
    blockedReason: text('blocked_reason'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    ...timestamps,
  },
  (t) => [
    check(
      'self_maintenance_status_check',
      sql`${t.status} IN ('backlog','blocked','pr_open','merged','dismissed')`,
    ),
    uniqueIndex('self_maintenance_dedup_idx').on(t.agentId, t.title),
    index('self_maintenance_status_idx').on(t.agentId, t.status),
  ],
);

// ── Inferred row types ───────────────────────────────────────────────────────

export type AgentRow = typeof agents.$inferSelect;
export type McpConnectionRow = typeof mcpConnections.$inferSelect;
export type ModelConnectionRow = typeof modelConnections.$inferSelect;
export type CallSessionRow = typeof callSessions.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type CommitmentRow = typeof commitments.$inferSelect;
export type ConversationSegmentRow = typeof conversationSegments.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ApplicationConfirmationRow = typeof applicationConfirmations.$inferSelect;
export type ApprovalPolicyRow = typeof approvalPolicies.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type MemoryTombstoneRow = typeof memoryTombstones.$inferSelect;
export type OwnerCardRow = typeof ownerCard.$inferSelect;
export type ImportSourceRow = typeof importSources.$inferSelect;
/**
 * One row per finalized model-driven task: the response-contract verdict plus
 * loop-health counters. This is the queryable quality signal — contract-block
 * rate per prompt version, no-tool-call retries per model — that a console.warn
 * could never aggregate. Written by the executor at finalize.
 */
export const responseChecks = pgTable(
  'response_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    promptVersion: integer('prompt_version').notNull(),
    plannerVersion: integer('planner_version'),
    /** The honesty gate rewrote or blocked an unsupported action claim. */
    blocked: boolean('blocked').notNull().default(false),
    unsupportedCount: integer('unsupported_count').notNull().default(0),
    /** Steps that were required to act but returned no tool call and were retried. */
    mustActRetries: integer('must_act_retries').notNull().default(0),
    /** Steps served by a fallback model (budget degradation or forced). */
    degradedSteps: integer('degraded_steps').notNull().default(0),
    /** A bounded self-review model call completed before final delivery. */
    outputVerificationAttempted: boolean('output_verification_attempted').notNull().default(false),
    /** The self-review supplied a replacement, re-checked by the response contract. */
    outputVerificationRevised: boolean('output_verification_revised').notNull().default(false),
    /** The optional review could not run (budget/provider), so the checked draft shipped. */
    outputVerificationUnavailable: boolean('output_verification_unavailable')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('response_checks_task_idx').on(t.taskId),
    index('response_checks_created_idx').on(t.createdAt),
  ],
);

/**
 * Privacy-preserving recall observability. It stores quality counters only —
 * never a query, retrieved memory, embedding, or rendered recall block.
 */
export const recallMetrics = pgTable(
  'recall_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** Direct chat path or the durable executor path. */
    path: text('path').notNull(),
    graphAttempted: boolean('graph_attempted').notNull().default(false),
    graphFailed: boolean('graph_failed').notNull().default(false),
    historyFailed: boolean('history_failed').notNull().default(false),
    graphCandidates: integer('graph_candidates').notNull().default(0),
    graphUsed: integer('graph_used').notNull().default(0),
    historyTier: text('history_tier').notNull().default('none'),
    historyUsed: integer('history_used').notNull().default(0),
    sourceCount: integer('source_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('recall_metrics_path_check', sql`${t.path} IN ('chat','executor')`),
    check(
      'recall_metrics_tier_check',
      sql`${t.historyTier} IN ('segment','message','blended','none')`,
    ),
    index('recall_metrics_agent_created_idx').on(t.agentId, t.createdAt),
    index('recall_metrics_task_idx').on(t.taskId),
  ],
);

/**
 * Owner feedback on a recall disclosure. Keep it deliberately aggregate: a
 * verdict and source count are enough to measure value without duplicating the
 * query, recalled content, or display labels into analytics storage.
 */
export const recallFeedback = pgTable(
  'recall_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    verdict: text('verdict').notNull(),
    sourceCount: integer('source_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('recall_feedback_verdict_check', sql`${t.verdict} IN ('helpful','not_helpful')`),
    uniqueIndex('recall_feedback_message_idx').on(t.messageId),
    index('recall_feedback_agent_created_idx').on(t.agentId, t.createdAt),
  ],
);

/**
 * Owner controls and minimal surfacing history for recalled source identities.
 * The key is a digest of source IDs; no query, source text, or display label is stored.
 */
export const recallSurfaces = pgTable(
  'recall_surfaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    sourceRevision: text('source_revision'),
    kind: text('kind').notNull(),
    firstSurfacedAt: timestamp('first_surfaced_at', { withTimezone: true }).notNull().defaultNow(),
    lastSurfacedAt: timestamp('last_surfaced_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageId: uuid('last_message_id'),
    surfaceCount: integer('surface_count').notNull().default(1),
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('recall_surfaces_owner_source_idx').on(t.agentId, t.sourceKey),
    index('recall_surfaces_owner_recent_idx').on(t.agentId, t.lastSurfacedAt),
    check('recall_surfaces_key_check', sql`${t.sourceKey} ~ '^[a-f0-9]{64}$'`),
    check('recall_surfaces_count_check', sql`${t.surfaceCount} > 0`),
    check('recall_surfaces_version_check', sql`${t.version} > 0`),
  ],
);

export type ResponseCheckRow = typeof responseChecks.$inferSelect;
export type RecallMetricRow = typeof recallMetrics.$inferSelect;
export type RecallFeedbackRow = typeof recallFeedback.$inferSelect;
export type RecallSurfaceRow = typeof recallSurfaces.$inferSelect;

export type CostEventRow = typeof costEvents.$inferSelect;
export type CostReservationRow = typeof costReservations.$inferSelect;
export type RateRow = typeof rateTable.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type OccasionRow = typeof occasions.$inferSelect;
export type AnomalyRow = typeof anomalies.$inferSelect;
export type AssistantHealthAlertRow = typeof assistantHealthAlerts.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;
export type ImprovementProposalRow = typeof improvementProposals.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentChunkRow = typeof documentChunks.$inferSelect;
export type LocationPingRow = typeof locationPings.$inferSelect;
export type AmbientSnapshotRow = typeof ambientSnapshots.$inferSelect;
export type DreamNoteRow = typeof dreamNotes.$inferSelect;
export type SelfMaintenanceRow = typeof selfMaintenance.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type ModelRoleRow = typeof modelRoles.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type EmailIngestRow = typeof emailIngest.$inferSelect;
export type EmailAttachmentCustodyRow = typeof emailAttachmentCustodies.$inferSelect;
export type SuggestionRow = typeof suggestions.$inferSelect;
export type ProactiveMomentRow = typeof proactiveMoments.$inferSelect;
export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type WatchRow = typeof watches.$inferSelect;
export type WatchFireRow = typeof watchFires.$inferSelect;
export type WatchFireEffectRow = typeof watchFireEffects.$inferSelect;
export type CanaryRunRow = typeof canaryRuns.$inferSelect;

/** Issue-to-PR lifecycle; no production write capability is granted by this ledger. */
export const selfRepairIssues = pgTable(
  'self_repair_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('reported'),
    version: integer('version').notNull().default(0),
    data: jsonb('data').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('self_repair_issues_dedup_idx').on(t.agentId, t.fingerprint),
    index('self_repair_issues_owner_idx').on(t.agentId, t.status),
    check(
      'self_repair_issues_status_check',
      sql`${t.status} IN ('reported','investigating','fixing','testing','pr_open','merged','monitoring','resolved','blocked','failed','dismissed')`,
    ),
  ],
);
