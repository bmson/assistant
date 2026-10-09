import { loadConfig } from '@assistant/config';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from './client.js';
import { modelDefaults, modelRoleDefaults, reconcileModelConfig } from './model-config.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { decideScheduleSeed } from './schedule-seed.js';
import {
  agents,
  approvalPolicies,
  budgets,
  contacts,
  rateLimits,
  rateTable,
  schedules,
  voiceProfile,
} from './schema.js';
import { resolveOwnerPolicyValues } from './seed-values.js';

const config = loadConfig();
const { DATABASE_URL, OWNER_EMAIL, OWNER_NAME, OWNER_PHONE } = config;

const db = createDb(DATABASE_URL);

// ── Agent identity ───────────────────────────────────────────────────────────

// The display name is seed-owned, while timezone, locale, and signature are
// owner-editable settings and must survive the reconciliation run on deploy.
// The workspace prefix is storage identity — never renamed.
const AGENT_NAME = config.ASSISTANT_NAME;
const AGENT_SIGNATURE = config.ASSISTANT_SIGNATURE;

const [agent] = await db
  .insert(agents)
  .values({
    name: AGENT_NAME,
    email: config.ASSISTANT_EMAIL,
    workspacePrefix: `workspace/${config.ASSISTANT_WORKSPACE_ID}`,
    timezone: config.ASSISTANT_TIMEZONE,
    locale: config.ASSISTANT_LOCALE,
    signature: AGENT_SIGNATURE,
  })
  .onConflictDoUpdate({
    target: agents.email,
    set: { name: AGENT_NAME, updatedAt: sql`now()` },
  })
  .returning();

if (!agent) throw new Error('agent seed failed');

// Shared by fresh installs, deployment reconciliation, and explicit live updates.
await reconcileModelConfig(db);

// ── Budgets & rate limits ────────────────────────────────────────────────────

// Preserve existing owner budgets when models change. Kimi K3 remains subject
// to the same reservation and fallback limits as the less expensive defaults.
const budgetSeed = [
  { scope: 'task_default', limitUsd: '0.50' },
  { scope: 'daily', limitUsd: '4.00' },
  { scope: 'monthly', limitUsd: '50.00' },
] as const;

for (const b of budgetSeed) {
  await db.insert(budgets).values(b).onConflictDoNothing();
}

// ── Rate table (Phase 27) — unit prices for non-model spend ─────────────────
// Model costs come from OpenRouter usage.cost; everything else prices from here.

const rateSeed = [
  { key: 'embedding_mtok', unit: 'mtok', unitPriceUsd: '0.02' },
  { key: 'twilio_sms', unit: 'segment', unitPriceUsd: '0.0079' },
  { key: 'twilio_voice_min', unit: 'minute', unitPriceUsd: '0.014' },
  // 2 vCPU + 2 GiB Cloud Run job: ~2×$0.000024/vCPU-s + 2×$0.0000025/GiB-s
  { key: 'cloud_run_job_sec', unit: 'second', unitPriceUsd: '0.00006' },
  { key: 'storage_gb_month', unit: 'gb-month', unitPriceUsd: '0.023' },
] as const;

for (const r of rateSeed) {
  await db
    .insert(rateTable)
    .values(r)
    .onConflictDoUpdate({ target: rateTable.key, set: { unit: r.unit } });
}

const rateLimitSeed = [
  { scope: 'tool:gmail.send', maxPerHour: 10, maxPerDay: 50 },
  { scope: 'tool:sms.send', maxPerHour: 10, maxPerDay: 50 },
  // Egress reads are cheap individually but unmetered in aggregate: web.fetch
  // records no cost event and web.search bills the provider per query, so both
  // need a ceiling that survives a burst of triage tasks.
  { scope: 'tool:web.fetch', maxPerHour: 60, maxPerDay: 300 },
  { scope: 'tool:web.search', maxPerHour: 20, maxPerDay: 100 },
  // weather.lookup is keyless and stays available at unknown trust (its
  // destination is hardwired, so there is no egress to strip), which leaves a
  // free public API reachable by strangers. Generous enough that no real
  // question is refused, low enough to cap a loop.
  { scope: 'tool:weather.lookup', maxPerHour: 60, maxPerDay: 300 },
  // Same shape as weather: keyless, fixed host, reachable at unknown trust.
  { scope: 'tool:sports.scores', maxPerHour: 60, maxPerDay: 300 },
  { scope: 'channel:sms', maxPerHour: 30, maxPerDay: 200 },
  { scope: 'task', maxPerHour: 120, maxPerDay: 1000 },
] as const;

