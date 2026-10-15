import type { EmbeddingSpace } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { createFirestoreExecutionPersistence } from './execution.js';
import type { InstallationStore } from './store.js';

describe('Firestore executor persistence composition', () => {
  it('supplies the existing read-only skill library repository', () => {
    const space: EmbeddingSpace = {
      provider: 'synthetic',
      model: 'skill-inventory-test',
      dimensions: 1536,
      revision: '1',
    };
    const persistence = createFirestoreExecutionPersistence(
      {} as InstallationStore,
      'agent-1',
      space,
    );
    expect(persistence.skillLibrary?.kind).toBe('skill-library-repository');
  });
});
