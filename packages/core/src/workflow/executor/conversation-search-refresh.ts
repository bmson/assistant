import { Buffer } from 'node:buffer';
import type {
  ConversationSearchRepository,
  ConversationSearchSourceRef,
  ExecutionEvidenceRecord,
} from '@assistant/persistence';
import { conversationMessageSourceRevision } from '@assistant/persistence';
import type { ModelMessage } from 'ai';

const MAX_SEARCH_CALLS = 3;
const MAX_SEARCH_CONTEXT_BYTES = 48_000;
const MAX_MATCHES = 20;
const MAX_SEARCH_TEXT_BYTES = 128_000;
const MAX_SEARCH_RESULT_JSON_BYTES = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;

type SearchCall = {
  message: ModelMessage;
  toolCallId: string;
  input: unknown;
};

type SearchResult = {
  message: ModelMessage | null;
  toolCallId: string;
  value: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageParts(message: ModelMessage): unknown[] | null {
  return Array.isArray(message.content) ? (message.content as unknown[]) : null;
}

function collectCalls(window: ModelMessage[]): SearchCall[] {
  const calls: SearchCall[] = [];
  for (const message of window) {
    if (message.role !== 'assistant') continue;
    for (const candidate of messageParts(message) ?? []) {
      const part = record(candidate);
      if (
        part?.type === 'tool-call' &&
        part.toolName === 'conversations.search' &&
        typeof part.toolCallId === 'string'
      )
        calls.push({ message, toolCallId: part.toolCallId, input: part.input });
    }
  }
  return calls;
}

function findResult(window: ModelMessage[], toolCallId: string): SearchResult {
  let found: SearchResult | null = null;
  for (const message of window) {
    if (message.role !== 'tool') continue;
    for (const candidate of messageParts(message) ?? []) {
      const part = record(candidate);
      if (
        part?.type !== 'tool-result' ||
        part.toolName !== 'conversations.search' ||
        part.toolCallId !== toolCallId
      )
        continue;
      const output = record(part.output);
      const value = output?.type === 'json' ? output.value : undefined;
      if (found) return { message: null, toolCallId, value: undefined };
      found = { message, toolCallId, value };
    }
  }
  return found ?? { message: null, toolCallId, value: undefined };
}

function orphanSearchResults(
  window: ModelMessage[],
  callIds: Set<string>,
): Array<{
  message: ModelMessage;
  index: number;
  part: Record<string, unknown>;
  value: unknown;
  toolCallId: string | null;
}> {
  const found: Array<{
    message: ModelMessage;
    index: number;
    part: Record<string, unknown>;
    value: unknown;
    toolCallId: string | null;
  }> = [];
  window.forEach((message, index) => {
    if (message.role !== 'tool') return;
    for (const candidate of messageParts(message) ?? []) {
      const part = record(candidate);
      if (part?.type !== 'tool-result' || part.toolName !== 'conversations.search') continue;
      const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : null;
      if (toolCallId !== null && callIds.has(toolCallId)) continue;
      const output = record(part.output);
      found.push({
        message,
        index,
        part,
        value: output?.type === 'json' ? output.value : undefined,
        toolCallId,
      });
    }
  });
  return found;
}

function relatedReadResultBytes(window: ModelMessage[]): number {
  let total = 0;
  for (const message of window) {
    const parts = messageParts(message);
    if (!parts) continue;
    for (const candidate of parts) {
      const part = record(candidate);
      if (part?.toolName === 'tools.read_result')
        total += Buffer.byteLength(JSON.stringify(candidate));
    }
  }
  return total;
}

function queryInput(input: unknown): { query: string; limit: number } | null {
  const value = record(input);
  if (
    !value ||
    typeof value.query !== 'string' ||
    value.query.length < 2 ||
    value.query.length > 500
  )
    return null;
  const limit = value.limit === undefined ? 5 : value.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_MATCHES)
    return null;
  return { query: value.query, limit: limit as number };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && allowed.every((key) => key in value);
}

