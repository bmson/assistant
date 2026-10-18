import {
  type ConversationSearchRepository,
  type ConversationSearchSourceRef,
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
  type Records,
  type ToolExecutionRepository,
  validatedConversationSourceUrl,
  validConversationSpeaker,
} from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

// `tools.read_result` tool results are clipped at 32k before the model sees
// them. The smaller page leaves room for JSON escaping of the chunk itself,
// so a page does not require an endless read_result-of-read_result chain.
const PAGE_CHARS = 14_000;
const SEARCH_LIMIT = 20;
// Search results are paged later, so bound the full untrusted payload before
// hashing source text or serializing it. 128 KiB of message text leaves ample
// room for JSON escaping and the bounded match metadata under this ceiling.
const MAX_SEARCH_TEXT_BYTES = 128 * 1024;
const MAX_SEARCH_RESULT_BYTES = 1024 * 1024;
const MAX_CONTEXT_TEXT_BYTES = 32_000;
const MAX_CONTEXT_RESULT_BYTES = 48_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;
const SEARCH_ARGS = z
  .object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(SEARCH_LIMIT).default(5),
    mode: z.enum(['semantic', 'text']).optional(),
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

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && hasOnlyKeys(value, allowed);
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
    (args.data.mode === 'text' && result.mode !== 'text') ||
    !Array.isArray(result.matches) ||
    result.matches.length > args.data.limit
  )
    return null;

  const matches: Array<{
    messageId: string;
    conversationId: string;
    sourceRevision: string;
    text: string;
    speakerRevision?: string;
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
      !validConversationSpeaker(match) ||
      !hasOnlyKeys(match, [
        ...allowedMatchKeys,
        'role',
        'origin',
        'speakerRevision',
        'sourceUrl',
      ]) ||
      (match.sourceUrl !== undefined && !validatedConversationSourceUrl(match)) ||
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
      ...(typeof match.speakerRevision === 'string'
        ? { speakerRevision: match.speakerRevision }
        : {}),
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
      ...(typeof match.speakerRevision === 'string'
        ? { speakerRevision: match.speakerRevision }
        : {}),
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
            'role',
            'origin',
            'speakerRevision',
          ]) ||
          !validConversationSpeaker(match) ||
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

