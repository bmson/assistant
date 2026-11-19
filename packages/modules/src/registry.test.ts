import {
  assistantModuleNames,
  configKeyNames,
  loadConfig,
  resetConfigForTest,
} from '@assistant/config';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hiddenModuleNavHrefs,
  moduleDiagnostics,
  moduleProdProblems,
  validateAssistantConfig,
} from './diagnostics.js';
import { assistantModuleMetas } from './registry.js';

describe('module metadata', () => {
  afterEach(() => resetConfigForTest());

  it('covers every configured module exactly once and in schema order', () => {
    expect(assistantModuleMetas.map((meta) => meta.name)).toEqual([...assistantModuleNames]);
  });

  it('declares only configuration keys that exist in the schema', () => {
    const schemaKeys = new Set<string>(configKeyNames);
    for (const meta of assistantModuleMetas) {
      for (const key of meta.configKeys) expect(schemaKeys).toContain(key);
    }
  });

  it('gives every module a title, a summary, and a billing declaration', () => {
    for (const meta of assistantModuleMetas) {
      expect(meta.title).not.toBe('');
      expect(meta.summary).not.toBe('');
      expect(meta.billing).toBeDefined();
    }
  });

  it('reports module readiness without exposing secrets', () => {
    const config = loadConfig({
      ASSISTANT_MODULES: 'google,search',
      GOOGLE_OAUTH_CLIENT_ID: 'client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      BOT_GOOGLE_REFRESH_TOKEN: 'refresh',
    });
    expect(moduleDiagnostics(config)).toEqual(
      expect.arrayContaining([
        { module: 'google', enabled: true, ready: true, detail: 'ready' },
        {
          module: 'search',
          enabled: true,
          ready: false,
          detail: 'missing search provider or key',
        },
        { module: 'sms', enabled: false, ready: false, detail: 'disabled' },
      ]),
    );
  });

  it('names the search provider once it is configured', () => {
    const config = loadConfig({
      ASSISTANT_MODULES: 'search',
      SEARCH_PROVIDER: 'brave',
      SEARCH_API_KEY: 'key',
    });
    expect(moduleDiagnostics(config)).toContainEqual({
      module: 'search',
      enabled: true,
      ready: true,
      detail: 'ready (brave)',
    });
  });

  it('recognizes personal Calendar onboarding without claiming Workspace or an account is connected', () => {
    const config = loadConfig({
      ASSISTANT_MODULES: 'calendar,google',
      GOOGLE_OAUTH_CLIENT_ID: 'client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_CALENDAR_OAUTH_CALLBACK_URL:
        'https://example.invalid/api/oauth/google-calendar/callback',
      MCP_ENC_KEY: 'a'.repeat(64),
    });
    expect(moduleDiagnostics(config)).toContainEqual({
      module: 'calendar',
      enabled: true,
      ready: true,
      detail: 'personal Calendar onboarding configured; account connection checked separately',
    });
    expect(moduleDiagnostics(config)).toContainEqual({
      module: 'google',
      enabled: true,
      ready: false,
      detail: 'missing Google OAuth credentials',
    });
    config.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL = 'http://example.invalid/invalid';
    expect(moduleDiagnostics(config).find((entry) => entry.module === 'calendar')?.ready).toBe(
      false,
    );
  });

  it('distinguishes browser research from the optional direct search API', () => {
    const config = loadConfig({ ASSISTANT_MODULES: 'browser,search' });
    expect(moduleDiagnostics(config)).toContainEqual({
      module: 'search',
      enabled: true,
      ready: false,
      detail: 'direct search provider missing; browser research is still available',
    });
  });

  it('leaves local installations unvalidated', () => {
    expect(moduleProdProblems(loadConfig({ ASSISTANT_MODULES: 'minimal' }))).toEqual([]);
  });

  it('flags cloud settings that require a disabled module', () => {
    const problems = validateAssistantConfig(
      loadConfig({
        ASSISTANT_MODULES: 'minimal',
        QUEUE_DRIVER: 'cloudtasks',
        INTERNAL_AUTH_MODE: 'shared-secret',
        INTERNAL_API_SECRET: 'secret',
        AGENT_URL: 'https://agent.example',
        GCP_PROJECT: 'proj',
        OPENROUTER_API_KEY: 'key',
        PUBLIC_URL: 'https://agent.example',
        GMAIL_PUBSUB_TOPIC: 'projects/proj/topics/gmail',
        GMAIL_PUSH_SERVICE_ACCOUNT: 'push@proj.iam.gserviceaccount.com',
        CANARY_ENABLED: 'true',
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('google module'),
        expect.stringContaining('browser module'),
      ]),
    );
  });

  it('hides navigation belonging to disabled modules', () => {
    expect(hiddenModuleNavHrefs(loadConfig({ ASSISTANT_MODULES: 'minimal' }))).toContain(
      '/documents',
    );
    resetConfigForTest();
    const hidden = hiddenModuleNavHrefs(loadConfig({ ASSISTANT_MODULES: 'documents' }));
    expect(hidden.has('/documents')).toBe(false);
    expect(hidden.has('/calls')).toBe(true);
    resetConfigForTest();
    expect(hiddenModuleNavHrefs(loadConfig({ ASSISTANT_MODULES: 'documents,calls' })).size).toBe(0);
  });
});
