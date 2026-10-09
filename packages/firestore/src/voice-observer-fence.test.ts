import { randomUUID } from 'node:crypto';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreVoiceContextRepository } from './voice-context.js';

const space = { provider: 'synthetic', model: 'voice-fence', dimensions: 1536, revision: '1' };
const text = `Owner writing sample ${randomUUID()} ${'你好世界 prose. '.repeat(150)}`.trim();
const embedding = Array(1536).fill(0.1);
function values(agentId: string, conversationId: string) {
  const channelMessageId = `gmail:${randomUUID()}`,
    messageId = randomUUID();
  const input = {
    register: 'email_casual',
    text,
    context: 'auto:inbound-email',
    embedding,
    embeddingSpaceKey: embeddingSpaceIdentityKey(space),
  };
  const work = {
    id: randomUUID(),
    agentId,
    sourceKey: channelMessageId,
    channelMessageId,
    sourceKind: 'message',
    observerKey: 'google.owner-voice-sample',
    observerVersion: 1,
    workClass: 'paid_ambiguous',
    status: 'prepared',
    attemptCount: 1,
    claimToken: randomUUID(),
    claimGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    privacyGeneration: null,
    preparedResult: {
      register: 'email_casual',
      context: 'inbound-email',
      observedGeneration: null,
      embeddingSpaceKey: input.embeddingSpaceKey,
      embedding,
    },
  };
  const ingest = {
    id: randomUUID(),
    agentId,
    channelMessageId,
    conversationId,
    fromEmail: 'owner@example.test',
    subject: 'Synthetic voice',
    contentTrust: 'owner',
    authenticated: true,
    ingestMode: 'direct',
    hasExternalOrUnknown: false,
    admittedSourceKind: 'message',
    admittedSourceId: messageId,
  };
  const message = {
    id: messageId,
    conversationId,
    channelMessageId,
    role: 'user',
    text,
    parts: [{ type: 'text', text }],
    origin: 'owner',
    hiddenAt: null,
  };
  const fence = {
    id: work.id,
    agentId,
    claimToken: work.claimToken,
    claimGeneration: 1,
    expectedPrivacyGeneration: null,
  };
  return { input, work, ingest, message, fence };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore atomic email voice effect', () => {
  let store: ReturnType<typeof emulatorStore>;
  let f: ReturnType<typeof values>;
  let voice: FirestoreVoiceContextRepository;
  let now: Date;
  beforeEach(async () => {
    now = new Date();
    store = emulatorStore(() => new Date(now));
    const agentId = randomUUID(),
      conversationId = randomUUID();
    f = values(agentId, conversationId);
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('conversations', conversationId).set({ id: conversationId, agentId });
    await store.doc('messages', f.message.id).set(f.message);
    await store
      .doc('messageChannelIds', f.work.channelMessageId)
      .set({ messageId: f.message.id, conversationId });
    await store.doc('emailIngest', f.ingest.id).set(f.ingest);
    await store.doc('emailObserverWork', f.work.id).set(f.work);
    voice = new FirestoreVoiceContextRepository(store, agentId, space);
  });
  afterEach(async () => disposeStore(store));
  const count = async () =>
    (await store.collection('writingSamples').where('agentId', '==', f.fence.agentId).get()).size;
  it('accepts initial null privacy generation and atomically deduplicates concurrent replay', async () => {
    await Promise.all([
      voice.addSample(f.input, null, { emailObserverEffectFence: f.fence }),
      voice.addSample(f.input, null, { emailObserverEffectFence: f.fence }),
    ]);
    expect(await count()).toBe(1);
  });
  it('rejects stale token without saving a sample', async () => {
    await expect(
      voice.addSample(f.input, null, {
        emailObserverEffectFence: { ...f.fence, claimToken: randomUUID() },
      }),
    ).rejects.toThrow(/claim or source/);
    expect(await count()).toBe(0);
  });
  it('rejects changed body or embedding despite matching claim identity', async () => {
    await expect(
      voice.addSample({ ...f.input, text: `${text} injected` }, null, {
        emailObserverEffectFence: f.fence,
      }),
    ).rejects.toThrow(/claim or source/);
    await expect(
      voice.addSample({ ...f.input, embedding: Array(1536).fill(0.2) }, null, {
        emailObserverEffectFence: f.fence,
      }),
    ).rejects.toThrow(/claim or source/);
    expect(await count()).toBe(0);
  });
  it('rejects erasure generation advanced after preparation', async () => {
    await store
      .doc('privacyErasureJobs', f.fence.agentId)
      .set({ agentId: f.fence.agentId, status: 'complete' });
    await expect(
      voice.addSample(f.input, null, { emailObserverEffectFence: f.fence }),
    ).rejects.toThrow(/Privacy erasure changed/);
    expect(await count()).toBe(0);
  });
  it('accepts a fresh voice observation after erasure with both privacy fences matched', async () => {
    const generation = 'completed-erasure-generation';
    await store.doc('privacyErasureJobs', f.fence.agentId).set({
      agentId: f.fence.agentId,
      generation,
      status: 'complete',
    });
    const observedGeneration = await voice.observationGeneration();
    expect(observedGeneration).toMatch(/^\d+:\d+$/);
    await store.doc('emailObserverWork', f.work.id).set({
      ...f.work,
      privacyGeneration: generation,
      preparedResult: {
        ...f.work.preparedResult,
        observedGeneration,
      },
    });

    await voice.addSample(f.input, observedGeneration, {
      emailObserverEffectFence: {
        ...f.fence,
        expectedPrivacyGeneration: generation,
      },
    });

    expect(await count()).toBe(1);
  });
  it('rejects expired prepared lease before saving', async () => {
    now = new Date(now.getTime() + 60_001);
    await expect(
      voice.addSample(f.input, null, { emailObserverEffectFence: f.fence }),
    ).rejects.toThrow(/claim or source/);
    expect(await count()).toBe(0);
  });
});
