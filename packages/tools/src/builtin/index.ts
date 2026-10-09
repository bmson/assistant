import { createHash } from 'node:crypto';
import {
  getOrCreateNotificationsConversation,
  saveOccasion,
  upcomingOccasions,
} from '@assistant/core';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  findContactsByName,
  goals,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  messages,
  resolveSubjectContact,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  type ConversationSearchRepository,
  embeddingSpaceIdentityKey,
  type MemoryToolRepository,
  type TaskRepository,
} from '@assistant/persistence';
import { and, eq, gt, gte, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';
import type { WorkspaceStore } from '../workspace-store.js';
import { registerPortableConversationSearchTool } from './conversation-search.js';
import {
  registerPortableWebFetchTool,
  registerPortableWorkspaceTools,
} from './portable-web-workspace.js';
import { pageStoredToolResult } from './read-result.js';
import { registerSituationTools } from './situations.js';
import { registerSportsTools } from './sports.js';
import { registerPortableTaskTools } from './task-schedule.js';
import { registerWeatherTool } from './weather.js';
import type { WebFetchIo } from './web-fetch.js';

export { registerPortableGoalProgressTool } from './goal-progress.js';
export { registerPortableGoalTools } from './goals.js';
export { registerPortableOwnerNotifyTool } from './owner-notify.js';
export {
  registerPortableWebFetchTool,
  registerPortableWebWorkspaceTools,
  registerPortableWorkspaceTools,
} from './portable-web-workspace.js';
export { registerSportsTools } from './sports.js';
export { registerPortableTaskTools } from './task-schedule.js';
export * from './weather.js';
// The `web.fetch` machinery lives in web-fetch.ts; re-exported here so the
// package surface (and the web-watch poller's imports) stay unchanged.
export * from './web-fetch.js';

export interface BuiltinDeps {
  /** Embedding closure (injected by the app — avoids a core↔tools cycle). */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Embedding plus the exact immutable storage identity that produced it. */
  embedWithIdentity?: (texts: string[]) => Promise<{
    embeddings: number[][];
    embeddingSpaceKey: string;
  }>;
  /** Workspace file store: local FS in dev, GCS in prod. */
  workspace: WorkspaceStore;
  /**
   * Out-of-band owner ping (SMS/push), injected by the composition root and
   * already behind the nudge policy. Absent in tests and minimal installs:
   * a `ping` then resolves to the chat message only.
   */
  notifyOwner?: (input: {
    text: string;
    taskId?: string;
    urgency?: 'ambient' | 'interrupt';
  }) => Promise<void>;
  /**
   * Retire the live facts a just-saved fact contradicts (injected by the
   * composition root — it needs the model router, and a closure keeps that out
   * of this package exactly like `embed` does). Absent in tests and minimal
   * installs: a correction then waits for the nightly consolidation, which is
   * the behaviour this closure exists to improve on, not a new failure.
   */
  supersede?: (input: {
    agentId: string;
    newFactId: string;
    taskId?: string;
  }) => Promise<{ superseded: string[] }>;
  /** Injected in tests; defaults to global fetch (used by `weather.lookup`). */
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Injected web.fetch transport for deterministic boundary tests. */
  webFetchIo?: WebFetchIo;
  /** Task lifecycle port used by future-self scheduling. */
  tasks?: TaskRepository;
  /** Durable memory port used by memory.save and memory.recall. */
  memory?: MemoryToolRepository;
  /** Owner-scoped conversation search port; absent profiles do not expose search. */
  conversations?: ConversationSearchRepository;
}

// Repository-backed record tools for portable compositions.
export { registerPortableContactLookupTool } from './contacts.js';
export { registerPortableConversationSearchTool } from './conversation-search.js';
export { registerPortableGraphSnapshotTool } from './graph-snapshot.js';
export { registerPortableOccasionTools } from './occasions.js';
export { registerPortableReadResultTool } from './read-result.js';
export { registerSituationTools } from './situations.js';

/** Memory tools use persistence ports and can be installed without the SQL-only built-ins. */
export function registerPortableMemoryTools(
  registry: ToolRegistry,
  deps: Pick<BuiltinDeps, 'embed' | 'embedWithIdentity' | 'memory' | 'supersede'>,
): ToolRegistry {
  // ── memory ─────────────────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'memory.save',
      description:
        'Save a durable memory. category "knowledge" for lasting facts/preferences/people; "experience" for what happened during work (expires eventually). Attribute facts about a person via subject ("owner" for the owner, else their name).',
      inputSchema: z.object({
        content: z.string().min(3).max(2000),
        category: z.enum(['knowledge', 'experience']),
        kind: z.enum(['fact', 'preference', 'person', 'project', 'episode']),
        subject: z
          .string()
          .max(120)
          .default('')
          .describe('Who the fact is about: "owner", a person\'s name, or empty if about no one.'),
        domain: z
          .enum(['identity', 'work', 'home', 'relationships', 'preferences', 'health', 'other'])
          .optional(),
        importance: z.number().int().min(1).max(5).default(3),
        confidence: z.number().min(0).max(1).default(0.7),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      // Shown when a tainted session tries to persist a memory (writesMemory
      // routes it to approval): the owner sees the exact text being stored.
      approvalSummary: (args) =>
        `Remember${args.subject ? ` (about ${args.subject})` : ''}: “${args.content.slice(0, 200)}”`,
      execute: async (args, ctx) => {
        if (!deps.memory) throw new Error('memory tool repository unavailable');
        const observedPrivacyGeneration = await deps.memory.observationGeneration(ctx.agentId);
        const contentHash = createHash('sha256').update(args.content).digest('hex');
        const screened = await deps.memory.screenContentHash(ctx.agentId, contentHash);
        const quarantined = ctx.trust !== 'owner' && ctx.trust !== 'assistant';
        if (screened !== 'new')
          return {
            saved: false,
            duplicate: screened === 'duplicate',
            ...(screened === 'tombstoned'
              ? {
                  tombstoned: true,
                  note: 'the owner explicitly forgot this fact — do not re-save it',
                }
              : {}),
            quarantined,
          };
        const embedded = deps.embedWithIdentity
          ? await deps.embedWithIdentity([args.content])
          : null;
        const [embedding] = embedded?.embeddings ?? (await deps.embed([args.content]));
        if (!embedding) throw new Error('embedding unavailable');
        const exactSpaceKey =
          embedded?.embeddingSpaceKey ??
          (deps.memory.embeddingSpace
            ? embeddingSpaceIdentityKey(deps.memory.embeddingSpace)
            : undefined);
        if (!exactSpaceKey) throw new Error('embedding space identity unavailable');
        const expiresAt =
          args.category === 'experience'
            ? new Date(ctx.now().getTime() + 90 * 24 * 3600 * 1000)
            : null;
        const result = await deps.memory.save({
          agentId: ctx.agentId,
          content: args.content,
          contentHash,
          observedPrivacyGeneration,
          embedding,
          embeddingSpaceKey: exactSpaceKey,
          category: args.category,
          kind: args.kind,
          importance: args.importance,
          confidence: args.confidence,
          originTrust: ctx.trust,
          quarantined,
          subject: args.subject || undefined,
          domain: args.domain,
          sourceTaskId: ctx.taskId,
          expiresAt,
        });
        // Preserve immediate correction handling across persistence drivers.
        const superseded =
          result.saved &&
          result.id &&
          args.category === 'knowledge' &&
          !result.quarantined &&
          deps.supersede
            ? await deps
                .supersede({
                  agentId: ctx.agentId,
                  newFactId: result.id,
                  ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
                })
                .then((value) => value.superseded)
                .catch((err: unknown) => {
                  console.error('memory.save: supersession check failed', err);
                  return [] as string[];
                })
            : [];
        return {
          saved: result.saved,
          duplicate: result.duplicate,
          quarantined: result.quarantined,
          ...(superseded.length ? { replacedEarlierFacts: superseded.length } : {}),
          ...(result.tombstoned
            ? {
                tombstoned: true,
                note: 'the owner explicitly forgot this fact — do not re-save it',
              }
            : {}),
        };
      },
    },
    { writesMemory: true },
  );

  register(
    registry,
    {
      name: 'memory.recall',
      description:
        'Recall memories relevant to a query (semantic similarity). Each result carries a confidence and, when known, a validity window. Treat a low-confidence or expired-validity fact as unconfirmed — verify or ask rather than acting on it as certain, especially for a name, date, address, or link.',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        if (!deps.memory) throw new Error('memory tool repository unavailable');
        const embedded = deps.embedWithIdentity ? await deps.embedWithIdentity([args.query]) : null;
        const [embedding] = embedded?.embeddings ?? (await deps.embed([args.query]));
        if (!embedding) throw new Error('embedding unavailable');
        const now = ctx.now();
        const embeddingSpaceKey =
          embedded?.embeddingSpaceKey ??
          (deps.memory.embeddingSpace
            ? embeddingSpaceIdentityKey(deps.memory.embeddingSpace)
            : undefined);
        if (!embeddingSpaceKey) throw new Error('embedding space identity unavailable');
        const result = await deps.memory.recall({
          agentId: ctx.agentId,
          embedding,
          query: args.query,
          limit: args.limit,
          now,
          embeddingSpaceKey,
        });
        return {
          memories: result.memories.map((r) => ({
            ...r,
            // Flag a fact the model must not treat as settled: low confidence, or
            // a validity window that has lapsed (stale but not yet superseded).
            unconfirmed:
              r.ownerConfirmed !== true ||
              Number(r.confidence) < 0.7 ||
              (r.validUntil ? new Date(r.validUntil).getTime() < now.getTime() : false),
          })),
        };
      },
    },
    // Recall filters quarantined rows, and untrusted-origin facts are
    // quarantined at write time (extraction) — so what recall returns is
    // owner-vetted state. Grounding a task in its own memory must not strip
    // the owner card from every later step.
    { confidentialRead: true },
  );

  return registry;
}