function parseSourceRefs(value: unknown): { refs: ConversationSearchSourceRef[]; valid: boolean } {
  const result = record(value);
  const serialized = JSON.stringify(value);
  if (
    !result ||
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized) > MAX_SEARCH_RESULT_JSON_BYTES ||
    !exactKeys(result, ['mode', 'matches']) ||
    !['text', 'semantic'].includes(String(result.mode)) ||
    !Array.isArray(result.matches) ||
    result.matches.length > MAX_MATCHES
  )
    return { refs: [], valid: false };
  const refs: ConversationSearchSourceRef[] = [];
  const seen = new Set<string>();
  let totalTextBytes = 0;
  for (const candidate of result.matches) {
    const match = record(candidate);
    if (
      !match ||
      (!exactKeys(match, ['messageId', 'sourceRevision', 'conversationId', 'text', 'createdAt']) &&
        !exactKeys(match, [
          'messageId',
          'sourceRevision',
          'conversationId',
          'text',
          'createdAt',
          'similarity',
        ])) ||
      typeof match.messageId !== 'string' ||
      !UUID.test(match.messageId) ||
      typeof match.conversationId !== 'string' ||
      !UUID.test(match.conversationId) ||
      typeof match.sourceRevision !== 'string' ||
      !REVISION.test(match.sourceRevision) ||
      typeof match.text !== 'string' ||
      (typeof match.createdAt !== 'string' && !(match.createdAt instanceof Date)) ||
      (typeof match.createdAt === 'string' &&
        (!Number.isFinite(Date.parse(match.createdAt)) ||
          new Date(match.createdAt).toISOString() !== match.createdAt)) ||
      (match.createdAt instanceof Date && !Number.isFinite(match.createdAt.getTime())) ||
      ('similarity' in match &&
        (typeof match.similarity !== 'number' || !Number.isFinite(match.similarity))) ||
      seen.has(match.messageId)
    )
      return { refs: [], valid: false };
    totalTextBytes += Buffer.byteLength(match.text);
    if (totalTextBytes > MAX_SEARCH_TEXT_BYTES) return { refs: [], valid: false };
    if (conversationMessageSourceRevision(match.messageId, match.text) !== match.sourceRevision)
      return { refs: [], valid: false };
    seen.add(match.messageId);
    refs.push({
      messageId: match.messageId,
      conversationId: match.conversationId,
      sourceRevision: match.sourceRevision,
    });
  }
  return { refs, valid: true };
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null)) as unknown;
}

function durableCallIdFromTruncation(value: unknown): string | null {
  const result = record(value);
  if (result?.truncated !== true || typeof result.note !== 'string') return null;
  const match = result.note.match(/tools\.read_result\(\{ toolCallId: "([A-Za-z0-9_-]{1,200})"/u);
  return match?.[1] ?? null;
}

function scrubReadResultParts(
  window: ModelMessage[],
  earliestInvalidatedResult: number,
  invalidatedDurableCallIds: Set<string>,
  parentIdentityUnknown: boolean,
): void {
  if (earliestInvalidatedResult === Number.POSITIVE_INFINITY) return;
  const staleReadCallIds = new Set<string>();
  for (let index = 0; index < window.length; index += 1) {
    const message = window[index];
    if (message?.role !== 'assistant') continue;
    for (const candidate of messageParts(message) ?? []) {
      const part = record(candidate);
      const args = record(part?.input);
      if (
        part?.type === 'tool-call' &&
        part.toolName === 'tools.read_result' &&
        typeof part.toolCallId === 'string' &&
        typeof args?.toolCallId === 'string' &&
        (parentIdentityUnknown || invalidatedDurableCallIds.has(args.toolCallId))
      )
        staleReadCallIds.add(part.toolCallId);
    }
  }
  for (let index = earliestInvalidatedResult; index < window.length; index += 1) {
    const message = window[index];
    if (message?.role !== 'tool') continue;
    const parts = messageParts(message);
    if (!parts) continue;
    const next = parts.map((candidate) => {
      const part = record(candidate);
      if (
        part?.type === 'tool-result' &&
        part.toolName === 'tools.read_result' &&
        typeof part.toolCallId === 'string' &&
        staleReadCallIds.has(part.toolCallId)
      )
        return {
          ...part,
          output: {
            type: 'json',
            value: {
              mode: 'unavailable',
              note: 'The source result is no longer available in this resumed context.',
            },
          },
        };
      return candidate;
    });
    message.content = next as never;
  }
}

function replaceSearchResult(window: ModelMessage[], call: SearchCall, result: unknown): number {
  let retained = false;
  let firstResultIndex = -1;
  for (let messageIndex = 0; messageIndex < window.length; messageIndex += 1) {
    const message = window[messageIndex];
    if (message?.role !== 'tool') continue;
    const content = messageParts(message);
    if (!content) continue;
    const next = content.flatMap((candidate) => {
      const part = record(candidate);
      if (
        part?.type === 'tool-result' &&
        part.toolName === 'conversations.search' &&
        part.toolCallId === call.toolCallId
      ) {
        if (retained) return [];
        retained = true;
        firstResultIndex = messageIndex;
        return [{ ...part, output: { type: 'json', value: jsonValue(result) } }];
      }
      return [candidate];
    });
    if (next.length === 0) {
      window.splice(messageIndex, 1);
      messageIndex -= 1;
    } else if (next.length !== content.length) {
      message.content = next as never;
    } else if (next !== content) {
      // The replacement map creates a fresh array even when only output changed.
      message.content = next as never;
    }
  }
  if (retained) return firstResultIndex;
  const callIndex = window.indexOf(call.message);
  window.splice(callIndex + 1, 0, {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: 'conversations.search',
        output: { type: 'json', value: jsonValue(result) },
      },
    ],
  } as ModelMessage);
  return callIndex + 1;
}

