import { createHash } from 'node:crypto';
import {
  commitments,
  conversations,
  createPostgresOwnerContextRepository,
  type Db,
  listEligibleOwnerCommitments,
  lockPostgresPrivacyObservationFence,
  messages,
} from '@assistant/db';
import {
  type CommitmentMaintenanceRepository,
  type CommitmentMaintenanceResult,
  isOwnerContextRepository,
  type OwnerCommitment,
  type OwnerContextRepository,
} from '@assistant/persistence';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ModelRouter } from '../model-router/router.js';

export const CommitmentKindSchema = z.enum(['decision', 'question', 'promise', 'waiting_on']);
export const CommitmentStatusSchema = z.enum(['open', 'resolved', 'snoozed', 'dismissed', 'stale']);

const ExtractedCommitmentSchema = z.object({
  kind: CommitmentKindSchema,
  title: z.string().min(8).max(180),
  details: z.string().max(500).default(''),
  nextAction: z.string().max(240).default(''),
  dueAt: z.string().max(40).default(''),
  confidence: z.number().min(0.8).max(1).default(0.9),
  // These IDs come from the owner-labeled transcript below. Titles and details
  // are model-authored and can change on replay; owner message identity cannot.
  sourceMessageIds: z.array(z.string().uuid()).min(1).max(12),
});
const CommitmentExtractionSchema = z.object({
  commitments: z.array(ExtractedCommitmentSchema).max(12),
  resolvedTitles: z.array(z.string().min(3).max(180)).max(12).default([]),
});

export type CommitmentKind = z.infer<typeof CommitmentKindSchema>;
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export interface CommitmentExtractionDeps {
  db: Db;
  router: ModelRouter;
  heartbeat?: () => Promise<void>;
  persistence?: import('@assistant/persistence').ExecutionPersistence;
}

export interface CommitmentExtractionResult {
  conversationsScanned: number;
  saved: number;
  duplicates: number;
}

const MAX_CONVERSATIONS = 20;
const MAX_MESSAGES = 80;
const MIN_CONFIDENCE = 0.85;

function hashCommitment(kind: string, title: string, details: string): string {
  return createHash('sha256')
    .update(`${kind}\n${title.trim().toLowerCase()}\n${details.trim().toLowerCase()}`)
    .digest('hex');
}

function normalizedTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseDueAt(value: string): Date | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const EXTRACTION_SYSTEM = [
  'Extract explicit conversational open loops from an owner/assistant transcript.',
  'Return only high-confidence items that should still matter after this conversation.',
  'decision = an explicit choice or settled direction that may need to be remembered.',
  'question = an unanswered question the owner or assistant explicitly left open.',
  'promise = an explicit future task or follow-up, but only when it is concrete.',
  'waiting_on = an explicit dependency on a person, reply, approval, document, or event.',
  'Do not extract pleasantries, vague intentions, hypothetical advice, or assistant promises that have no durable task, schedule, mission, watch, or approval behind them.',
  'Every item must be a loop the OWNER still has to act on or decide. Work the assistant has already automated — anything a schedule, task, mission, or watch is carrying — is not a loop, however concrete it sounds.',
  'Never extract the assistant describing its own background work, and never treat a job, schedule, or task name as a promise.',
  'If the owner clearly says an existing loop is done, cancelled, dismissed, or no longer needed, put its concise title in resolvedTitles. Otherwise leave resolvedTitles empty.',
  'Do not invent dates. dueAt must be an ISO timestamp only when the transcript states a concrete date/time.',
  'Use concise titles that make sense without the transcript. If there are no clear items, return an empty array.',
  'For every commitment, include sourceMessageIds: the exact UUIDs of the owner messages that establish it, copied from the transcript labels. Never cite assistant messages. If no owner message establishes it, omit the commitment.',
].join('\n');

function formatTranscript(rows: Array<{ id: string; role: string; text: string }>): string {
  return rows
    .map(
      (row) => `[message_id=${row.id}] ${row.role === 'user' ? 'owner' : 'assistant'}: ${row.text}`,
    )
    .join('\n')
    .slice(-8000);
}

function sourceOccurrenceKey(
  agentId: string,
  conversationId: string,
  kind: CommitmentKind,
  messageIds: string[],
): string {
  return `v1:${agentId}:${conversationId}:${kind}:${[...messageIds].sort().join(',')}`;
}

