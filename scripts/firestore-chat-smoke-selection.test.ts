import {
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
  type ExecutionEvidenceRecord,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { refreshConversationSearchEvidence } from '../packages/core/src/workflow/executor/conversation-search-refresh.js';
import {
  renderMemoryReadAnswer,
  selectMemoryReadAnswer,
} from '../packages/core/src/workflow/memory-read-answer.js';
import type { ActionEvidence } from '../packages/core/src/workflow/response-contract.js';
import { selectSmokeExtractQuotes } from './firestore-chat-smoke.js';

describe('Firestore chat smoke extract fixture', () => {
  it('returns only relevant exact owner quotes from the supplied source envelope', () => {
    const ownerQuote = 'The owner observed coastal rainbows by the sea.';
    const prompt = JSON.stringify({
      request: 'What did I tell you about a rainbow?',
      sources: [
        { key: 'message:rainbow', body: ownerQuote, speaker: 'Recorded owner message' },
        {
          key: 'message:unrelated',
          body: 'I prefer concise meeting summaries.',
          speaker: 'Recorded owner message',
        },
        {
          key: 'memory:commitment',
          body: 'The open commitment is to compare Rainbow observation notes.',
          speaker: 'Saved fact marked owner-confirmed',
        },
      ],
    });

    const result = selectSmokeExtractQuotes(prompt);
    expect(result).toEqual({
      selections: [{ sourceKey: 'message:rainbow', quote: ownerQuote }],
    });
    const suppliedSources = JSON.parse(prompt) as {
      sources: Array<{ key: string; body: string }>;
    };
    for (const selection of result?.selections ?? []) {
      const source = suppliedSources.sources.find(
        (candidate) => candidate.key === selection.sourceKey,
      );
      expect(source).toBeDefined();
      expect(source?.body).toContain(selection.quote);
    }
  });

  it('does not turn a related rainbow note into evidence about open commitments', () => {
    const prompt = JSON.stringify({
      request: 'What did I tell you about open commitments for rainbow observation notes?',
      sources: [
        {
          key: 'message:rainbow',
          body: 'The owner prepared rainbow notes by the sea.',
          speaker: 'Recorded owner message',
        },
      ],
    });

    expect(selectSmokeExtractQuotes(prompt)).toEqual({ selections: [] });
  });

  it('keeps both exact persisted search receipts through refresh and selects no unsupported commitment', async () => {
    const request = 'What did I tell you about open commitments for rainbow observation notes?';
    const text = 'The owner observed coastal rainbows by the sea.';
    const messageId = '1d871f62-d801-4c37-8a9c-144acfbf44ac';
    const conversationId = 'bd3cb1a7-ed01-42a5-93a7-252431cb4112';
    const createdAt = '2026-10-24T12:00:00.000Z';
    const match = {
      messageId,
      conversationId,
      text,
      role: 'user',
      origin: 'owner',
      sourceRevision: conversationMessageSourceRevision(messageId, text),
      speakerRevision: conversationMessageSpeakerRevision(messageId, text, 'user', 'owner'),
      createdAt,
      similarity: 0.85,
    };
    const queries = [
      'open commitments for rainbow observation notes',
      'Owner-authored statements and corrections about open commitments for rainbow observation notes',
    ];
    const evidence: ExecutionEvidenceRecord[] = queries.map((query, index) => ({
      id: `receipt-${index + 1}`,
      error: null,
      decision: { modelToolCallId: `model-call-${index + 1}` },
      step: index + 1,
      toolName: 'conversations.search',
      status: 'succeeded',
      args: { query, limit: 8 },
      result: { mode: 'semantic', matches: [match] },
    }));
    const refreshed = await refreshConversationSearchEvidence(evidence, {
      agentId: '5c69d0cf-e561-44ba-b0d6-d1454493054a',
      currentConversationId: '4df75f0d-45d4-4bd3-9faa-ae58429fc054',
      repository: {
        refreshForResume: async ({ sourceRefs }: { sourceRefs: Array<unknown> }) => ({
          mode: 'text' as const,
          matches: [],
          unchangedSourceRefs: sourceRefs.map(() => true),
          observationGeneration: null,
        }),
      } as never,
    });
    const refreshedEvidence: ActionEvidence[] = refreshed.rows.map((row) => ({
      ...row,
      fromCurrentTask: true,
    }));
    expect(refreshed.rows.map((row) => (row.result as { mode?: unknown }).mode)).toEqual([
      'semantic',
      'semantic',
    ]);
    const calls: Array<{ role: string; prompt: unknown }> = [];
    const router = {
      object: async (role: string, options: { prompt?: unknown }) => {
        calls.push({ role, prompt: options.prompt });
        return {
          ok: true,
          object: role === 'extract' ? selectSmokeExtractQuotes(options.prompt) : {},
          modelId: 'synthetic/model',
          degraded: false,
        };
      },
    };

    const selection = await selectMemoryReadAnswer({
      router: router as never,
      taskId: 'b03a3328-eafb-40cc-909a-d1874f0a395c',
      request,
      evidence: refreshedEvidence,
    });

    expect(calls.map((call) => call.role)).toEqual(['extract', 'extract']);
    expect(calls.map((call) => JSON.parse(String(call.prompt)).sources[0])).toEqual([
      expect.objectContaining({
        key: `message:${messageId}`,
        speaker: 'Recorded owner message',
        body: text,
      }),
      expect.objectContaining({
        key: `message:${messageId}`,
        speaker: 'Recorded owner message',
        body: text,
      }),
    ]);
    expect(selection).toMatchObject({
      version: 1,
      status: 'unavailable',
      selections: [],
      failureReason: 'incomplete_selection',
    });
    expect(renderMemoryReadAnswer(selection, refreshedEvidence, request)).toContain(
      'I found candidate owner-authored records, but could not reliably select a directly relevant passage.',
    );
  });

  it('fails closed when the selector prompt does not contain the expected envelope', () => {
    expect(selectSmokeExtractQuotes('{"request":"What did I tell you?"}')).toBeNull();
    expect(selectSmokeExtractQuotes('{')).toBeNull();
  });
});