function scrubAssistantTextAfter(window: ModelMessage[], index: number): void {
  for (let i = window.length - 1; i > index; i -= 1) {
    const message = window[i];
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string') {
      window.splice(i, 1);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const retained = (message.content as unknown[]).filter((candidate) => {
      const part = record(candidate);
      return part?.type !== 'text';
    });
    if (retained.length === 0) window.splice(i, 1);
    else message.content = retained as never;
  }
}

/**
 * Refresh persisted search evidence before a resumed model use. This never
 * replays the dispatcher, embedding model, or any external side effect.
 */
export async function refreshResumedConversationSearch(
  window: ModelMessage[],
  input: {
    agentId: string;
    currentConversationId?: string;
    repository?: ConversationSearchRepository;
  },
): Promise<{
  changed: boolean;
  observationGeneration: string | null;
  invalidatedToolCallIds: string[];
}> {
  const calls = collectCalls(window);
  const callIds = new Set(calls.map((call) => call.toolCallId));
  const orphans = orphanSearchResults(window, callIds);
  if (calls.length === 0 && orphans.length === 0)
    return { changed: false, observationGeneration: null, invalidatedToolCallIds: [] };

  const contextBytes = calls.reduce(
    (total, call) => {
      const result = findResult(window, call.toolCallId);
      return (
        total +
        Buffer.byteLength(JSON.stringify(call.input ?? null)) +
        Buffer.byteLength(JSON.stringify(result.value ?? null))
      );
    },
    relatedReadResultBytes(window) +
      orphans.reduce((total, orphan) => total + Buffer.byteLength(JSON.stringify(orphan.part)), 0),
  );
  const overBound = calls.length > MAX_SEARCH_CALLS || contextBytes > MAX_SEARCH_CONTEXT_BYTES;
  const results: Array<{ call: SearchCall; value: unknown; invalidated: boolean }> = [];
  let observationGeneration: string | null = null;
  let observationGenerationSeen = false;
  let generationMismatch = false;

  for (const call of calls.slice(0, MAX_SEARCH_CALLS)) {
    const stored = findResult(window, call.toolCallId);
    const args = queryInput(call.input);
    const parsed = parseSourceRefs(stored.value);
    const invalidated = overBound || !stored.message || !args || !parsed.valid;
    if (!args || !input.repository || overBound) {
      results.push({
        call,
        value: {
          mode: 'unavailable',
          matches: [],
          note: 'Conversation history could not be refreshed.',
        },
        invalidated: true,
      });
      continue;
    }
    try {
      const refreshed = await input.repository.refreshForResume({
        agentId: input.agentId,
        ...(input.currentConversationId
          ? { currentConversationId: input.currentConversationId }
          : {}),
        query: args.query,
        limit: args.limit,
        sourceRefs: parsed.valid ? parsed.refs : [],
      });
      if (
        refreshed.mode !== 'text' ||
        !Array.isArray(refreshed.matches) ||
        !Array.isArray(refreshed.unchangedSourceRefs) ||
        refreshed.matches.length > args.limit ||
        refreshed.unchangedSourceRefs.length !== (parsed.valid ? parsed.refs.length : 0) ||
        refreshed.unchangedSourceRefs.some((unchanged) => typeof unchanged !== 'boolean') ||
        (refreshed.observationGeneration !== null &&
          typeof refreshed.observationGeneration !== 'string') ||
        refreshed.matches.some(
          (match) =>
            !exactKeys(match as unknown as Record<string, unknown>, [
              'messageId',
              'sourceRevision',
              'conversationId',
              'text',
              'createdAt',
            ]) ||
            !UUID.test(match.messageId) ||
            !UUID.test(match.conversationId) ||
            !REVISION.test(match.sourceRevision) ||
            typeof match.text !== 'string' ||
            !(match.createdAt instanceof Date) ||
            !Number.isFinite(match.createdAt.getTime()) ||
            conversationMessageSourceRevision(match.messageId, match.text) !== match.sourceRevision,
        )
      )
        throw new Error('Conversation search refresh returned malformed evidence');
      const freshTextBytes = refreshed.matches.reduce(
        (total, match) => total + Buffer.byteLength(match.text),
        0,
      );
      const freshJsonBytes = Buffer.byteLength(JSON.stringify(refreshed.matches));
      if (freshTextBytes > MAX_SEARCH_TEXT_BYTES || freshJsonBytes > MAX_SEARCH_RESULT_JSON_BYTES)
        throw new Error('Conversation search refresh exceeded its data bound');
      const refsUnchanged = parsed.valid && refreshed.unchangedSourceRefs.every(Boolean);
      if (observationGenerationSeen && observationGeneration !== refreshed.observationGeneration) {
        generationMismatch = true;
        results.push({
          call,
          value: {
            mode: 'unavailable',
            matches: [],
            note: 'Conversation history could not be refreshed.',
          },
          invalidated: true,
        });
        continue;
      }
      if (!observationGenerationSeen) {
        observationGeneration = refreshed.observationGeneration;
        observationGenerationSeen = true;
      }
      results.push({
        call,
        value: {
          mode: 'text',
          matches: refreshed.matches.map((match) => ({
            messageId: match.messageId,
            sourceRevision: match.sourceRevision,
            conversationId: match.conversationId,
            text: match.text,
            createdAt: match.createdAt.toISOString(),
          })),
        },
        invalidated: invalidated || !refsUnchanged,
      });
    } catch {
      results.push({
        call,
        value: {
          mode: 'unavailable',
          matches: [],
          note: 'Conversation history could not be refreshed.',
        },
        invalidated: true,
      });
    }
  }

  if (calls.length > MAX_SEARCH_CALLS) {
    for (const call of calls.slice(MAX_SEARCH_CALLS))
      results.push({
        call,
        value: {
          mode: 'unavailable',
          matches: [],
          note: 'Conversation history could not be refreshed.',
        },
        invalidated: true,
      });
  }

  if (generationMismatch) {
    observationGeneration = null;
    for (const item of results) {
      item.value = {
        mode: 'unavailable',
        matches: [],
        note: 'Conversation history could not be refreshed.',
      };
      item.invalidated = true;
    }
  }

  let earliestInvalidatedResult = Number.POSITIVE_INFINITY;
  const invalidatedDurableCallIds = new Set<string>();
  const invalidatedToolCallIds = new Set<string>();
  let parentIdentityUnknown = false;
  for (const item of results) {
    if (!item.invalidated) continue;
    invalidatedToolCallIds.add(item.call.toolCallId);
    const result = findResult(window, item.call.toolCallId);
    const durableCallId = durableCallIdFromTruncation(result.value);
    if (durableCallId) invalidatedDurableCallIds.add(durableCallId);
    else parentIdentityUnknown = true;
    const index = result.message
      ? window.indexOf(result.message)
      : window.indexOf(item.call.message);
    earliestInvalidatedResult = Math.min(earliestInvalidatedResult, index);
  }
  if (Number.isFinite(earliestInvalidatedResult)) {
    scrubReadResultParts(
      window,
      earliestInvalidatedResult,
      invalidatedDurableCallIds,
      parentIdentityUnknown,
    );
    scrubAssistantTextAfter(window, earliestInvalidatedResult);
  }

  for (const item of results) replaceSearchResult(window, item.call, item.value);

  for (const orphan of orphans) {
    if (orphan.toolCallId !== null) invalidatedToolCallIds.add(orphan.toolCallId);
    const durableCallId = durableCallIdFromTruncation(orphan.value);
    if (durableCallId) invalidatedDurableCallIds.add(durableCallId);
    else parentIdentityUnknown = true;
    earliestInvalidatedResult = Math.min(earliestInvalidatedResult, orphan.index);
    orphan.part.output = {
      type: 'json',
      value: {
        mode: 'unavailable',
        matches: [],
        note: 'Conversation history could not be refreshed.',
      },
    };
  }
  if (orphans.length > 0) {
    scrubReadResultParts(
      window,
      earliestInvalidatedResult,
      invalidatedDurableCallIds,
      parentIdentityUnknown,
    );
    scrubAssistantTextAfter(window, earliestInvalidatedResult);
  }
  return {
    changed: true,
    observationGeneration,
    invalidatedToolCallIds: [...invalidatedToolCallIds],
  };
}

