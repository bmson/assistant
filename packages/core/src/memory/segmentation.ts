import type { Db } from '@assistant/db';
import { conversationSegments, conversations, messages } from '@assistant/db';
import type {
  ConversationSegmentationRepository,
  ConversationSegmentInput,
} from '@assistant/persistence';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { ModelRouter } from '../model-router/router.js';

/**
 * Topic segmentation for the long-running chat (Phase 2 of
 * docs/long-running-chat-memory.md). Walks each owner thread's messages that
 * are newer than the last recorded segment, groups a contiguous run into a
 * segment whenever the topic drifts or a long time gap opens, then summarizes
 * and embeds each settled group. Recall matches those summary embeddings — a
 * far better retrieval unit than lone messages.
 *
 * Runs offline as the `chat.segment` code job. Never on the chat hot path.
 */

/** Only the router surface segmentation needs — keeps the fake in tests small. */
type Summarizer = Pick<ModelRouter, 'embed' | 'generate' | 'embeddingSpace'>;

export interface SegmentationOptions {
  taskId?: string;
  /** Restrict to one agent's conversations (the code job passes the task's agent). */
  agentId?: string;
  /** Injectable clock — the trailing-group settle test uses it. */
  now?: Date;
  /** A gap larger than this between consecutive messages forces a boundary. */
  gapMs?: number;
  /** Cosine similarity to the running centroid below which the topic is deemed to have shifted. */
  driftSimilarity?: number;
  /** Force-close a segment once it reaches this many messages. */
  maxMessages?: number;
  /** Don't close the trailing group while its last message is newer than this (topic may continue). */
  settleMs?: number;
  /** Ignore groups smaller than this — avoids one-line segments. */
  minMessages?: number;
  /** Conversations to scan per run. */
  maxConversations?: number;
  /** New segments to summarize per run (cost guard). */
  maxSegments?: number;
  /** Messages loaded per conversation per run. */
  perConversationMessageCap?: number;
}

export interface SegmentationResult {
  conversationsScanned: number;
  segmentsCreated: number;
}

const DEFAULTS = {
  gapMs: 6 * 60 * 60 * 1000,
  driftSimilarity: 0.6,
  maxMessages: 24,
  settleMs: 30 * 60 * 1000,
  minMessages: 1,
  maxConversations: 50,
  maxSegments: 40,
  perConversationMessageCap: 400,
} as const;

/** DEFAULTS merged with caller overrides — widened from the literal `as const`. */
type ResolvedOptions = { -readonly [K in keyof typeof DEFAULTS]: number };

interface Msg {
  id: string;
  role: string;
  text: string;
  createdAt: Date;
  embedding: number[] | null;
  embeddingSpaceKey: string | null;
}

/** pgvector may surface as number[] (drizzle) or the raw '[...]' string. */
function toVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function roleLabel(role: string): string {
  return role === 'assistant' ? 'assistant' : 'owner';
}

/** Where segmentation reads threads and records segments: SQL or a portable repository. */
interface SegmentStore {
  recentConversations(limit: number): Promise<Array<{ id: string; agentId: string }>>;
  unsegmentedMessages(
    conversationId: string,
    agentId: string,
    limit: number,
    embeddingSpaceKey: string,
  ): Promise<Msg[]>;
  commitSegment(input: ConversationSegmentInput): Promise<boolean>;
}

function repositoryStore(
  repository: ConversationSegmentationRepository,
  agentId: string | undefined,
): SegmentStore {
  if (!agentId) throw new Error('Portable chat segmentation requires an agent');
  return {
    recentConversations: async (limit) =>
      (await repository.recentConversations(agentId, limit)).map(({ id }) => ({ id, agentId })),
    unsegmentedMessages: (conversationId, owner, limit, embeddingSpaceKey) =>
      repository.unsegmentedMessages(owner, conversationId, limit, embeddingSpaceKey),
    commitSegment: (input) => repository.commitSegment(input),
  };
}