for (const r of rateLimitSeed) {
  await db.insert(rateLimits).values(r).onConflictDoNothing();
}

// ── Owner contact ────────────────────────────────────────────────────────────

let [ownerContact] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
if (!ownerContact) {
  [ownerContact] = await db
    .insert(contacts)
    .values({
      name: OWNER_NAME,
      emails: [OWNER_EMAIL],
      phones: OWNER_PHONE ? [OWNER_PHONE] : [],
      relationship: 'owner',
      trust: 'owner',
    })
    .returning();
}
const ownerPolicyValues = resolveOwnerPolicyValues(ownerContact, {
  email: OWNER_EMAIL,
  phone: OWNER_PHONE,
});

// ── Voice profile singleton ──────────────────────────────────────────────────

// An honest baseline (not a fabricated idiosyncratic style): it activates the
// outbound voice rewrite as a consistency enforcer for plain, warm, filler-free
// writing. Real uploaded/sampled writing later refines this. Migration 0024
// backfills existing databases whose singleton is still empty; the owner's own
// edits (a non-empty description) are never overwritten.
const DEFAULT_VOICE = {
  description:
    'Plain, warm, and direct — writes like a capable human colleague. Short sentences, concrete, no corporate filler.',
  dos: [
    'Get to the point; lead with the useful thing',
    'Sound warm and human, not formal or robotic',
    'Keep sentences short and concrete',
  ],
  donts: [
    'No corporate filler or AI throat-clearing ("I hope this helps", "As an AI", "Certainly!")',
    'No hedging preambles before the answer',
    'Do not over-explain or pad',
  ],
};

await db
  .insert(voiceProfile)
  .values({ id: 1, ...DEFAULT_VOICE })
  .onConflictDoNothing();

// ── Default approval policies (v2's dynamic rules as data) ───────────────────

const policySeed = [
  {
    toolName: 'sms.send',
    templateKey: 'sms.reply_to_owner',
    match: { phone: ownerPolicyValues.phone },
    effect: 'allow',
  },
  {
    toolName: 'calendar.create_event',
    templateKey: 'calendar.self_only_events',
    match: {},
    effect: 'allow',
  },
  // Inviting the owner (and only the owner) to an event is autonomous — the
  // invite email goes nowhere but to them.
  {
    toolName: 'calendar.create_event',
    templateKey: 'calendar.owner_attendee_only',
    match: { emails: ownerPolicyValues.emails },
    effect: 'allow',
  },
] as const;

await db.transaction(async (tx) => {
  await lockPostgresPrivacyObservationFence(tx as unknown as typeof db, agent.id);
  for (const p of policySeed) {
    const existing = await tx
      .select()
      .from(approvalPolicies)
      .where(
        and(
          eq(approvalPolicies.agentId, agent.id),
          eq(approvalPolicies.templateKey, p.templateKey),
        ),
      );
    if (existing.length === 0) {
      await tx.insert(approvalPolicies).values({ ...p, agentId: agent.id, createdVia: 'seed' });
    } else if (existing[0]?.createdVia === 'seed') {
      // Seed-owned rules carry environment-derived owner addresses. Reconcile
      // those values on release without re-enabling a rule the owner paused.
      await tx
        .update(approvalPolicies)
        .set({ toolName: p.toolName, match: p.match, effect: p.effect, updatedAt: sql`now()` })
        .where(eq(approvalPolicies.id, existing[0].id));
    }
  }
});

// ── Default proactive schedules (next_run_at initialized by the first sweep) ─