function citedOwnerMessages(
  item: z.infer<typeof ExtractedCommitmentSchema>,
  ordered: Array<{ id: string; role: string }>,
): string[] | null {
  const ownerIds = new Set(ordered.filter((row) => row.role === 'user').map((row) => row.id));
  const ids = [...new Set(item.sourceMessageIds)];
  if (ids.length !== item.sourceMessageIds.length || ids.some((id) => !ownerIds.has(id)))
    return null;
  const position = new Map(ordered.map((row, index) => [row.id, index]));
  return ids.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
}

/** Extracts commitments asynchronously; it never creates or executes a task. */
export async function extractCommitments(
  deps: CommitmentExtractionDeps,
  opts: {
    agentId: string;
    since?: Date;
    taskId?: string;
    /** The running task's current lease; portable stores commit only under it. */
    lease?: () => import('@assistant/persistence').CodeJobLease;
  },
): Promise<CommitmentExtractionResult> {
  const since = opts.since ?? new Date(Date.now() - 36 * 3600 * 1000);
  if (deps.persistence?.driver === 'firestore') {
    const repository = deps.persistence.memoryExtraction;
    if (!repository)
      throw new Error('Memory extraction repository is missing from Firestore persistence');
    if (!opts.lease) throw new Error('Firestore commitment extraction requires a task lease');
    return extractPortableCommitments(repository, deps, { ...opts, since, lease: opts.lease });
  }
  const active = await deps.db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.agentId, opts.agentId),
        gte(messages.createdAt, since),
        or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
        sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`,
      ),
    )
    .groupBy(messages.conversationId)
    .orderBy(desc(messages.conversationId))
    .limit(MAX_CONVERSATIONS);

  let saved = 0;
  let duplicates = 0;
  let conversationsScanned = 0;
  for (const { conversationId } of active) {
    await deps.heartbeat?.();
    const [conversation] = await deps.db
      .select({ trust: conversations.trust })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, opts.agentId)));
    // Owner threads only. Assistant-trust conversations are the machinery
    // talking to itself — scheduled runs, the Notifications thread, document
    // processing — where a schedule named `daily-briefing` becomes a task
    // title and reads back as "Complete daily-briefing", an open loop the
    // owner never opened and cannot close. `renderOpenCommitments` already
    // tells the model these come from owner conversations; this makes it true.
    if (conversation?.trust !== 'owner') continue;
    const rows = await deps.db
      .select({ id: messages.id, role: messages.role, text: messages.text })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gte(messages.createdAt, since),
          or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
          sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(MAX_MESSAGES);
    const ordered = rows.reverse();
    const transcript = formatTranscript(ordered);
    if (transcript.length < 40) continue;
    conversationsScanned += 1;
    const outcome = await deps.router.object<z.infer<typeof CommitmentExtractionSchema>>(
      'extract',
      {
        taskId: opts.taskId,
        schema: CommitmentExtractionSchema,
        system: EXTRACTION_SYSTEM,
        prompt: transcript,
      },
    );
    if (!outcome.ok) continue;
    const activeRows = outcome.object.resolvedTitles.length
      ? await listEligibleOwnerCommitments(deps.db, {
          agentId: opts.agentId,
          limit: 60,
          visibility: 'resolvable',
        })
      : [];
    for (const resolvedTitle of outcome.object.resolvedTitles) {
      const needle = normalizedTitle(resolvedTitle);
      if (needle.length < 3) continue;
      const matches = activeRows.filter(
        (row) => !row.reopenedFromId && normalizedTitle(row.title) === needle,
      );
      const [match] = matches;
      if (matches.length === 1 && match) {
        await resolveCommitment(
          deps.db,
          opts.agentId,
          match.id,
          'Owner confirmed this loop is resolved.',
        );
      }
    }
    for (const item of outcome.object.commitments) {
      if (item.confidence < MIN_CONFIDENCE) continue;
      const sourceMessageIds = citedOwnerMessages(item, ordered);
      if (!sourceMessageIds?.length) continue;
      const title = item.title.trim();
      const details = item.details.trim();
      const hash = hashCommitment(item.kind, title, details);
      const occurrenceKey = sourceOccurrenceKey(
        opts.agentId,
        conversationId,
        item.kind,
        sourceMessageIds,
      );
      const inserted = await deps.db
        .insert(commitments)
        .values({
          agentId: opts.agentId,
          conversationId,
          sourceMessageId: sourceMessageIds.at(-1),
          sourceTaskId: opts.taskId,
          sourceOccurrenceKey: occurrenceKey,
          kind: item.kind,
          title,
          details,
          nextAction: item.nextAction.trim(),
          dueAt: parseDueAt(item.dueAt),
          confidence: item.confidence.toFixed(2),
          contentHash: hash,
        })
        .onConflictDoNothing()
        .returning({ id: commitments.id });
      if (inserted.length) saved += 1;
      else {
        duplicates += 1;
        // Deliberately no updatedAt: re-extraction is the assistant noticing the
        // same loop again, not the owner touching it. Bumping the clock here
        // meant any loop the nightly pass kept regenerating — recurring job
        // names above all — reset its own idle window every night and could
        // never go stale, which is exactly how the list filled up with loops
        // nobody had thought about in months.
        await deps.db
          .update(commitments)
          .set({
            conversationId,
            sourceMessageId: sourceMessageIds.at(-1),
            sourceTaskId: opts.taskId,
            nextAction: item.nextAction.trim(),
            dueAt: parseDueAt(item.dueAt),
            confidence: item.confidence.toFixed(2),
          })
          .where(
            and(
              eq(commitments.agentId, opts.agentId),
              eq(commitments.sourceOccurrenceKey, occurrenceKey),
              inArray(commitments.status, ['open', 'snoozed', 'stale']),
              isNull(commitments.resolvedAt),
            ),
          );
      }
    }
  }
  return { conversationsScanned, saved, duplicates };
}

/**
 * The same pass over a portable store. Each conversation's loops and
 * resolutions commit with a per-task checkpoint, so a reclaimed task picks up
 * after the last conversation it finished.
 */
async function extractPortableCommitments(
  repository: import('@assistant/persistence').MemoryExtractionRepository,
  deps: CommitmentExtractionDeps,
  opts: {
    agentId: string;
    since: Date;
    taskId?: string;
    lease: () => import('@assistant/persistence').CodeJobLease;
  },
): Promise<CommitmentExtractionResult> {
  const active = await repository.recentConversations({
    agentId: opts.agentId,
    since: opts.since,
    maxConversations: MAX_CONVERSATIONS,
    maxMessages: MAX_MESSAGES,
    minTextLength: 0,
  });
  const done = new Set(await repository.completedSteps(opts.agentId, opts.lease()));
  let saved = 0;
  let duplicates = 0;
  let conversationsScanned = 0;
  for (const conversation of active) {
    await deps.heartbeat?.();
    // Owner threads only, for the reason spelled out in extractCommitments.
    if (conversation.trust !== 'owner') continue;
    const checkpointKey = `commitments:${conversation.conversationId}`;
    if (done.has(checkpointKey)) continue;
    const transcript = formatTranscript(conversation.messages);
    if (transcript.length < 40) continue;
    conversationsScanned += 1;
    const outcome = await deps.router.object<z.infer<typeof CommitmentExtractionSchema>>(
      'extract',
      {
        taskId: opts.taskId,
        schema: CommitmentExtractionSchema,
        system: EXTRACTION_SYSTEM,
        prompt: transcript,
      },
    );
    if (!outcome.ok) continue;
    await deps.heartbeat?.();
    const activeRows = outcome.object.resolvedTitles.length
      ? await repository.activeCommitments(opts.agentId, 60)
      : [];
    const resolveIds: string[] = [];
    for (const resolvedTitle of outcome.object.resolvedTitles) {
      const needle = normalizedTitle(resolvedTitle);
      if (needle.length < 3) continue;
      const matches = activeRows.filter(
        (row) => !row.reopenedFromId && normalizedTitle(row.title) === needle,
      );
      const [match] = matches;
      if (matches.length === 1 && match && !resolveIds.includes(match.id))
        resolveIds.push(match.id);
    }
    const items = outcome.object.commitments.flatMap((item) => {
      if (item.confidence < MIN_CONFIDENCE) return [];
      const sourceMessageIds = citedOwnerMessages(item, conversation.messages);
      if (!sourceMessageIds?.length) return [];
      const title = item.title.trim();
      const details = item.details.trim();
      return [
        {
          kind: item.kind,
          title,
          details,
          nextAction: item.nextAction.trim(),
          dueAt: parseDueAt(item.dueAt),
          confidence: item.confidence.toFixed(2),
          contentHash: hashCommitment(item.kind, title, details),
          sourceMessageIds,
          sourceMessageId: sourceMessageIds.at(-1) as string,
          sourceOccurrenceKey: sourceOccurrenceKey(
            opts.agentId,
            conversation.conversationId,
            item.kind,
            sourceMessageIds,
          ),
        },
      ];
    });
    const applied = await repository.applyCommitments({
      agentId: opts.agentId,
      lease: opts.lease(),
      checkpointKey,
      conversationId: conversation.conversationId,
      resolveIds,
      resolution: 'Owner confirmed this loop is resolved.',
      commitments: items,
    });
    if (!applied) continue;
    saved += applied.saved;
    duplicates += applied.duplicates;
  }
  return { conversationsScanned, saved, duplicates };
}

export async function listOpenCommitments(
  store: Db | OwnerContextRepository,
  args: { agentId: string; query?: string; limit?: number; now?: Date },
): Promise<OwnerCommitment[]> {
  const now = args.now ?? new Date();
  const candidateLimit = Math.min(args.limit ?? 40, 60);
  const rows = isOwnerContextRepository(store)
    ? await store.listOpenCommitments({ agentId: args.agentId, now, limit: candidateLimit })
    : await createPostgresOwnerContextRepository(store).listOpenCommitments({
        agentId: args.agentId,
        now,
        limit: candidateLimit,
      });
  const terms = (args.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 4);
  if (!terms.length) return rows.slice(0, args.limit ?? 8);
  const scored = rows
    .map((row) => ({
      row,
      score: terms.reduce(
        (score, term) => score + (JSON.stringify(row).toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
  return scored.slice(0, args.limit ?? 8).map((entry) => entry.row);
}

/** Recently closed loops stay available for an explicit, reviewable reopen. */
export async function listRecentlyClosedCommitments(
  db: Db,
  args: { agentId: string; limit?: number },
) {
  const limit = Math.min(Math.max(args.limit ?? 12, 1), 30);
  const candidates = await listEligibleOwnerCommitments(db, {
    agentId: args.agentId,
    limit: limit * 4,
    visibility: 'closed',
  });
  const candidateIds = candidates.map((row) => row.id);
  const children = candidateIds.length
    ? await db
        .select({ reopenedFromId: commitments.reopenedFromId })
        .from(commitments)
        .where(
          and(
            eq(commitments.agentId, args.agentId),
            inArray(commitments.reopenedFromId, candidateIds),
          ),
        )
    : [];
  const reopened = new Set(children.map((row) => row.reopenedFromId));
  return candidates.filter((row) => !reopened.has(row.id)).slice(0, limit);
}

/**
 * Reopening is a new owner-authored occurrence. The closed source row and its
 * model replay key are immutable, so old extraction output cannot undo closure.
 */
export async function reopenCommitment(
  db: Db,
  agentId: string,
  id: string,
  expectedUpdatedAt: Date,
  operationId: string,
): Promise<{ commitmentId: string; replay: boolean } | null> {
  if (
    !agentId ||
    !id ||
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    !z.string().uuid().safeParse(operationId).success
  )
    return null;
  try {
    return await db.transaction(async (tx) => {
      await lockPostgresPrivacyObservationFence(tx as unknown as Db, agentId);
      const [replay] = await tx
        .select({ id: commitments.id, reopenedFromId: commitments.reopenedFromId })
        .from(commitments)
        .where(
          and(eq(commitments.agentId, agentId), eq(commitments.reopenOperationId, operationId)),
        )
        .limit(1);
      if (replay) {
        return replay.reopenedFromId === id ? { commitmentId: replay.id, replay: true } : null;
      }

      const [closed] = await tx
        .select()
        .from(commitments)
        .where(
          and(
            eq(commitments.agentId, agentId),
            eq(commitments.id, id),
            eq(commitments.updatedAt, expectedUpdatedAt),
            inArray(commitments.status, ['resolved', 'dismissed']),
          ),
        )
        .for('update')
        .limit(1);
      if (!closed || !closed.resolvedAt) return null;

      const [existingChild] = await tx
        .select({ id: commitments.id })
        .from(commitments)
        .where(and(eq(commitments.agentId, agentId), eq(commitments.reopenedFromId, closed.id)))
        .limit(1);
      if (existingChild) return null;

      const [newerOpen] = await tx
        .select({ id: commitments.id })
        .from(commitments)
        .where(
          and(
            eq(commitments.agentId, agentId),
            eq(commitments.contentHash, closed.contentHash),
            inArray(commitments.status, ['open', 'snoozed', 'stale']),
            isNull(commitments.resolvedAt),
          ),
        )
        .limit(1);
      if (newerOpen) return null;

      const [created] = await tx
        .insert(commitments)
        .values({
          agentId,
          conversationId: closed.conversationId,
          sourceMessageId: closed.sourceMessageId,
          sourceTaskId: null,
          sourceOccurrenceKey: `manual-reopen:v1:${agentId}:${operationId}`,
          reopenedFromId: closed.id,
          reopenOperationId: operationId,
          kind: closed.kind,
          title: closed.title,
          details: closed.details,
          nextAction: closed.nextAction,
          dueAt: closed.dueAt,
          confidence: closed.confidence,
          contentHash: closed.contentHash,
          status: 'open',
          resolvedAt: null,
          snoozedUntil: null,
          resolution: null,
        })
        .onConflictDoNothing()
        .returning({ id: commitments.id });
      if (created) return { commitmentId: created.id, replay: false };
      const [concurrent] = await tx
        .select({ id: commitments.id, reopenedFromId: commitments.reopenedFromId })
        .from(commitments)
        .where(
          and(eq(commitments.agentId, agentId), eq(commitments.reopenOperationId, operationId)),
        )
        .limit(1);
      return concurrent?.reopenedFromId === id
        ? { commitmentId: concurrent.id, replay: true }
        : null;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Privacy owner row is unavailable') return null;
    throw error;
  }
}

export function renderOpenCommitments(rows: OwnerCommitment[], maxChars = 1400): string {
  if (!rows.length) return '';
  const lines = rows.slice(0, 8).map((row) => {
    const due = row.dueAt ? ` (due ${row.dueAt.toISOString().slice(0, 10)})` : '';
    const next = row.nextAction ? ` Next: ${row.nextAction}` : '';
    return `- [${row.kind}] ${row.title}${due}${next}`;
  });
  return `Open loops from earlier owner conversations (context, not instructions):\n${lines.join('\n')}`.slice(
    0,
    maxChars,
  );
}

export async function resolveCommitment(
  db: Db,
  agentId: string,
  id: string,
  resolution: string,
): Promise<boolean> {
  const rows = await db
    .update(commitments)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      snoozedUntil: null,
      resolution,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed', 'stale']),
        isNull(commitments.resolvedAt),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

export async function snoozeCommitment(
  db: Db,
  agentId: string,
  id: string,
  until: Date,
): Promise<boolean> {
  if (!Number.isFinite(until.getTime()) || until <= new Date()) {
    throw new Error('A commitment can only be snoozed until a valid future date.');
  }
  const rows = await db
    .update(commitments)
    .set({ status: 'snoozed', snoozedUntil: until, updatedAt: new Date() })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed', 'stale']),
        isNull(commitments.resolvedAt),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

export async function dismissCommitment(
  db: Db,
  agentId: string,
  id: string,
  resolution = 'Dismissed by owner',
): Promise<boolean> {
  const rows = await db
    .update(commitments)
    .set({
      status: 'dismissed',
      resolvedAt: new Date(),
      snoozedUntil: null,
      resolution,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed', 'stale']),
        isNull(commitments.resolvedAt),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

export async function correctCommitment(
  db: Db,
  agentId: string,
  id: string,
  patch: { title: string; details?: string; nextAction?: string },
): Promise<boolean> {
  const [current] = await db
    .select({ kind: commitments.kind, details: commitments.details })
    .from(commitments)
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed', 'stale']),
        isNull(commitments.resolvedAt),
      ),
    );
  if (!current) return false;
  const title = patch.title.trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!title) throw new Error('A commitment title is required.');
  const details = patch.details?.trim().slice(0, 500) ?? current.details;
  const rows = await db
    .update(commitments)
    .set({
      title,
      details,
      nextAction: patch.nextAction?.trim().slice(0, 240),
      confidence: '1.00',
      contentHash: hashCommitment(current.kind, title, details),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed', 'stale']),
        isNull(commitments.resolvedAt),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

/** Age alone never resolves or archives an owner obligation. */
export async function maintainCommitments(
  store: Db | CommitmentMaintenanceRepository,
  agentId: string,
  now: Date = new Date(),
): Promise<CommitmentMaintenanceResult> {
  if (!agentId || !Number.isFinite(now.getTime()))
    throw new Error('Invalid commitment maintenance');
  if ('kind' in store && store.kind === 'commitment-maintenance-repository')
    return store.maintain(agentId, now);
  const db = store as Db;
  // The predicates are rechecked by each update; a concurrent owner closure wins.
  const woken = await db
    .update(commitments)
    .set({ status: 'open', snoozedUntil: null, updatedAt: now })
    .where(
      and(
        eq(commitments.agentId, agentId),
        isNull(commitments.resolvedAt),
        eq(commitments.status, 'snoozed'),
        lte(commitments.snoozedUntil, now),
      ),
    )
    .returning({ id: commitments.id });
  const restored = await db
    .update(commitments)
    .set({ status: 'open', snoozedUntil: null, updatedAt: now })
    .where(
      and(
        eq(commitments.agentId, agentId),
        isNull(commitments.resolvedAt),
        eq(commitments.status, 'stale'),
      ),
    )
    .returning({ id: commitments.id });
  return { woken: woken.length, restored: restored.length };
}