function contextSourceRefs(
  call: StoredToolCall,
): { refs: ConversationSearchSourceRef[]; generation: string | null } | null {
  if (call.status !== 'succeeded') return null;
  const serializedResult = JSON.stringify(call.result ?? null);
  if (Buffer.byteLength(serializedResult, 'utf8') > MAX_CONTEXT_RESULT_BYTES) return null;
  const args = record(call.args);
  const inputAnchors = args?.anchors;
  const result = record(call.result);
  if (
    !args ||
    !hasExactKeys(args, ['anchors']) ||
    !Array.isArray(inputAnchors) ||
    inputAnchors.length < 1 ||
    inputAnchors.length > 2 ||
    !result ||
    !hasExactKeys(result, ['mode', 'matches', 'anchors', 'window', 'observationGeneration']) ||
    result.mode !== 'context' ||
    !Array.isArray(result.matches) ||
    result.matches.length < inputAnchors.length ||
    result.matches.length > 10 ||
    !Array.isArray(result.anchors) ||
    (result.observationGeneration !== null &&
      (typeof result.observationGeneration !== 'string' ||
        result.observationGeneration.length > 200))
  )
    return null;
  const window = record(result.window);
  if (
    !window ||
    !hasExactKeys(window, ['before', 'after']) ||
    window.before !== 3 ||
    window.after !== 1
  )
    return null;

  const refsFrom = (values: unknown[]): ConversationSearchSourceRef[] | null => {
    const refs: ConversationSearchSourceRef[] = [];
    const seen = new Set<string>();
    for (const candidate of values) {
      const ref = record(candidate);
      if (
        !ref ||
        !hasExactKeys(ref, ['messageId', 'conversationId', 'sourceRevision', 'speakerRevision']) ||
        typeof ref.messageId !== 'string' ||
        !UUID.test(ref.messageId) ||
        typeof ref.conversationId !== 'string' ||
        !UUID.test(ref.conversationId) ||
        typeof ref.sourceRevision !== 'string' ||
        !REVISION.test(ref.sourceRevision) ||
        typeof ref.speakerRevision !== 'string' ||
        !REVISION.test(ref.speakerRevision) ||
        seen.has(ref.messageId)
      )
        return null;
      seen.add(ref.messageId);
      refs.push({
        messageId: ref.messageId,
        conversationId: ref.conversationId,
        sourceRevision: ref.sourceRevision,
        speakerRevision: ref.speakerRevision,
      });
    }
    return refs;
  };
  const anchors = refsFrom(inputAnchors);
  const resultAnchors = refsFrom(result.anchors);
  if (
    !anchors ||
    !resultAnchors ||
    anchors.length !== resultAnchors.length ||
    anchors.some((anchor, index) => {
      const returned = resultAnchors[index];
      return (
        !returned ||
        anchor.messageId !== returned.messageId ||
        anchor.conversationId !== returned.conversationId ||
        anchor.sourceRevision !== returned.sourceRevision ||
        anchor.speakerRevision !== returned.speakerRevision
      );
    })
  )
    return null;

  const refs: ConversationSearchSourceRef[] = [];
  const seen = new Set<string>();
  const anchorConversationIds = new Set(anchors.map((anchor) => anchor.conversationId));
  let totalTextBytes = 0;
  for (const candidate of result.matches) {
    const match = record(candidate);
    if (
      !match ||
      !hasExactKeys(match, [
        'messageId',
        'conversationId',
        'sourceRevision',
        'speakerRevision',
        'role',
        'origin',
        'text',
        'createdAt',
        ...(match.sourceUrl !== undefined ? ['sourceUrl'] : []),
      ]) ||
      (match.sourceUrl !== undefined && !validatedConversationSourceUrl(match)) ||
      !validConversationSpeaker(match) ||
      typeof match.messageId !== 'string' ||
      !UUID.test(match.messageId) ||
      typeof match.conversationId !== 'string' ||
      !UUID.test(match.conversationId) ||
      !anchorConversationIds.has(match.conversationId) ||
      typeof match.sourceRevision !== 'string' ||
      !REVISION.test(match.sourceRevision) ||
      typeof match.speakerRevision !== 'string' ||
      !REVISION.test(match.speakerRevision) ||
      typeof match.messageId !== 'string' ||
      typeof match.text !== 'string' ||
      typeof match.role !== 'string' ||
      typeof match.origin !== 'string' ||
      conversationMessageSpeakerRevision(match.messageId, match.text, match.role, match.origin) !==
        match.speakerRevision ||
      !boundedString(match.text, MAX_CONTEXT_TEXT_BYTES)
    )
      return null;
    totalTextBytes += Buffer.byteLength(match.text, 'utf8');
    const validDate =
      match.createdAt instanceof Date
        ? Number.isFinite(match.createdAt.getTime())
        : canonicalISODate(match.createdAt);
    if (
      totalTextBytes > MAX_CONTEXT_TEXT_BYTES ||
      !validDate ||
      conversationMessageSourceRevision(match.messageId, match.text) !== match.sourceRevision ||
      seen.has(match.messageId)
    )
      return null;
    seen.add(match.messageId);
    refs.push({
      messageId: match.messageId,
      conversationId: match.conversationId,
      sourceRevision: match.sourceRevision,
      speakerRevision: match.speakerRevision,
    });
  }
  if (
    anchors.some((anchor) => {
      const match = refs.find((ref) => ref.messageId === anchor.messageId);
      return (
        !match ||
        match.conversationId !== anchor.conversationId ||
        match.sourceRevision !== anchor.sourceRevision ||
        match.speakerRevision !== anchor.speakerRevision
      );
    })
  )
    return null;
  return { refs, generation: result.observationGeneration as string | null };
}

/**
 * Page a stored result only after revalidating the typed source references of
 * conversation-search and bounded conversation-context results. A changed,
 * hidden, erased, malformed, or unbound historical read is unavailable as a
 * whole; callers can run a new search and context read. Other effect receipts
 * retain their existing read-only paging path.
 */
export async function pageStoredToolResult(input: {
  call: StoredToolCall;
  toolCallId: string;
  offset: number;
  agentId: string;
  currentConversationId?: string;
  conversations?: Pick<ConversationSearchRepository, 'refreshForResume' | 'validateSources'>;
}): Promise<Record<string, unknown>> {
  if (input.call.toolName === 'conversations.context') {
    const parsed = contextSourceRefs(input.call);
    if (!parsed || !input.conversations?.validateSources) {
      return {
        error:
          'This stored conversation context is unavailable. Run a fresh conversations.search and conversations.context before using it.',
      };
    }
    try {
      const validated = await input.conversations.validateSources({
        agentId: input.agentId,
        ...(input.currentConversationId
          ? { currentConversationId: input.currentConversationId }
          : {}),
        sourceRefs: parsed.refs,
      });
      if (
        !validated ||
        !Array.isArray(validated.unchangedSourceRefs) ||
        validated.unchangedSourceRefs.length !== parsed.refs.length ||
        validated.unchangedSourceRefs.some((unchanged) => unchanged !== true) ||
        validated.observationGeneration !== parsed.generation
      )
        return {
          error:
            'This stored conversation context changed. Run a fresh conversations.search and conversations.context before using it.',
        };
    } catch {
      return {
        error:
          'This stored conversation context is unavailable. Run a fresh conversations.search and conversations.context before using it.',
      };
    }
  }
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
    (input.call.toolName === 'conversations.search' ||
      input.call.toolName === 'conversations.context') &&
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
    conversations?: Pick<ConversationSearchRepository, 'refreshForResume' | 'validateSources'>;
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
