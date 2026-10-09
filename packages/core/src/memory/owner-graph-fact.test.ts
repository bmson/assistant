import type {
  OwnerKnowledgeGraphFactAtomicInput,
  OwnerKnowledgeGraphFactRepository,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { createOwnerKnowledgeGraphFactWithRepository } from './knowledge-graph.js';

function fakeRepository() {
  const created: OwnerKnowledgeGraphFactAtomicInput[] = [];
  const repository: OwnerKnowledgeGraphFactRepository = {
    kind: 'owner-knowledge-graph-fact-repository',
    async context() {
      return { agentId: 'agent-1', timeZone: 'UTC', locale: 'en-US', contacts: [] };
    },
    async entity() {
      return null;
    },
    async correctionTarget() {
      return null;
    },
    async createAtomic(input) {
      created.push(input);
      return { memoryId: 'memory-1', relationId: 'relation-1' };
    },
  };
  return { repository, created };
}

const router = {
  async embeddingSpace() {
    return { provider: 'test', model: 'embedding', dimensions: 3, revision: '1' };
  },
  async embed(texts: string[]) {
    return texts.map(() => [1, 0, 0]);
  },
};

const connection = (note: string) => ({
  subject: { label: 'Anna', kind: 'person' as const },
  predicate: 'parent_of',
  object: { label: 'Baldvin', kind: 'person' as const },
  note,
});

describe('owner-drawn graph facts', () => {
  // Drawing a line between two people is the owner stating a fact; making them
  // also write an essay about it was friction, not provenance.
  it('saves without a note, sourced as the owner’s own statement', async () => {
    const { repository, created } = fakeRepository();
    const result = await createOwnerKnowledgeGraphFactWithRepository(
      { repository, router },
      connection('   '),
    );
    expect(result.error).toBeUndefined();
    expect(created).toHaveLength(1);
    expect(created[0]?.content).toBe('Anna parent of Baldvin.');
  });

  it('keeps a note as context when one is given', async () => {
    const { repository, created } = fakeRepository();
    await createOwnerKnowledgeGraphFactWithRepository(
      { repository, router },
      connection('  met   at university '),
    );
    expect(created[0]?.content).toBe('Anna parent of Baldvin. Owner note: met at university');
  });

  it('still refuses a connection with no relationship', async () => {
    const { repository, created } = fakeRepository();
    const result = await createOwnerKnowledgeGraphFactWithRepository(
      { repository, router },
      { ...connection(''), predicate: '  ' },
    );
    expect(result.error).toBe('Add both items and how they are related.');
    expect(created).toHaveLength(0);
  });
});
