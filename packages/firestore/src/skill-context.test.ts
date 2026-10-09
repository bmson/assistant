import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreSkillContextRepository } from './skill-context.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'skill-unit',
  dimensions: 1536,
  revision: '1',
};

function vector(x: number, y = 0): number[] {
  return [x, y, ...new Array(1534).fill(0)];
}

function vector768(x: number): number[] {
  return [x, ...new Array(767).fill(0)];
}

function skill(
  id: string,
  patch: Partial<Omit<Records['skills'], 'embedding'>> & { embedding?: number[] } = {},
): Records['skills'] & { embedding: number[] } {
  const now = new Date('2026-09-10T12:00:00.000Z');
  return {
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    agentId: 'owner',
    embeddingSpaceKey: embeddingSpaceKey(space),
    embedding: vector(1),
    sourceTaskId: null,
    preconditions: '',
    steps: `follow ${id}`,
    gotchas: '',
    originTrust: 'assistant',
    ownerAuthored: false,
    useCount: 0,
    successCount: 0,
    failureCount: 0,
    lastVerifiedAt: null,
    deprecated: false,
    ...patch,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore learned-skill context', () => {
  let store: InstallationStore;
  let repository: FirestoreSkillContextRepository;

  async function seed(row: Records['skills'] & { embedding: number[] }, documentId = row.id) {
    await store.doc('skills', documentId).set(
      encodeRecord({
        ...row,
        embedding: FieldValue.vector(row.embedding),
        embeddingSpace: embeddingSpaceKey(space),
      }),
    );
  }

  beforeEach(() => {
    store = emulatorStore();
    repository = new FirestoreSkillContextRepository(store, space);
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('recalls only active owner skills above threshold with a stable limit', async () => {
    await Promise.all([
      seed(skill('a-first')),
      seed(skill('b-second')),
      seed(skill('c-low', { embedding: vector(0.7, Math.sqrt(1 - 0.7 ** 2)) })),
      seed(skill('d-deprecated', { deprecated: true })),
      seed(skill('e-foreign', { agentId: 'foreign' })),
    ]);

    const limited = await repository.recall({
      agentId: 'owner',
      embedding: vector(1),
      embeddingSpaceKey: embeddingSpaceKey(space),
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ skill: { id: 'a-first', agentId: 'owner' }, similarity: 1 });
    expect(limited[0]?.skill).not.toHaveProperty('embedding');

    const all = await repository.recall({
      agentId: 'owner',
      embedding: vector(1),
      embeddingSpaceKey: embeddingSpaceKey(space),
      limit: 10,
    });
    expect(all.map((match) => match.skill.id)).toEqual(['a-first', 'b-second']);
    await expect(
      repository.recall({
        agentId: 'owner',
        embedding: vector(1).slice(1),
        embeddingSpaceKey: embeddingSpaceKey(space),
      }),
    ).rejects.toThrow('embedding space');
  });

  it('atomically scopes counters to the owner and deprecates on the third failure', async () => {
    await Promise.all([seed(skill('failed')), seed(skill('successful'))]);
    await Promise.all(
      Array.from({ length: 12 }, () => repository.bumpUse({ agentId: 'owner', ids: ['failed'] })),
    );
    await repository.bumpUse({ agentId: 'foreign', ids: ['failed'] });
    await Promise.all(
      Array.from({ length: 7 }, () =>
        repository.recordOutcome({ agentId: 'owner', id: 'successful', success: true }),
      ),
    );
    await repository.recordOutcome({ agentId: 'foreign', id: 'successful', success: true });
    await Promise.all(
      Array.from({ length: 3 }, () =>
        repository.recordOutcome({ agentId: 'owner', id: 'failed', success: false }),
      ),
    );

    expect((await store.doc('skills', 'failed').get()).data()).toMatchObject({
      useCount: 12,
      failureCount: 3,
      deprecated: true,
    });
    expect((await store.doc('skills', 'successful').get()).data()).toMatchObject({
      successCount: 7,
      deprecated: false,
    });
    expect(
      (
        await repository.recall({
          agentId: 'owner',
          embedding: vector(1),
          embeddingSpaceKey: embeddingSpaceKey(space),
        })
      ).map((match) => match.skill.id),
    ).not.toContain('failed');
  });

  it('rejects stale vector scores and corrupt stored identities', async () => {
    await seed(skill('revised'));
    await seed(skill('wrong-row-id'), 'corrupt-document');

    const firestore = store.db as typeof store.db & {
      runTransaction: typeof store.db.runTransaction;
    };
    const original = firestore.runTransaction.bind(firestore);
    let changed = false;
    firestore.runTransaction = (async (updateFunction: unknown, options?: unknown) => {
      if (!changed && (options as { readOnly?: boolean } | undefined)?.readOnly) {
        changed = true;
        await store.doc('skills', 'revised').update({
          name: 'changed after vector query',
          embedding: FieldValue.vector(vector(0, 1)),
        });
      }
      return original(updateFunction as never, options as never);
    }) as typeof store.db.runTransaction;
    try {
      const recalled = await repository.recall({
        agentId: 'owner',
        embedding: vector(1),
        embeddingSpaceKey: embeddingSpaceKey(space),
      });
      expect(recalled.map((match) => match.skill.id)).not.toContain('revised');
      expect(recalled.map((match) => match.skill.id)).not.toContain('wrong-row-id');
    } finally {
      firestore.runTransaction = original;
    }

    await repository.bumpUse({ agentId: 'owner', ids: ['corrupt-document'] });
    await repository.recordOutcome({
      agentId: 'owner',
      id: 'corrupt-document',
      success: false,
    });
    expect((await store.doc('skills', 'corrupt-document').get()).data()).toMatchObject({
      id: 'wrong-row-id',
      useCount: 0,
      failureCount: 0,
    });
  });

  it('recalls in the immutable configured 768-dimensional space', async () => {
    const configuredSpace: EmbeddingSpace = { ...space, dimensions: 768 };
    const capturedKey = embeddingSpaceKey(configuredSpace);
    const smallRepository = new FirestoreSkillContextRepository(store, configuredSpace);
    configuredSpace.provider = 'mutated-provider';
    configuredSpace.model = 'mutated-model';
    configuredSpace.dimensions = 1536;
    configuredSpace.revision = 'mutated-revision';

    const embedding = vector768(1);
    const row = skill('configured-768', {
      embedding,
      embeddingSpaceKey: capturedKey,
    });
    await store.doc('skills', row.id).set(
      encodeRecord({
        ...row,
        embedding: FieldValue.vector(embedding),
        embeddingSpace: capturedKey,
      }),
    );

    const matches = await smallRepository.recall({
      agentId: 'owner',
      embedding,
      embeddingSpaceKey: capturedKey,
    });
    expect(matches.map((match) => match.skill.id)).toEqual(['configured-768']);
    const foreignSpace: EmbeddingSpace = {
      provider: 'mutated-provider',
      model: 'mutated-model',
      dimensions: 1536,
      revision: 'mutated-revision',
    };
    await expect(
      smallRepository.recall({
        agentId: 'owner',
        embedding,
        embeddingSpaceKey: embeddingSpaceKey(foreignSpace),
      }),
    ).rejects.toThrow('does not match the configured space');
  });

  it('rejects an invalid configured embedding width', () => {
    expect(
      () =>
        new FirestoreSkillContextRepository(store, {
          ...space,
          dimensions: 0,
        }),
    ).toThrow('embedding space');
  });
});