const scheduleSeed = [
  // 'morning-brief' (cron 30 7 * * *) was retired: it ran fifteen minutes
  // before 'daily-briefing' below, read the same calendar/mail tables with no
  // cross-surface dedupe, and duplicated every category daily-briefing already
  // covers (calendar, mail, goals, upcoming dates) — but as unstructured,
  // unverifiable free text that also narrated internal task-failure telemetry
  // and a dead-end list of pending suggestions at the owner. daily-briefing is
  // the deterministic code job that replaces it in full; do not re-add this.
  // Phase 8: extraction and consolidation are code jobs, not model-prompted
  // tasks — the executor dispatches on taskTemplate.job. Extraction reviews
  // the day's conversations; consolidation dedupes/resolves per entity and
  // recompiles the owner card. Consolidation runs after extraction.
  {
    name: 'memory-extraction',
    cron: '0 22 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'memory.extract' },
  },
  // Wake elapsed snoozes independently of nightly model extraction.
  // Unresolved obligations never disappear merely because they aged.
  {
    name: 'open-loop-sweep',
    cron: '35 */6 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.01', job: 'memory.sweep_loops' },
  },
  // Forwarded mail is read into memory from its own ledger rather than by the
  // conversation sampling above, which sees at most 12 threads a night — a few
  // percent of a real inbox. Runs every four hours so the day's dates are
  // recallable while they still matter, not the following morning, and drains a
  // backlog across runs. Idle and free when no mail is being ingested.
  {
    name: 'email-extraction',
    cron: '20 */4 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.35', job: 'email.extract' },
  },
  // The standing briefing (anticipation layer, phase 2): one digest a day of
  // what arrived, what is coming up, and what has stopped waiting for the
  // owner. Self-silencing — it delivers nothing on a quiet day, which is what
  // makes it safe to have on by default, and it costs nothing at all while mail
  // ingest is off because there is no mail to report on.
  {
    name: 'daily-briefing',
    cron: '45 7 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'briefing.compose' },
  },
  // The pulse (anticipation layer): the during-the-day counterpart to the
  // morning digest. Everything proactive used to happen at 07:30, 07:45 and
  // 19:30, so an unanswered invitation or an actionable email could sit all day
  // with nothing said. This asks every twenty minutes whether something is
  // worth saying RIGHT NOW — a salient event about to start, important mail
  // nothing picked up, a commitment coming due — and almost always answers no.
  // Self-silencing like the briefing, and paced by its own ledger (at most one
  // an hour) on top of the owner's quiet hours and ambient cap.
  {
    name: 'pulse',
    cron: '*/20 * * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.02', job: 'pulse.check' },
  },
  // The evening counterpart to the morning brief: looks at TOMORROW while
  // there is still time to react — a closed school, a cancelled standing
  // event, a dated obligation sitting in email but not on the calendar.
  // Self-silencing like the briefing: routine evenings produce no message.
  {
    name: 'tomorrow-check',
    cron: '30 19 * * *',
    taskTemplate: {
      type: 'scheduled',
      budgetUsdLimit: '0.10',
      instruction:
        "Do a short look-ahead at TOMORROW for the owner while there is still time to react tonight. Check: (1) tomorrow's events across every calendar you can read (calendar.list_events) — flag anything unexpected for the day of week: a school day with no school, a holiday or closure, a cancelled recurring event, an unusual gap or a conflict; (2) recent email (gmail.search newer_than:2d) for anything that names tomorrow or the next few days — a deadline, a form due, a pickup, a booking — that is NOT already on the calendar; (3) the ambient weather block when tomorrow involves outdoor plans. If something is genuinely worth knowing tonight, send ONE concise heads-up via owner.notify with ping=true: what it is, which day it concerns, and the sensible next step. Most evenings tomorrow is routine — then send nothing and finish with an empty reply; no message is the right answer when there is nothing to say.",
    },
  },
  {
    name: 'memory-consolidation',
    cron: '30 22 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'memory.consolidate' },
  },
  // GraphRAG: a bounded, idempotent source-fact backfill plus regular
  // reconciliation. It is offline-only; chat always falls back to vector
  // recall while a source is still pending.
  {
    name: 'knowledge-graph-sync',
    cron: '15,45 * * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'memory.graph_sync' },
  },
  // Curiosity (anticipation layer): one question a day about something the
  // graph structurally does not know — where a well-connected person lives,
  // a relation extraction hedged on. The graph otherwise only ever grows by
  // overhearing, so it can hold a contact for a year without ever asking the
  // obvious follow-up. Midday on purpose: a question is a conversation opener,
  // not something to wake up to. Self-silencing, and a gap is asked once ever.
  {
    name: 'knowledge-graph-curiosity',
    cron: '15 12 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.02', job: 'graph.curiosity' },
  },
  // Re-canonicalizes date entities from labels the graph already holds. It makes
  // no model calls at all, so it is budgeted at zero and can run over everything
  // nightly rather than in metered batches.
  {
    name: 'knowledge-graph-date-backfill',
    cron: '5 3 * * *',
    taskTemplate: {
      type: 'scheduled',
      budgetUsdLimit: '0.00',
      job: 'memory.graph_date_backfill',
    },
  },
  // Phase 2 (long-running chat): segment the day's conversations into topic
  // summaries recall can retrieve. A code job like extraction/consolidation;
  // runs before them so summaries reflect the freshest boundaries.
  {
    name: 'chat-segmentation',
    cron: '0 21 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'chat.segment' },
  },
  // Phase 18: nightly approval-anomaly scan over policy-matched auto-executions.
  // Runs after extraction/consolidation; a code job (no model), so budget is nominal.
  {
    name: 'anomaly-scan',
    cron: '0 23 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.05', job: 'anomaly.scan' },
  },
  // Phase 26: nightly reflection distills reusable skills from the day's
  // non-obvious task successes. Runs after consolidation; a model job.
  {
    name: 'skill-reflection',
    cron: '30 23 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.15', job: 'skill.reflect' },
  },
  // Phase 12: nightly self-improvement eval — mine failures/retries/cost outliers
  // into an experience memory + owner-approved change proposals (never applied).
  {
    name: 'self-improve',
    cron: '0 0 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.15', job: 'self.improve' },
  },
  // Ambient "right now" fusion (Phase 25): refresh location+weather every 30 min
  // so every planning step reads a fresh block without a mid-task weather call.
  {
    name: 'ambient-refresh',
    cron: '*/30 * * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.02', job: 'ambient.refresh' },
  },
  // Dreaming (Phase 20): a budget-capped nightly reflection after extraction —
  // counterfactual footnotes, behavioral hypotheses, tomorrow's anticipations.
  {
    name: 'dream',
    cron: '30 0 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'dream.run' },
  },
  // Self-maintenance (Phase 21): after self-improve drafts proposals, turn the
  // code-shaped ones into a fenced backlog (diagnosis only; never touches
  // protected paths, never opens a PR without the owner's GitHub token).
  {
    name: 'self-maintain',
    cron: '0 1 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'self.maintain' },
  },
  {
    name: 'self-repair',
    cron: '*/15 * * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.50', job: 'self.repair' },
  },
  // Deterministic daily alerting for persistent GraphRAG and final-response
  // quality failures. This is a code job: no model interprets telemetry.
  {
    name: 'assistant-health-monitor',
    cron: '15 1 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.02', job: 'health.monitor' },
  },
  // Document-processor backstop (Phase 14): ingest enqueues a per-document
  // process job immediately, but this sweep relaunches any heavy-format document
  // whose worker run never called back (stale) or was missed. A code job — no
  // model — and inert until the processor Cloud Run Job is deployed.
  {
    name: 'document-processing',
    cron: '*/15 * * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.02', job: 'documents.process' },
  },
] as const;

