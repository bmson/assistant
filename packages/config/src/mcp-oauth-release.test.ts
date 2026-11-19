import { readFileSync } from 'node:fs';
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
      ASSISTANT_RELEASE_SCHEMA_MIN: '141',
      ASSISTANT_RELEASE_SCHEMA_MAX: '141',
      ASSISTANT_RELEASE_SCHEMA_VERSION: '141',
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

  it('accepts the current reviewed PostgreSQL release contract and migration journal', () => {
    const contract = JSON.parse(
      readFileSync(new URL('../../../infra/gcp/release-contracts.json', import.meta.url), 'utf8'),
    );
    const journal = JSON.parse(
      readFileSync(new URL('../../db/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    const version = String(journal.entries.at(-1).idx);
    for (const role of ['web', 'agent'] as const) {
      const peer = role === 'web' ? 'agent' : 'web';
      const runtime = contract.components[role];
      const env = {
        ASSISTANT_RELEASE_API_CONTRACT: String(runtime.apiContract),
        [`ASSISTANT_RELEASE_${peer.toUpperCase()}_API_MIN`]: String(runtime.peerApi.min),
        [`ASSISTANT_RELEASE_${peer.toUpperCase()}_API_MAX`]: String(runtime.peerApi.max),
        ASSISTANT_RELEASE_SCHEMA_DRIVER: 'postgres',
        ASSISTANT_RELEASE_SCHEMA_VERSION: version,
        ASSISTANT_RELEASE_SCHEMA_MIN: String(runtime.schema.postgres.min),
        ASSISTANT_RELEASE_SCHEMA_MAX: String(runtime.schema.postgres.max),
        ASSISTANT_RELEASE_MANIFEST: 'a'.repeat(64),
      };
      const postgresConfig = { ...config, PERSISTENCE_DRIVER: 'postgres' as const };
      expect(mcpOAuthReleaseReady(postgresConfig, role, env)).toBe(true);
      for (const schema of ['138', '140', '142']) {
        expect(
          mcpOAuthReleaseReady(postgresConfig, role, {
            ...env,
            ASSISTANT_RELEASE_SCHEMA_VERSION: schema,
            ASSISTANT_RELEASE_SCHEMA_MIN: schema,
            ASSISTANT_RELEASE_SCHEMA_MAX: schema,
          }),
        ).toBe(false);
      }
      for (const key of ['ASSISTANT_RELEASE_SCHEMA_MIN', 'ASSISTANT_RELEASE_SCHEMA_MAX']) {
        expect(mcpOAuthReleaseReady(postgresConfig, role, { ...env, [key]: '138' })).toBe(false);
      }
    }
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
