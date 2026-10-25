import { resetConfigForTest } from '@assistant/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { firestoreChatSmoke } from '../../../scripts/firestore-chat-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore ordinary chat composition', () => {
  beforeEach(() => resetConfigForTest());
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('runs planning, owner context, learned skills and final delivery without SQL', async () => {
    // Optional historical/graph recall has its own migration gate. This scenario
    // uses the default configuration, with normal owner context and skills active.
    vi.stubEnv('CHAT_RECALL_ENABLED', 'false');
    const store = emulatorStore();
    try {
      expect(await firestoreChatSmoke(store)).toEqual({
        planned: true,
        ownerContext: true,
        skills: true,
        finalized: true,
        sqlAccesses: 0,
      });
    } finally {
      await disposeStore(store);
    }
  });
  it('runs automatic recall but excludes irrelevant context for a generic world question', async () => {
    vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
    vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
    const store = emulatorStore();
    try {
      expect(
        await firestoreChatSmoke(store, {
          recall: true,
          request: 'Explain how a rainbow forms.',
          expectRecall: false,
        }),
      ).toMatchObject({
        historySurfaced: false,
        graphSurfaced: false,
        preflightRecallMode: 'automatic',
        preflightSourceKeys: [],
        runtimeSourceKeys: [],
        planningRecallStatus: 'complete',
        planningRecallSourceCount: 0,
        sqlAccesses: 0,
        finalized: true,
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('automatically recalls relevant owner history and graph context without commitments or SQL', async () => {
    vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
    vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
    const store = emulatorStore();
    try {
      const result = await firestoreChatSmoke(store, {
        recall: true,
        request: 'Please help me prepare my observation notes about coastal rainbows by the sea.',
        expectRecall: true,
      });
      expect(result).toMatchObject({
        historySurfaced: true,
        graphSurfaced: true,
        preflightRecallMode: 'automatic',
        planningRecallStatus: 'complete',
        sqlAccesses: 0,
        finalized: true,
      });
      expect(result.preflightSourceKeys).toEqual(result.expectedPreflightSourceKeys);
      expect(result.preflightSourceKeys).toHaveLength(2);
      expect(result.runtimeSourceKeys).toHaveLength(2);
    } finally {
      await disposeStore(store);
    }
  });

  it.each([
    { request: 'What does open commitments mean?', mode: 'automatic' as const },
    {
      request: 'What does open commitments mean for rainbow observation notes?',
      mode: 'automatic' as const,
    },
    {
      request: 'Find an article about open commitments for rainbow observation notes.',
      mode: 'automatic' as const,
    },
    {
      request:
        'Find an article explaining how authors write rainbow observation notes for my class.',
      mode: 'automatic' as const,
    },
    {
      request:
        'Can you help me understand what open commitments mean for rainbow observation notes?',
      mode: 'automatic' as const,
    },
    {
      request: 'Prepare a list of articles about open commitments for rainbow notes for my class.',
      mode: 'disabled' as const,
    },
    {
      request: 'Can you help me prepare my list of articles about rainbow observation notes?',
      mode: 'automatic' as const,
    },
    {
      request:
        'Please help me prepare my observation notes and research articles about coastal rainbows.',
      mode: 'automatic' as const,
      expectRecall: true,
    },
    // These synthetic subject matches verify admission and commitment isolation;
    // they do not establish a general fictional-content exclusion policy.
    {
      request: 'Please help me prepare my fictional observation notes about coastal rainbows.',
      mode: 'automatic' as const,
      expectRecall: true,
    },
    {
      request: 'Search my inbox for an email about open commitments for rainbow observation notes.',
      mode: 'explicit' as const,
    },
    {
      request: 'What did I tell you about open commitments for rainbow observation notes?',
      mode: 'explicit' as const,
    },
  ])(
    'keeps the commitment canary out of subject-matched recall: $request',
    async ({ request, mode, expectRecall = false }) => {
      vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
      vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
      const store = emulatorStore();
      try {
        expect(
          await firestoreChatSmoke(store, {
            recall: true,
            request,
            expectRecall,
            expectRecallMode: mode,
          }),
        ).toMatchObject({
          historySurfaced: expectRecall,
          graphSurfaced: expectRecall,
          preflightRecallMode: mode,
          ...(expectRecall ? {} : { preflightSourceKeys: [], runtimeSourceKeys: [] }),
          sqlAccesses: 0,
          finalized: true,
        });
      } finally {
        await disposeStore(store);
      }
    },
  );

  it.each([
    'What is on my calendar tomorrow?',
    'Search my inbox for newsletter messages.',
    'What did I tell you about a rainbow?',
  ])('keeps unrelated commitments out of an explicit private read: %s', async (request) => {
    vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
    vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
    const store = emulatorStore();
    try {
      expect(
        await firestoreChatSmoke(store, {
          recall: true,
          request,
          expectRecall: false,
          expectRecallMode: 'explicit',
        }),
      ).toMatchObject({
        historySurfaced: false,
        graphSurfaced: false,
        preflightRecallMode: 'explicit',
        preflightSourceKeys: [],
        runtimeSourceKeys: [],
        sqlAccesses: 0,
        finalized: true,
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('keeps the purpose-specific open-commitment read available', async () => {
    vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
    vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
    const store = emulatorStore();
    try {
      expect(
        await firestoreChatSmoke(store, {
          recall: true,
          request: 'What are my open commitments about rainbow observation notes?',
          expectRecall: false,
          expectRecallMode: 'explicit',
          expectOpenCommitment: true,
        }),
      ).toMatchObject({
        preflightRecallMode: 'explicit',
        preflightSourceKeys: [],
        sqlAccesses: 0,
        finalized: true,
      });
    } finally {
      await disposeStore(store);
    }
  });
});
