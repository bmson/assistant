import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { createPostgresExecutionPersistence } from './execution-repository.js';

describe('PostgreSQL executor persistence composition', () => {
  it('supplies the existing read-only skill library repository', () => {
    const persistence = createPostgresExecutionPersistence({} as Db);
    expect(persistence.skillLibrary?.kind).toBe('skill-library-repository');
  });
});