/** Refresh durable evidence for final verification without modifying the tool ledger. */
export async function refreshConversationSearchEvidence(
  rows: readonly ExecutionEvidenceRecord[],
  input: {
    agentId: string;
    currentConversationId?: string;
    repository?: ConversationSearchRepository;
  },
): Promise<{ rows: ExecutionEvidenceRecord[]; invalidatedSearchCallIds: Set<string> }> {
  const next = rows.map((row) => ({ ...row }));
  const searchRows = next.filter((row) => row.toolName === 'conversations.search');
  if (searchRows.length === 0) return { rows: next, invalidatedSearchCallIds: new Set() };
  const idBySyntheticCall = new Map<string, string>();
  const callParts = searchRows.map((row) => {
    const syntheticId = `evidence-${row.id}`;
    idBySyntheticCall.set(syntheticId, row.id);
    return { type: 'tool-call', toolCallId: syntheticId, toolName: row.toolName, input: row.args };
  });
  const resultParts = searchRows.map((row) => ({
    type: 'tool-result',
    toolCallId: `evidence-${row.id}`,
    toolName: row.toolName,
    output: { type: 'json', value: row.result },
  }));
  const window: ModelMessage[] = [
    { role: 'assistant', content: callParts } as ModelMessage,
    { role: 'tool', content: resultParts } as ModelMessage,
  ];
  const refreshed = await refreshResumedConversationSearch(window, {
    agentId: input.agentId,
    ...(input.currentConversationId ? { currentConversationId: input.currentConversationId } : {}),
    repository: input.repository,
  });
  const refreshedResults = new Map<string, unknown>();
  for (const message of window) {
    if (message.role !== 'tool') continue;
    for (const candidate of messageParts(message) ?? []) {
      const part = record(candidate);
      if (part?.type !== 'tool-result' || typeof part.toolCallId !== 'string') continue;
      const output = record(part.output);
      if (idBySyntheticCall.has(part.toolCallId))
        refreshedResults.set(part.toolCallId, output?.type === 'json' ? output.value : null);
    }
  }
  for (const row of searchRows) {
    const syntheticId = `evidence-${row.id}`;
    row.result = refreshedResults.get(syntheticId) ?? {
      mode: 'unavailable',
      matches: [],
      note: 'Conversation history could not be refreshed.',
    };
  }
  const invalidated = new Set(
    refreshed.invalidatedToolCallIds
      .map((callId) => idBySyntheticCall.get(callId))
      .filter((id): id is string => id !== undefined),
  );
  if (invalidated.size > 0) {
    for (const row of next) {
      if (row.toolName !== 'tools.read_result') continue;
      const args = record(row.args);
      const parentId = args?.toolCallId;
      if (typeof parentId !== 'string' || invalidated.has(parentId))
        row.result = {
          mode: 'unavailable',
          note: 'The source result is no longer available in this resumed context.',
        };
    }
  }
  return { rows: next, invalidatedSearchCallIds: invalidated };
}
