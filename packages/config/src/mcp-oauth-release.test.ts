import { describe, expect, it } from 'vitest';
import { mcpOAuthReleaseReady } from './mcp-oauth-release.js';

const config = {
  MCP_OAUTH_ENABLED: true,
  PERSISTENCE_DRIVER: 'firestore',
  POSTGRES_SOURCE_WRITES_FENCED: false,
  ASSISTANT_RELEASE_WRITES_PAUSED: false,
  RESTORE_REHEARSAL: false,
} as const;

const firestore = {
  ASSISTANT_RELEASE_API_CONTRACT: '3',
  ASSISTANT_RELEASE_AGENT_API_MIN: '3',
  ASSISTANT_RELEASE_AGENT_API_MAX: '3',
  ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
  ASSISTANT_RELEASE_SCHEMA_VERSION: '1',
  ASSISTANT_RELEASE_SCHEMA_MIN: '1',
  ASSISTANT_RELEASE_SCHEMA_MAX: '1',
  ASSISTANT_RELEASE_MANIFEST: 'a'.repeat(64),
};

describe('MCP OAuth release declarations', () => {
  it('requires the exact serving role declaration on each supported storage version', () => {
    expect(mcpOAuthReleaseReady(config, 'web', firestore)).toBe(true);
    expect(mcpOAuthReleaseReady(config, 'agent', firestore)).toBe(false);
    const postgres = {
      ...firestore,
      ASSISTANT_RELEASE_WEB_API_MIN: '3',
      ASSISTANT_RELEASE_WEB_API_MAX: '3',
      ASSISTANT_RELEASE_SCHEMA_DRIVER: 'postgres',
      ASSISTANT_RELEASE_SCHEMA_MIN: '138',
      ASSISTANT_RELEASE_SCHEMA_MAX: '138',
      ASSISTANT_RELEASE_SCHEMA_VERSION: '138',
    };
    const postgresConfig = { ...config, PERSISTENCE_DRIVER: 'postgres' as const };
    expect(mcpOAuthReleaseReady(postgresConfig, 'agent', postgres)).toBe(true);
    expect(
      mcpOAuthReleaseReady(
        { ...postgresConfig, POSTGRES_SOURCE_WRITES_FENCED: true },
        'agent',
        postgres,
      ),
    ).toBe(false);
  });

  it.each([
    { MCP_OAUTH_ENABLED: false },
    { ASSISTANT_RELEASE_WRITES_PAUSED: true },
    { RESTORE_REHEARSAL: true },
  ])('closes activation on %o', (overrides) => {
    expect(mcpOAuthReleaseReady({ ...config, ...overrides }, 'web', firestore)).toBe(false);
  });

  it.each([
    { ASSISTANT_RELEASE_API_CONTRACT: '1' },
    { ASSISTANT_RELEASE_API_CONTRACT: '2' },
    { ASSISTANT_RELEASE_AGENT_API_MIN: '1' },
    { ASSISTANT_RELEASE_AGENT_API_MAX: undefined },
    { ASSISTANT_RELEASE_SCHEMA_DRIVER: 'postgres' },
    { ASSISTANT_RELEASE_SCHEMA_VERSION: '2' },
    { ASSISTANT_RELEASE_SCHEMA_MAX: undefined },
    { ASSISTANT_RELEASE_MANIFEST: undefined },
  ])('closes activation with incompatible release metadata %o', (overrides) => {
    expect(mcpOAuthReleaseReady(config, 'web', { ...firestore, ...overrides })).toBe(false);
  });
});
