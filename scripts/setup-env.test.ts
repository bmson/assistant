import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { describe, expect, it } from 'vitest';
import { generateSetupEnv, writePrivateSetupEnv } from './setup-env.js';

const configRequire = createRequire(new URL('../packages/config/package.json', import.meta.url));
const dotenv = configRequire('dotenv') as { parse(text: string): Record<string, string> };

describe('local setup env generation', () => {
  it('loads the fresh generated template with optional empty settings omitted', async () => {
    const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    const generated = generateSetupEnv(source, {
      ASSISTANT_NAME: 'Assistant',
      ASSISTANT_EMAIL: 'assistant@example.com',
      ASSISTANT_WORKSPACE_ID: 'assistant',
      ASSISTANT_TIMEZONE: 'UTC',
      ASSISTANT_SIGNATURE: '— Assistant',
      ASSISTANT_MODULES: 'minimal',
      OWNER_NAME: 'Owner',
      OWNER_EMAIL: 'owner@example.com',
      AUTH_SECRET: 'auth-secret',
      MOBILE_API_TOKEN: 'mobile-token',
      INTERNAL_API_SECRET: 'internal-secret',
      PROFILE_ENC_KEY: 'profile-key',
      MCP_ENC_KEY: 'mcp-key',
    });
    const parsed = dotenv.parse(generated);
    resetConfigForTest();
    try {
      const config = loadConfig(parsed);
      expect(config.AUTH_TRUST_HOST).toBeUndefined();
      expect(config.GMAIL_SYNC_ENABLED).toBeUndefined();
      expect(parsed.OPENROUTER_API_KEY).toBeUndefined();
    } finally {
      resetConfigForTest();
    }
  });

  it('rejects newline injection in generated values', () => {
    expect(() =>
      generateSetupEnv('OWNER_NAME=Owner\n', { OWNER_NAME: 'owner\nAUTH_SECRET=leak' }),
    ).toThrow('cannot contain a newline');
  });

  it('creates a new .env with owner-only permissions and never overwrites an existing file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'assistant-setup-env-'));
    const path = join(directory, '.env');
    try {
      writePrivateSetupEnv(path, 'AUTH_SECRET=generated\n');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(() => writePrivateSetupEnv(path, 'AUTH_SECRET=replacement\n')).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
