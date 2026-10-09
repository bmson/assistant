import { createHash } from 'node:crypto';
import {
  type EmailExtractionRepository,
  type EmailExtractionRow,
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { runEmailIngestExtraction } from './email-extraction.js';

describe('prepared email extraction retries', () => {
  it('reuses same-space prepared output and refuses cached vectors after a space change', async () => {
    const row: EmailExtractionRow = {
      id: 'ingest-1',
      agentId: 'agent-1',
      channelMessageId: 'gmail:message-1',
      fromEmail: 'travel@example.test',
      subject: 'Trip details',
      category: 'travel',
      importance: 4,
      preparedExtraction: null,
    };
    const body = 'The owner has a confirmed departure date and a flight time on the itinerary.';
    const first = 'The owner departs for Oslo at 08:30 on the confirmed flight.';
    const second = 'The owner returns from Oslo at 19:20 on the confirmed flight.';
    const hashes = new Set<string>();
    const hashSpaces = new Map<string, string>();
    const refreshed: Array<{ hash: string; spaceKey: string }> = [];
    const savedSpaceKeys: string[] = [];
    let failuresRemaining = 2;
    let stamped = false;
    let modelCalls = 0;
    let embeddingCalls = 0;
    const spaceA: EmbeddingSpace = {
      provider: 'fixture',
      model: 'prepared-email-a',
      dimensions: 1536,
      revision: '1',
    };
    const spaceB: EmbeddingSpace = {
      provider: 'fixture',
      model: 'prepared-email-b',
      dimensions: 1536,
      revision: '1',
    };
    let embeddingSpace = spaceA;

    const store: EmailExtractionRepository = {
      kind: 'email-extraction-repository',
      async pending() {
        return stamped ? [] : [{ ...row }];
      },
      async messageText() {
        return body;
      },
      async savePrepared(_id, _agentId, prepared) {
        row.preparedExtraction = structuredClone(prepared);
      },
      async screenFactHashes(_agentId, contentHashes) {
        return Object.fromEntries(
          contentHashes.map((hash) => [
            hash,
            hashes.has(hash)
              ? { state: 'duplicate' as const, embeddingSpaceKey: hashSpaces.get(hash) ?? null }
              : { state: 'new' as const },
          ]),
        );
      },
      async refreshFactEmbedding(_agentId, hash, _embedding, spaceKey) {
        refreshed.push({ hash, spaceKey });
        hashSpaces.set(hash, spaceKey);
        return true;
      },
      async stamp() {
        stamped = true;
        row.preparedExtraction = null;
      },
      async saveFact({ fact, embeddingSpaceKey }) {
        savedSpaceKeys.push(embeddingSpaceKey);
        if (fact.content === second && failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('simulated memory write failure');
        }
        if (hashes.has(fact.contentHash)) return 'duplicate';
        hashes.add(fact.contentHash);
        hashSpaces.set(fact.contentHash, embeddingSpaceKey);
        return 'saved';
      },
      async saveOccasion() {
        return false;
      },
      async pendingCount() {
        return stamped ? 0 : 1;
      },
    };
    const router = {
      async embeddingSpace() {
        return embeddingSpace;
      },
      async object() {
        modelCalls += 1;
        return {
          ok: true,
          modelId: 'fixture',
          degraded: false,
          object: {
            facts: [first, second].map((content) => ({
              content,
              kind: 'fact' as const,
              category: 'knowledge' as const,
              subject: 'owner',
              relationship: '',
              domain: 'other' as const,
              importance: 4,
              confidence: 0.9,
              validFrom: '',
            })),
            occasions: [],
          },
        };
      },
      async embed(contents: string[]) {
        embeddingCalls += 1;
        return contents.map(() => Array.from({ length: 1536 }, () => embeddingCalls * 0.01));
      },
    } as unknown as ModelRouter;
    const deps = { db: {} as never, router, store };

    await expect(runEmailIngestExtraction(deps)).rejects.toThrow('simulated memory write failure');
    expect(modelCalls).toBe(1);
    expect(embeddingCalls).toBe(1);
    expect(hashes.size).toBe(1);

    await expect(runEmailIngestExtraction(deps)).rejects.toThrow('simulated memory write failure');
    expect(modelCalls).toBe(1);
    expect(embeddingCalls).toBe(1);

    const preparedInSpaceA = structuredClone(row.preparedExtraction);
    const savesBeforeSpaceChange = savedSpaceKeys.length;
    embeddingSpace = spaceB;
    await expect(runEmailIngestExtraction(deps)).rejects.toThrow(
      'Prepared email embeddings belong to a different space; review before retry',
    );
    expect(modelCalls).toBe(1);
    expect(embeddingCalls).toBe(1);
    expect(savedSpaceKeys).toHaveLength(savesBeforeSpaceChange);
    expect(refreshed).toHaveLength(0);
    expect(row.preparedExtraction).toEqual(preparedInSpaceA);
    expect(stamped).toBe(false);

    // Returning to the exact captured space lets the same prepared vectors
    // resume without a second extraction or embedding call.
    embeddingSpace = spaceA;
    const result = await runEmailIngestExtraction(deps);
    expect(result.saved).toBe(1);
    expect(modelCalls).toBe(1);
    expect(embeddingCalls).toBe(1);
    expect(refreshed).toHaveLength(0);
    expect(savedSpaceKeys.every((key) => key === embeddingSpaceIdentityKey(spaceA))).toBe(true);
    expect(stamped).toBe(true);
    expect(row.preparedExtraction).toBeNull();
  });

  it('rejects cached vectors with unknown identity without paid re-embedding or relabeling', async () => {
    const content = 'The owner has a confirmed departure date and a flight time.';
    const body = 'The owner has a confirmed departure date and a flight time on the itinerary.';
    const agentId = 'agent-unknown-cache';
    const channelMessageId = 'gmail:unknown-space-cache';
    const fromEmail = 'travel@example.test';
    const subject = 'Trip details';
    const category = 'travel';
    const contentHash = createHash('sha256').update(content).digest('hex');
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify([
          'email-extraction-v2',
          agentId,
          channelMessageId,
          fromEmail,
          subject,
          category,
          body,
        ]),
      )
      .digest('hex');
    const cached = Array.from({ length: 1536 }, () => 0.1);
    const prepared = {
      sourceHash,
      extractionVersion: 'email-extraction-v2',
      embeddingSpaceKey: null,
      facts: [
        {
          content,
          kind: 'fact',
          category: 'knowledge',
          subject: 'owner',
          relationship: '',
          domain: 'other',
          importance: 4,
          confidence: 0.9,
          validFrom: '',
        },
      ],
      occasions: [],
      embeddingsByHash: { [contentHash]: cached },
    };
    const originalPrepared = structuredClone(prepared);
    let saved = false;
    let preparedSaveCalls = 0;
    let preparedKey: string | null | undefined;
    let saveCalls = 0;
    let saveKey: string | null = null;
    let refreshCalls = 0;
    let embeddingCalls = 0;
    let modelCalls = 0;
    const store: EmailExtractionRepository = {
      kind: 'email-extraction-repository',
      async pending() {
        return [
          {
            id: 'unknown-cache-row',
            agentId,
            channelMessageId,
            fromEmail,
            subject,
            category,
            importance: 4,
            preparedExtraction: prepared,
          },
        ];
      },
      async messageText() {
        return body;
      },
      async savePrepared(_id, _agentId, payload) {
        preparedSaveCalls += 1;
        preparedKey = payload.embeddingSpaceKey;
      },
      async screenFactHashes() {
        return { [contentHash]: { state: 'new' } };
      },
      async refreshFactEmbedding() {
        refreshCalls += 1;
        return true;
      },
      async stamp() {
        saved = true;
      },
      async saveFact(input) {
        saveCalls += 1;
        saveKey = input.embeddingSpaceKey;
        return 'saved';
      },
      async saveOccasion() {
        return false;
      },
      async pendingCount() {
        return saved ? 0 : 1;
      },
    };
    const targetSpace: EmbeddingSpace = {
      provider: 'fixture',
      model: 'unknown-cache-target',
      dimensions: 1536,
      revision: '1',
    };
    const router = {
      async embeddingSpace() {
        return targetSpace;
      },
      async object() {
        modelCalls += 1;
        throw new Error('prepared extraction should be reused');
      },
      async embed(texts: string[]) {
        embeddingCalls += 1;
        return texts.map(() => Array.from({ length: 1536 }, () => 0.25));
      },
    } as unknown as ModelRouter;

    await expect(runEmailIngestExtraction({ db: {} as never, router, store })).rejects.toThrow(
      'Prepared email embeddings belong to a different space; review before retry',
    );
    expect(modelCalls).toBe(0);
    expect(embeddingCalls).toBe(0);
    expect(preparedSaveCalls).toBe(0);
    expect(preparedKey).toBeUndefined();
    expect(refreshCalls).toBe(0);
    expect(saveCalls).toBe(0);
    expect(saveKey).toBeNull();
    expect(saved).toBe(false);
    expect(await store.pendingCount()).toBe(1);
    expect(prepared).toEqual(originalPrepared);
    expect(prepared.embeddingSpaceKey).toBeNull();
    expect(prepared.embeddingsByHash[contentHash]).toEqual(cached);
  });
});