export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinDeps): ToolRegistry {
  registerSituationTools(registry);
  registerSportsTools(registry, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  registerPortableMemoryTools(registry, deps);
  if (deps.conversations) {
    if (!deps.embedWithIdentity)
      throw new Error('Conversation search requires an identity-bearing embedding provider');
    registerPortableConversationSearchTool(registry, {
      embed: deps.embedWithIdentity,
      conversations: deps.conversations,
    });
  }
  registerPortableTaskTools(registry, deps);

  register(
    registry,
    {
      name: 'memory.graph_snapshot',
      description:
        'Read active, source-backed knowledge-graph connections relevant to a query. Returns direct relationships plus the exact source memory and evidence. Never infer missing nodes or edges.',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const subject = alias(knowledgeGraphEntities, 'snapshot_subject');
        const object = alias(knowledgeGraphEntities, 'snapshot_object');
        const [embedding] = await deps.embed([args.query]);
        const vector = JSON.stringify(embedding);
        const rows = await ctx.db
          .select({
            id: knowledgeGraphRelations.id,
            subjectId: subject.id,
            subjectLabel: sql<string>`COALESCE(${subject.preferredLabel}, ${subject.label})`,
            subjectKind: subject.kind,
            predicate: knowledgeGraphRelations.predicate,
            objectId: object.id,
            objectLabel: sql<string>`COALESCE(${object.preferredLabel}, ${object.label})`,
            objectKind: object.kind,
            sourceMemoryId: memories.id,
            sourceMemory: memories.content,
            source: memories.source,
            memoryConfidence: memories.confidence,
            ownerConfirmed: memories.ownerConfirmed,
            evidenceQuote: knowledgeGraphRelations.evidenceQuote,
            relationshipConfidence: knowledgeGraphRelations.confidence,
            validFrom: knowledgeGraphRelations.validFrom,
            validUntil: knowledgeGraphRelations.validUntil,
            similarity: sql<number>`1 - (${memories.embedding} <=> ${vector}::vector)`,
          })
          .from(knowledgeGraphRelations)
          .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
          .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
          .innerJoin(subject, eq(subject.id, knowledgeGraphRelations.subjectEntityId))
          .innerJoin(object, eq(object.id, knowledgeGraphRelations.objectEntityId))
          .where(
            and(
              eq(knowledgeGraphRelations.agentId, ctx.agentId),
              ne(knowledgeGraphRelations.reviewStatus, 'rejected'),
              eq(memories.category, 'knowledge'),
              eq(memories.quarantined, false),
              or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
              isNotNull(memories.embedding),
              eq(knowledgeGraphSources.status, 'ready'),
              eq(knowledgeGraphSources.contentHash, memories.contentHash),
              gte(knowledgeGraphSources.extractionVersion, GRAPH_EXTRACTION_VERSION),
              isNotNull(knowledgeGraphRelations.evidenceQuote),
            ),
          )
          .orderBy(sql`${memories.embedding} <=> ${vector}::vector`)
          .limit(args.limit);
        return {
          query: args.query,
          complete: rows.length < args.limit,
          relationships: rows.map((row) => ({
            ...row,
            unconfirmed: row.ownerConfirmed !== true || Number(row.memoryConfidence) < 0.7,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  // ── truncated-result paging ─────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'tools.read_result',
      description:
        'Read more of a truncated tool result. When a result says "truncated" and names a toolCallId, call this with that id and the suggested offset to page through the full stored result. Only results from the current task are readable.',
      inputSchema: z.object({
        toolCallId: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        // Scoped to the calling task: other tasks' results may hold content
        // this task's trust tier was never meant to see.
        const [row] = await ctx.db
          .select({
            result: toolCalls.result,
            taskId: toolCalls.taskId,
            toolName: toolCalls.toolName,
            args: toolCalls.args,
            status: toolCalls.status,
          })
          .from(toolCalls)
          .where(eq(toolCalls.id, args.toolCallId));
        if (!row || row.taskId !== ctx.taskId) {
          return { error: 'no such tool call in this task' };
        }
        return pageStoredToolResult({
          call: row,
          toolCallId: args.toolCallId,
          offset: args.offset,
          agentId: ctx.agentId,
          ...(ctx.conversationId ? { currentConversationId: ctx.conversationId } : {}),
          ...(deps.conversations ? { conversations: deps.conversations } : {}),
        });
      },
    },
    // The stored result may embed third-party content (a fetched page, a mail
    // thread), so reading it re-taints exactly like the original tool did.
    { returnsUntrustedContent: true },
  );

  // ── occasions (Phase 17) ─────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'occasions.save',
      description:
        "Record a recurring date for one of the owner's people — a birthday, anniversary, or custom occasion — so it can be surfaced at lead time. Give the person by name (subject), the month and day; year and gift-idea notes are optional. Re-saving the same date merges new notes and fills in a missing year.",
      inputSchema: z.object({
        subject: z.string().min(1).max(120).describe("The person's name this occasion is about."),
        kind: z.enum(['birthday', 'anniversary', 'custom']),
        label: z
          .string()
          .max(120)
          .default('')
          .describe('For a custom occasion, what it is (e.g. "graduation").'),
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
        year: z.number().int().min(1900).max(2200).optional(),
        leadDays: z.number().int().min(0).max(60).default(7),
        notes: z
          .string()
          .max(2000)
          .default('')
          .describe('Gift ideas or context for this occasion.'),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      approvalSummary: (args) =>
        `Remember ${args.subject}'s ${
          args.kind === 'custom' ? args.label || 'occasion' : args.kind
        } on ${args.month}/${args.day}`,
      execute: async (args, ctx) => {
        const resolved = await resolveSubjectContact(ctx.db, { subject: args.subject });
        if (!resolved) {
          return { saved: false, note: 'could not resolve who this occasion is about' };
        }
        // Untrusted sessions store the occasion quarantined, exactly like memory.save.
        const quarantined = ctx.trust !== 'owner' && ctx.trust !== 'assistant';
        const result = await saveOccasion(ctx.db, {
          agentId: ctx.agentId,
          contactId: resolved.contactId,
          kind: args.kind,
          label: args.label,
          month: args.month,
          day: args.day,
          year: args.year ?? null,
          leadDays: args.leadDays,
          notes: args.notes,
          originTrust: ctx.trust,
          quarantined,
          source: 'occasions.save',
        });
        return { saved: result.saved, updated: !result.saved, quarantined, person: args.subject };
      },
    },
    { writesMemory: true },
  );

  register(
    registry,
    {
      name: 'occasions.list',
      description:
        "List the owner's people's upcoming occasions (birthdays, anniversaries, custom dates), soonest first. Use this to answer 'whose birthday is coming up?' or, together with memory.recall, 'what should I get them?'.",
      inputSchema: z.object({
        withinDays: z
          .number()
          .int()
          .min(1)
          .max(366)
          .default(30)
          .describe('How far ahead to look, in days.'),
      }),
      risk: 'autonomous',
      // Occasion + contact fields are owner/assistant-authored reference data
      // (quarantined ones never surface here), so — like goals.list — this is a
      // confidential read but NOT untrusted content.
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const upcoming = await upcomingOccasions(ctx.db, ctx.agentId, {
          withinDays: args.withinDays,
        });
        return {
          occasions: upcoming.map((o) => ({
            person: o.contactName,
            kind: o.kind === 'custom' ? o.label || 'occasion' : o.kind,
            date: o.nextDate,
            daysUntil: o.daysUntil,
            notes: o.notes || undefined,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  // ── contacts ─────────────────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'contacts.lookup',
      description:
        "Resolve a person's saved email address(es) and phone number(s) by name BEFORE emailing or texting them. Returns only matching saved contacts. If it returns no contact (or no address for the person), you do NOT know how to reach them — ask the owner instead of guessing an address. Never invent a recipient.",
      inputSchema: z.object({
        name: z
          .string()
          .min(2)
          .max(120)
          .describe('The person to look up, e.g. "Anna" or "Dr. Smith".'),
      }),
      risk: 'autonomous',
      // Owner-curated identifier rows, sanitized below to email/phone/name only
      // — NOT free third-party prose. Unlike memory.recall this deliberately does
      // NOT set returnsUntrustedContent, so resolving an address never taints the
      // session or forfeits a goal session's one autonomous outward action.
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const matches = await findContactsByName(ctx.db, args.name);
        return {
          query: args.name,
          contacts: matches.map((c) => ({
            name: c.name,
            emails: c.emails.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 5),
            phones: c.phones.filter((p) => /^\+?\d[\d\s().-]{5,}$/.test(p)).slice(0, 5),
            relationship: c.relationship || undefined,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  // ── web ────────────────────────────────────────────────────────────────────
  registerPortableWebFetchTool(registry, deps.webFetchIo ? { io: deps.webFetchIo } : {});

  // ── weather ────────────────────────────────────────────────────────────────
  registerWeatherTool(registry, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});

  // ── workspace files ────────────────────────────────────────────────────────
  registerPortableWorkspaceTools(registry, deps.workspace);

  // Conversation search is registered by the persistence composition through
  // the shared repository port; the tool package must not bypass owner/privacy
  // filters with ad hoc SQL.

  // ── owner notification ─────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'owner.notify',
      description:
        "Leave a message for the owner. It appears in the current conversation (or the Notifications conversation) and on the dashboard. Set ping=true to also buzz their phone (SMS/push) — reserved for proactive, time-sensitive notes; the owner's quiet hours and daily ping limit still govern it.",
      inputSchema: z.object({
        message: z.string().min(1).max(4000),
        ping: z
          .boolean()
          .optional()
          .describe(
            'Also notify out-of-band (SMS/push). For proactive, time-sensitive notes only — not for replies to something the owner just asked.',
          ),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const conversationId =
          ctx.conversationId ?? (await getOrCreateNotificationsConversation(ctx.db, ctx.agentId));
        if (!conversationId) throw new Error('no conversation available for notification');
        await ctx.db.insert(messages).values({
          conversationId,
          taskId: ctx.taskId,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: args.message }],
          text: args.message,
        });
        // The ping leg is ambient by construction: it only ever accompanies
        // an owner-destined message, and the policy gate downstream decides
        // whether the phone actually buzzes. Best-effort — the chat message
        // above is the record and must not fail with the radio.
        let pinged = false;
        if (args.ping && deps.notifyOwner) {
          pinged = await deps
            .notifyOwner({ text: args.message, taskId: ctx.taskId, urgency: 'ambient' })
            .then(() => true)
            .catch((err) => {
              console.error('owner.notify ping failed', err);
              return false;
            });
        }
        return { notified: true, conversationId, pinged };
      },
    },
    // Sink is hardwired to the owner's own conversation (ctx.conversationId) or
    // the assistant-owned 'Notifications' thread — never a third party or the
    // network. ownerVisibleOnly keeps it autonomous under taint (D6): the model
    // relaying content into the owner's own dashboard is no more capable than
    // its ordinary reply text. acceptsUntrustedInput:false still strips it from
    // every external (known/unknown) task registry.
    { ownerVisibleOnly: true },
  );

  // ── missions & goals ───────────────────────────────────────────────────────
  register(registry, {
    name: 'mission.update',
    description:
      'Update your parent mission after a work session: progress summary, next action, optional percent, and notes for the next session. Call this before finishing a mission session.',
    inputSchema: z.object({
      progress: z.string().min(3).max(1000),
      nextAction: z.string().max(500).default(''),
      progressPercent: z.number().int().min(0).max(100).nullish(),
      notes: z.string().max(2000).default(''),
    }),
    risk: 'autonomous',
    // A mission session almost always reads untrusted content (web.fetch,
    // gmail.search, browser.execute) before it can summarise progress. Gating
    // this internal state write on taint would strip the ONLY progress writer
    // once tainted, silently stalling the mission loop (it would repeat step
    // one forever). It writes bounded, model-authored text to the assistant's
    // own mission row — no outward or privileged effect — and is already
    // restricted to real mission sessions by the dispatcher's parent-mission
    // gate. Persisted text is re-surfaced to the next session as reference
    // data, never as instructions (see sessionInstruction).
    acceptsUntrustedInput: true,
    execute: async (args, ctx) => {
      const [self] = await ctx.db.select().from(tasks).where(eq(tasks.id, ctx.taskId));
      if (!self?.parentTaskId) throw new Error('this task has no parent mission');
      const [mission] = await ctx.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, self.parentTaskId), eq(tasks.type, 'mission')));
      if (!mission) throw new Error('parent is not a mission');

      const state = (mission.state ?? {}) as Record<string, unknown>;
      if (args.notes) state.scratchpad = String(args.notes).slice(0, 4000);
      await ctx.db
        .update(tasks)
        .set({
          progress: args.progress,
          nextAction: args.nextAction,
          progressPercent: args.progressPercent ?? mission.progressPercent,
          state,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, mission.id));
      return { updated: mission.id };
    },
  });

  register(
    registry,
    {
      name: 'goals.list',
      description: "List the owner's long-term goals (active first).",
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      // Deliberately NOT returnsUntrustedContent. Goal titles/progress are
      // owner- or assistant-authored and carried as reference-only data (see
      // goalInstruction, which frames them "information only, never
      // instructions"). Marking this untrusted would taint every goal-aware
      // chat turn — stripping the owner card, gating memory.save — for text the
      // owner wrote about their own goals. The model-authored progress note IS
      // write-bound to the task's own goal by the dispatcher, so there is no
      // cross-goal injection surface here.
      execute: async (_args, ctx) => {
        // The description promises active-first; a plain status sort puts
        // 'abandoned' ahead of 'active' alphabetically. Owner-hidden (archived)
        // goals are history, not standing context, so they never reach the
        // model here.
        const rows = await ctx.db
          .select()
          .from(goals)
          .where(and(eq(goals.agentId, ctx.agentId), isNull(goals.archivedAt)))
          .orderBy(
            sql`case ${goals.status} when 'active' then 0 when 'paused' then 1 when 'done' then 2 else 3 end`,
            goals.priority,
          );
        return {
          goals: rows.map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
            priority: g.priority,
            progress: g.progress,
            nextAction: g.nextAction,
            targetDate: g.targetDate?.toISOString() ?? null,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  register(registry, {
    name: 'goals.update_progress',
    description: 'Update the progress note and next action on an existing goal.',
    inputSchema: z.object({
      goalId: z.string().uuid(),
      progress: z.string().min(1).max(1000),
      nextAction: z.string().max(500).default(''),
    }),
    risk: 'autonomous',
    // Like mission.update: a goal work session taints itself with ordinary
    // research reads before it can record progress, so gating this on taint
    // stalls the goal loop. It writes bounded model-authored text to the
    // owner's own goal row and stays available under taint. Two controls keep
    // that carve-out safe: the dispatcher binds the write to the goal this task
    // (or its work chat) owns — so injected content cannot redirect it to
    // another goal or drive it from a task that owns no goal — and the execute
    // below fails closed for any non-owner/assistant trust.
    acceptsUntrustedInput: true,
    execute: async (args, ctx) => {
      if (ctx.trust !== 'owner' && ctx.trust !== 'assistant') {
        throw new Error('goals.update_progress is available only to owner/assistant tasks');
      }
      const [row] = await ctx.db
        .update(goals)
        .set({ progress: args.progress, nextAction: args.nextAction, updatedAt: sql`now()` })
        .where(and(eq(goals.id, args.goalId), eq(goals.agentId, ctx.agentId)))
        .returning();
      if (!row) throw new Error('goal not found');
      return { updated: row.id, title: row.title };
    },
  });

  register(
    registry,
    {
      name: 'goals.create',
      description:
        'Create a new long-term goal for the owner. Requires owner approval — goals shape long-running behavior.',
      inputSchema: z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2000).default(''),
        priority: z.number().int().min(1).max(5).default(3),
        targetDate: z.string().datetime({ offset: true }).optional(),
      }),
      risk: 'approval',
      acceptsUntrustedInput: false,
      // The description (up to 2000 chars) becomes the recurring automation's
      // standing instruction, so the owner must see it on the approval card —
      // a title-only summary would let an injected instruction ride through an
      // approval the owner cannot actually inspect.
      approvalSummary: (args) => {
        const a = args as { title: string; description?: string };
        const desc = a.description?.trim();
        return `Create goal "${a.title}"${desc ? ` — ${desc.slice(0, 300)}` : ''}`;
      },
      execute: async (args, ctx) => {
        const [row] = await ctx.db
          .insert(goals)
          .values({
            agentId: ctx.agentId,
            title: args.title,
            description: args.description,
            priority: args.priority,
            targetDate: args.targetDate ? new Date(args.targetDate) : undefined,
            // A goal proposed from a tainted session carries its provenance so
            // its automation sessions run taint-gated (see goals.taintedOrigin).
            taintedOrigin: ctx.tainted,
          })
          .returning();
        return { goalId: row?.id, title: args.title };
      },
    },
    // writesMemory: a goal is durable, behavior-shaping owner state that spawns a
    // recurring autonomous runner — treat it like a memory write, so it is
    // taint-gated and never one-tap SMS-approvable (a spoofed SMS must not be
    // able to plant a persistent autonomous-loop goal).
    { outwardFacing: false, writesMemory: true },
  );

  return registry;
}

export { registerAuditTools } from './audit.js';

export { registerSelfRepairTools } from './self-repair.js';