function sqlStore(db: Db, agentId: string | undefined): SegmentStore {
  return {
    recentConversations: (limit) =>
      db
        .select({ id: conversations.id, agentId: conversations.agentId })
        .from(conversations)
        .where(
          and(
            inArray(conversations.trust, ['owner', 'assistant']),
            agentId ? eq(conversations.agentId, agentId) : sql`true`,
          ),
        )
        .orderBy(sql`${conversations.updatedAt} desc`)
        .limit(limit),
    unsegmentedMessages: async (conversationId, _agentId, limit, embeddingSpaceKey) => {
      const [watermark] = await db
        .select({
          endedAt: conversationSegments.endedAt,
          endMessageId: conversationSegments.endMessageId,
        })
        .from(conversationSegments)
        .where(eq(conversationSegments.conversationId, conversationId))
        .orderBy(
          sql`${conversationSegments.endedAt} desc, ${conversationSegments.endMessageId} desc`,
        )
        .limit(1);

      const rows = await db
        .select({
          id: messages.id,
          role: messages.role,
          text: messages.text,
          createdAt: messages.createdAt,
          embedding: messages.embedding,
          embeddingSpaceKey: messages.embeddingSpaceKey,
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            inArray(messages.role, ['user', 'assistant']),
            sql`length(${messages.text}) > 0`,
            sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`,
            watermark
              ? or(
                  gt(messages.createdAt, watermark.endedAt),
                  and(
                    eq(messages.createdAt, watermark.endedAt),
                    gt(messages.id, watermark.endMessageId),
                  ),
                )
              : sql`true`,
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(limit);

      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        text: r.text,
        createdAt: r.createdAt,
        embedding: r.embeddingSpaceKey === embeddingSpaceKey ? toVector(r.embedding) : null,
        embeddingSpaceKey: r.embeddingSpaceKey,
      }));
    },
    commitSegment: async (input) => {
      const [row] = await db
        .insert(conversationSegments)
        .values(input)
        .onConflictDoNothing({
          target: [conversationSegments.conversationId, conversationSegments.startMessageId],
        })
        .returning({ id: conversationSegments.id });
      return Boolean(row);
    },
  };
}

export async function segmentConversations(
  deps: { db: Db; router: Summarizer; segments?: ConversationSegmentationRepository },
  options: SegmentationOptions = {},
): Promise<SegmentationResult> {
  const opts = {
    ...DEFAULTS,
    ...options,
    // Keep the summarizer input bounded even when a caller supplies a larger
    // batch size. Every committed segment therefore stays within one bounded
    // source span whose beginning and last turn both fit the prompt.
    maxMessages: Math.min(
      DEFAULTS.maxMessages,
      Number.isSafeInteger(options.maxMessages)
        ? Math.max(1, options.maxMessages as number)
        : DEFAULTS.maxMessages,
    ),
  };
  const now = options.now ?? new Date();
  const { router } = deps;
  const embeddingSpace = await router.embeddingSpace();
  const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  const store = deps.segments
    ? repositoryStore(deps.segments, options.agentId)
    : sqlStore(deps.db, options.agentId);

  const convos = await store.recentConversations(opts.maxConversations);

  let segmentsCreated = 0;
  let conversationsScanned = 0;
  for (const convo of convos) {
    if (segmentsCreated >= opts.maxSegments) break;
    conversationsScanned += 1;

    const msgs = await store.unsegmentedMessages(
      convo.id,
      convo.agentId,
      opts.perConversationMessageCap,
      embeddingSpaceKey,
    );
    // Do not move the committed range past a substantive message whose vector
    // is missing or belongs to another space. Short messages are intentionally
    // not embedded and still remain inside the next summary's source range.
    const unresolved = msgs.findIndex(
      (message) => message.embedding === null && [...message.text].length > 20,
    );
    const coveredPrefix = unresolved < 0 ? msgs : msgs.slice(0, unresolved);
    const groups = groupByTopic(coveredPrefix, opts, now);

    for (const group of groups) {
      if (segmentsCreated >= opts.maxSegments) break;
      const created = await commitSegment(
        store,
        router,
        convo.agentId,
        convo.id,
        group,
        opts.taskId,
        embeddingSpace,
        embeddingSpaceKey,
      );
      if (created === null) break; // keep later source turns behind the unresolved group
      if (created) segmentsCreated += 1;
    }
  }

  return { conversationsScanned, segmentsCreated };
}

/** Contiguous topic groups ready to commit. The trailing group is held back until settled. */
function groupByTopic(msgs: Msg[], opts: ResolvedOptions, now: Date): Msg[][] {
  const first = msgs[0];
  if (!first || msgs.length < opts.minMessages) return [];

  const groups: Msg[][] = [];
  let current: Msg[] = [first];
  let sum = first.embedding ? [...first.embedding] : [];
  let vectorCount = first.embedding ? 1 : 0;
  let prevCreatedAt = first.createdAt;

  for (let i = 1; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (!m) continue;
    const centroid = vectorCount > 0 ? sum.map((x) => x / vectorCount) : [];
    const gap = m.createdAt.getTime() - prevCreatedAt.getTime();
    const drifted = Boolean(
      m.embedding && vectorCount > 0 && cosine(m.embedding, centroid) < opts.driftSimilarity,
    );
    if (gap > opts.gapMs || drifted || current.length >= opts.maxMessages) {
      groups.push(current);
      current = [m];
      sum = m.embedding ? [...m.embedding] : [];
      vectorCount = m.embedding ? 1 : 0;
    } else {
      current.push(m);
      if (m.embedding) {
        if (vectorCount === 0) sum = [...m.embedding];
        else {
          for (let k = 0; k < sum.length; k += 1) {
            sum[k] = (sum[k] ?? 0) + (m.embedding[k] ?? 0);
          }
        }
        vectorCount += 1;
      }
    }
    prevCreatedAt = m.createdAt;
  }

  // Only commit the trailing group once the conversation has gone quiet, so an
  // in-progress topic isn't split prematurely.
  const lastMessage = current[current.length - 1];
  if (lastMessage && now.getTime() - lastMessage.createdAt.getTime() > opts.settleMs) {
    groups.push(current);
  }
  return groups.filter((group) => group.length >= opts.minMessages);
}

async function commitSegment(
  store: SegmentStore,
  router: Summarizer,
  agentId: string,
  conversationId: string,
  group: Msg[],
  taskId: string | undefined,
  embeddingSpace: import('@assistant/persistence').EmbeddingSpace,
  embeddingSpaceKey: string,
): Promise<boolean | null> {
  const first = group[0];
  const last = group[group.length - 1];
  if (!first || !last) return false;

  const transcript = group
    .map((m) => `${roleLabel(m.role)}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 500)}`)
    .join('\n');
  const summary = await summarize(router, transcript, taskId);
  if (!summary) return null;
  const [embedding] = await router.embed([summary], { taskId, expectedSpace: embeddingSpace });

  return store.commitSegment({
    agentId,
    conversationId,
    startMessageId: first.id,
    endMessageId: last.id,
    summary,
    embedding: embedding ?? null,
    embeddingSpaceKey: embedding ? embeddingSpaceKey : null,
    messageCount: group.length,
    startedAt: first.createdAt,
    endedAt: last.createdAt,
  });
}

async function summarize(
  router: Summarizer,
  transcript: string,
  taskId: string | undefined,
): Promise<string | null> {
  try {
    const res = await router.generate('extract', {
      taskId,
      system:
        'Summarize this slice of a chat between the owner and their assistant in one or two sentences. Capture the topic and any decision or outcome so it can be found again later. Output only the summary, with no preamble.',
      prompt: transcript,
      maxOutputTokens: 120,
    });
    if (res.ok && res.text.trim()) return res.text.trim().slice(0, 600);
  } catch (err) {
    console.error('segment summarization failed — keeping source turns unsegmented', err);
  }
  return null;
}
