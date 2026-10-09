import {
  type ConversationSearchRepository,
  type ConversationSearchSourceRef,
  conversationMessageSourceRevision,
  type Records,
  type ToolExecutionRepository,
} from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

const PAGE_CHARS = 30_000;
const SEARCH_LIMIT = 20;
// Search results are paged later, so bound the full untrusted payload before
// hashing source text or serializing it. 128 KiB of message text leaves ample
// room for JSON escaping and the bounded match metadata under this ceiling.
const MAX_SEARCH_TEXT_BYTES = 128 * 1024;
const MAX_SEARCH_RESULT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;
const SEARCH_ARGS = z
  .object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(SEARCH_LIMIT).default(5),
  })
  .strict();

type StoredToolCall = Pick<Records['toolCalls'], 'toolName' | 'args' | 'result' | 'status'>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function canonicalISODate(value: unknown): value is string {
  if (!boundedString(value, 24) || value.length !== 24) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validSearchTimestamp(value: unknown): value is Date | string {
  return value instanceof Date ? Number.isFinite(value.getTime()) : canonicalISODate(value);
}

function searchSourceRefs(
  call: StoredToolCall,
): { query: string; limit: number; refs: ConversationSearchSourceRef[] } | null {
  if (call.status !== 'succeeded') return null;
  const args = SEARCH_ARGS.safeParse(call.args);
  const result = record(call.result);
  if (
    !args.success ||
    !result ||
    !hasOnlyKeys(result, ['mode', 'matches']) ||
    result.truncated === true ||
    (result.mode !== 'semantic' && result.mode !== 'text') ||
    !Array.isArray(result.matches) ||
    result.matches.length > args.data.limit
  )
    return null;

  const matches: Array<{
    messageId: string;
    conversationId: string;
    sourceRevision: string;
    text: string;
  }> = [];
  const seen = new Set<string>();
  let totalTextBytes = 0;
  for (const candidate of result.matches) {
    const match = record(candidate);
    const allowedMatchKeys =
      result.mode === 'semantic'
        ? ['messageId', 'conversationId', 'sourceRevision', 'text', 'createdAt', 'similarity']
        : ['messageId', 'conversationId', 'sourceRevision', 'text', 'createdAt'];
    if (
      !match ||
      !hasOnlyKeys(match, allowedMatchKeys) ||
      typeof match.messageId !== 'string' ||
      !UUID.test(match.messageId) ||
      typeof match.conversationId !== 'string' ||
      !UUID.test(match.conversationId) ||
      typeof match.sourceRevision !== 'string' ||
      !REVISION.test(match.sourceRevision) ||
      !boundedString(match.text, MAX_SEARCH_TEXT_BYTES) ||
      !validSearchTimestamp(match.createdAt) ||
      (result.mode === 'semantic' &&
        (typeof match.similarity !== 'number' || !Number.isFinite(match.similarity))) ||
      seen.has(match.messageId)
    )
      return null;
    totalTextBytes += Buffer.byteLength(match.text, 'utf8');
    if (totalTextBytes > MAX_SEARCH_TEXT_BYTES) return null;
    seen.add(match.messageId);
    matches.push({
      messageId: match.messageId,
      conversationId: match.conversationId,
      sourceRevision: match.sourceRevision,
      text: match.text,
    });
  }
  // Do not hash any stored body until the aggregate byte limit has passed.
  const refs: ConversationSearchSourceRef[] = [];
  for (const match of matches) {
    if (conversationMessageSourceRevision(match.messageId, match.text) !== match.sourceRevision)
      return null;
    refs.push({
      messageId: match.messageId,
      conversationId: match.conversationId,
      sourceRevision: match.sourceRevision,
    });
  }
  return { query: args.data.query, limit: args.data.limit, refs };
}

function validRefreshResult(
  value: unknown,
  expectedRefs: number,
  limit: number,
): value is {
  unchangedSourceRefs: boolean[];
  matches: Array<{
    messageId: string;
    conversationId: string;
    sourceRevision: string;
    text: string;
  }>;
  mode: 'text';
  observationGeneration: string | null;
} {
  const result = record(value);
  return (
    result?.mode === 'text' &&
    hasOnlyKeys(result, ['mode', 'matches', 'unchangedSourceRefs', 'observationGeneration']) &&
    Array.isArray(result.unchangedSourceRefs) &&
    result.unchangedSourceRefs.length === expectedRefs &&
    result.unchangedSourceRefs.every((entry) => typeof entry === 'boolean') &&
    Array.isArray(result.matches) &&
    result.matches.length <= limit &&
    (() => {
      let totalTextBytes = 0;
      return result.matches.every((candidate) => {
        const match = record(candidate);
        if (
          !match ||
          !hasOnlyKeys(match, [
            'messageId',
            'conversationId',
            'sourceRevision',
            'text',
            'createdAt',
          ]) ||
          !boundedString(match.text, MAX_SEARCH_TEXT_BYTES)
        )
          return false;
        totalTextBytes += Buffer.byteLength(match.text, 'utf8');
        const createdAt = match.createdAt;
        const validDate =
          createdAt instanceof Date
            ? Number.isFinite(createdAt.getTime())
            : canonicalISODate(createdAt);
        return (
          totalTextBytes <= MAX_SEARCH_TEXT_BYTES &&
          typeof match.messageId === 'string' &&
          UUID.test(match.messageId) &&
          typeof match.conversationId === 'string' &&
          UUID.test(match.conversationId) &&
          typeof match.sourceRevision === 'string' &&
          REVISION.test(match.sourceRevision) &&
          validDate &&
          conversationMessageSourceRevision(match.messageId, match.text) === match.sourceRevision
        );
      });
    })() &&
    (result.observationGeneration === null ||
      (typeof result.observationGeneration === 'string' && result.observationGeneration.length > 0))
  );
}

/**
 * Page a stored result only after revalidating the typed source references of
 * conversation-search results. A changed, hidden, erased, malformed, or
 * unbound historical search is unavailable as a whole; callers can run a new
 * search. Other effect receipts retain their existing read-only paging path.
 */
export async function pageStoredToolResult(input: {
  call: StoredToolCall;
  toolCallId: string;
  offset: number;
  agentId: string;
  currentConversationId?: string;
  conversations?: Pick<ConversationSearchRepository, 'refreshForResume'>;
}): Promise<Record<string, unknown>> {
  if (input.call.toolName === 'conversations.search') {
    const parsed = searchSourceRefs(input.call);
    if (!parsed || !input.conversations) {
      return {
        error:
          'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
      };
    }
    try {
      const refreshed = await input.conversations.refreshForResume({
        agentId: input.agentId,
        ...(input.currentConversationId
          ? { currentConversationId: input.currentConversationId }
          : {}),
        query: parsed.query,
        limit: parsed.limit,
        sourceRefs: parsed.refs,
      });
      if (!validRefreshResult(refreshed, parsed.refs.length, parsed.limit))
        return {
          error:
            'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
        };
      if (!refreshed.unchangedSourceRefs.every(Boolean))
        return {
          error:
            'This stored conversation search changed. Run a fresh conversations.search before using its results.',
        };
    } catch {
      // Do not expose adapter/privacy-fence errors or fall back to old bytes.
      return {
        error:
          'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
      };
    }
  }

  const json = JSON.stringify(input.call.result ?? null);
  if (
    input.call.toolName === 'conversations.search' &&
    Buffer.byteLength(json, 'utf8') > MAX_SEARCH_RESULT_BYTES
  ) {
    return {
      error:
        'This stored conversation search is too large to read safely. Run a narrower conversations.search.',
    };
  }
  const chunk = json.slice(input.offset, input.offset + PAGE_CHARS);
  return {
    totalChars: json.length,
    offset: input.offset,
    chunk,
    hasMore: input.offset + chunk.length < json.length,
  };
}

/** `tools.read_result` over the tool-execution repository instead of the SQL row. */
export function registerPortableReadResultTool(
  registry: ToolRegistry,
  deps: {
    toolExecution: Pick<ToolExecutionRepository, 'load'>;
    conversations?: Pick<ConversationSearchRepository, 'refreshForResume'>;
  },
): ToolRegistry {
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
        // Scoped to the calling task and its owner: other tasks' results may
        // hold content this task's trust tier was never meant to see.
        const loaded = await deps.toolExecution.load(ctx.agentId, ctx.taskId, args.toolCallId);
        if (!loaded || loaded.toolCall.taskId !== ctx.taskId) {
          return { error: 'no such tool call in this task' };
        }
        return pageStoredToolResult({
          call: loaded.toolCall,
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
  return registry;
}