for (const s of scheduleSeed) {
  const [existing] = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.agentId, agent.id), eq(schedules.name, s.name)));
  const definition = { cron: s.cron, taskTemplate: { ...s.taskTemplate } };
  const seedTemplateKey = `assistant.schedule.${s.name}`;
  const decision = decideScheduleSeed(existing ?? null, {
    key: seedTemplateKey,
    revision: 1,
    definition,
  });
  if (decision.kind === 'insert') {
    await db.insert(schedules).values({
      agentId: agent.id,
      name: s.name,
      cron: s.cron,
      taskTemplate: { ...s.taskTemplate },
      enabled: true,
      seedTemplateKey: decision.seedTemplateKey,
      seedTemplateRevision: decision.seedTemplateRevision,
      seedDefinition: decision.seedDefinition,
      seedReviewRequired: false,
    });
  } else if (decision.kind === 'update' && existing) {
    await db
      .update(schedules)
      .set({
        cron: s.cron,
        taskTemplate: { ...s.taskTemplate },
        seedTemplateKey: decision.seedTemplateKey,
        seedTemplateRevision: decision.seedTemplateRevision,
        seedDefinition: decision.seedDefinition,
        seedReviewRequired: false,
        // next_run_at recomputes on the next sweep against the new cron
        nextRunAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(schedules.id, existing.id));
  } else if (decision.kind === 'adopt' && existing) {
    await db
      .update(schedules)
      .set({
        seedTemplateKey: decision.seedTemplateKey,
        seedTemplateRevision: decision.seedTemplateRevision,
        seedDefinition: decision.seedDefinition,
        updatedAt: sql`now()`,
      })
      .where(eq(schedules.id, existing.id));
  } else if (decision.kind === 'review' && existing && !existing.seedReviewRequired) {
    await db
      .update(schedules)
      .set({ seedReviewRequired: true, updatedAt: sql`now()` })
      .where(eq(schedules.id, existing.id));
  }
}

console.log(`seeded: agent ${agent.name} <${agent.email}> (${agent.id})`);
console.log(
  `seeded: ${modelDefaults.length} models, ${modelRoleDefaults.length} roles, ${budgetSeed.length} budgets, ${rateLimitSeed.length} rate limits, ${policySeed.length} policies`,
);
process.exit(0);
