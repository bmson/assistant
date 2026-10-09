import { captureOwnerWritingSample, type ModelRouter } from '@assistant/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreVoiceContextRepository } from './voice-context.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'long owner voice sample identity',
  { timeout: 30000 },
  () => {
    let store: InstallationStore | undefined;
    afterEach(async () => {
      if (store) await disposeStore(store);
    });
    it('finds exact long text across bounded pages, excludes a foreign match, and captures multibyte prose', async () => {
      store = emulatorStore();
      const owner = 'synthetic-voice-owner';
      const space = {
        provider: 'synthetic',
        model: 'voice-fixture',
        dimensions: 1536,
        revision: '1',
      };
      const exactSpaceKey = embeddingSpaceKey(space);
      const repository = new FirestoreVoiceContextRepository(store, owner, space);
      const target = `Owner sample ${'original prose '.repeat(150)}`;
      const multilingual = `Owner sample ${'你好世界'.repeat(180)}`;
      expect(target.length).toBeLessThan(4000);
      expect(multilingual.length).toBeLessThan(4000);
      expect(Buffer.byteLength(multilingual)).toBeGreaterThan(1500);
      const batch = store.db.batch();
      for (let index = 0; index < 105; index++)
        batch.create(store.doc('writingSamples', `000-${index.toString().padStart(3, '0')}`), {
          id: `000-${index}`,
          agentId: owner,
          register: 'email_casual',
          context: 'auto:fixture',
          text: `Filler ${index}`,
          embeddingSpaceKey: exactSpaceKey,
          embeddingSpace: exactSpaceKey,
        });
      batch.create(store.doc('writingSamples', 'foreign-match'), {
        id: 'foreign-match',
        agentId: 'different-owner',
        register: 'email_casual',
        context: 'auto:fixture',
        text: target,
        embeddingSpaceKey: exactSpaceKey,
        embeddingSpace: exactSpaceKey,
      });
      await batch.commit();
      expect(await repository.hasSampleText(target, exactSpaceKey)).toBe(false);
      await store.doc('writingSamples', 'zzz-owner-match').create({
        id: 'zzz-owner-match',
        agentId: owner,
        register: 'email_casual',
        context: 'auto:fixture',
        text: target,
        embeddingSpaceKey: exactSpaceKey,
        embeddingSpace: exactSpaceKey,
      });
      expect(await repository.hasSampleText(target, exactSpaceKey)).toBe(true);
      const embed = vi.fn(async () => [Array(1536).fill(0.1)]);
      const router = {
        embed,
        embeddingSpace: async () => space,
      } as unknown as ModelRouter;
      expect(
        await captureOwnerWritingSample(repository, router, {
          text: multilingual,
          register: 'email_casual',
          context: 'fixture-long',
        }),
      ).toBe(true);
      expect(await repository.hasSampleText(multilingual, exactSpaceKey)).toBe(true);
      expect(
        await captureOwnerWritingSample(repository, router, {
          text: multilingual,
          register: 'email_casual',
          context: 'fixture-long',
        }),
      ).toBe(false);
      expect(embed).toHaveBeenCalledTimes(1);
    });

    it('allows a fresh owner sample after a completed privacy erasure', async () => {
      store = emulatorStore();
      const owner = 'synthetic-post-erasure-voice-owner';
      const space = {
        provider: 'synthetic',
        model: 'voice-fixture',
        dimensions: 1536,
        revision: '1',
      };
      const exactSpaceKey = embeddingSpaceKey(space);
      const repository = new FirestoreVoiceContextRepository(store, owner, space);
      await store.doc('privacyErasureJobs', owner).set({
        agentId: owner,
        generation: 'completed-erasure-generation',
        status: 'complete',
      });

      const observedGeneration = await repository.observationGeneration();
      expect(observedGeneration).toMatch(/^\d+:\d+$/);
      await repository.addSample(
        {
          register: 'email_casual',
          text: 'A fresh owner-authored sample after privacy erasure.',
          context: 'manual-post-erasure',
          embedding: Array(1536).fill(0.1),
          embeddingSpaceKey: exactSpaceKey,
        },
        observedGeneration,
      );

      expect(
        await repository.hasSampleText(
          'A fresh owner-authored sample after privacy erasure.',
          exactSpaceKey,
        ),
      ).toBe(true);
    });
  },
);
