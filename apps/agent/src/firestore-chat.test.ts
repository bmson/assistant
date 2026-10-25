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
      expect(
        await firestoreChatSmoke(store, {
          recall: true,
          request: 'Please help me prepare my observation notes about coastal rainbows by the sea.',
          expectRecall: true,
        }),
      ).toMatchObject({
        historySurfaced: true,
        graphSurfaced: true,
        preflightRecallMode: 'automatic',
        preflightSourceKeys: [
          '3ad8079a4efd9e8f52bd3b7387aa1f0fa81eea2ab423f7bafdfb160150000c3f',
          'ba7b526479fbc014b6c3517657f092a2132c805717a63e805cd34e9375b3fb47',
        ],
        planningRecallStatus: 'complete',
        sqlAccesses: 0,
        finalized: true,
      });
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
      mode: 'automatic' as const,
    },
    {
      request: 'Can you help me prepare my list of articles about rainbow observation notes?',
      mode: 'automatic' as const,
    },
    {
      request:
        'Please help me prepare my observation notes and research articles about coastal rainbows.',
      mode: 'automatic' as const,
    },
    {
      request: 'Please help me prepare my fictional observation notes about coastal rainbows.',
      mode: 'automatic' as const,
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
    'keeps phrase-matched commitments private for unrelated intent: $request',
    async ({ request, mode }) => {
      vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
      vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
      const store = emulatorStore();
      try {
        expect(
          await firestoreChatSmoke(store, {
            recall: true,
            request,
            expectRecall: false,
            expectRecallMode: mode,
          }),
        ).toMatchObject({
          historySurfaced: false,
          graphSurfaced: false,
          preflightRecallMode: mode,
          preflightSourceKeys: [],
          runtimeSourceKeys: [],
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
