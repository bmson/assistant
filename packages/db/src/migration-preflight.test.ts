import { describe, expect, it } from 'vitest';
import { shouldBootstrap0019Targets } from './migration-preflight.js';

const prior = {
  modelsTableExists: true,
  roleTableExists: true,
  journalExists: true,
  appliedMigrations: 19,
  extractRoleExists: true,
};

describe('0019 model migration preflight', () => {
  it('bootstraps the two referenced catalog keys only when 0019 can update a role', () => {
    expect(shouldBootstrap0019Targets(prior)).toBe(true);
    expect(shouldBootstrap0019Targets({ ...prior, extractRoleExists: false })).toBe(false);
    expect(shouldBootstrap0019Targets({ ...prior, appliedMigrations: 20 })).toBe(false);
  });

  it('does no work on a fresh database before model schema creation or missing journal', () => {
    expect(shouldBootstrap0019Targets({ ...prior, modelsTableExists: false })).toBe(false);
    expect(shouldBootstrap0019Targets({ ...prior, roleTableExists: false })).toBe(false);
    expect(shouldBootstrap0019Targets({ ...prior, journalExists: false })).toBe(false);
  });
});
