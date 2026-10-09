import { afterEach, describe, expect, it } from 'vitest';
import {
  isModuleEnabled,
  loadConfig,
  parseAssistantModules,
  parseFirestoreEmbeddingSpace,
  resetConfigForTest,
  validateAgentPersistenceConfig,
  validateProdConfig,
  validateRestoreRehearsalConfig,
} from './index.js';

describe('config', () => {
  afterEach(() => resetConfigForTest());

  it('bounds paid email observer work independently from triage volume', () => {
    expect(
      loadConfig({ EMAIL_OBSERVER_MAX_PAID_PER_DAY: '0' }).EMAIL_OBSERVER_MAX_PAID_PER_DAY,
    ).toBe(0);
    resetConfigForTest();
    expect(
      loadConfig({ EMAIL_OBSERVER_MAX_PAID_PER_DAY: '1000' }).EMAIL_OBSERVER_MAX_PAID_PER_DAY,
    ).toBe(1000);
    resetConfigForTest();
    expect(() => loadConfig({ EMAIL_OBSERVER_MAX_PAID_PER_DAY: '1001' })).toThrow();
  });

  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config.QUEUE_DRIVER).toBe('local');
    expect(config.SELF_REPAIR_PROVIDER).toBe('github');
    expect(config.SELF_REPAIR_CODING_MODEL).toBe('gpt-6.1-sol');
    expect(config.SELF_REPAIR_REASONING_EFFORT).toBe('medium');
    expect(config.AGENT_PORT).toBe(8787);
    expect(config.DATABASE_URL).toContain('postgres://');
    expect(config.POSTGRES_SOURCE_WRITES_FENCED).toBe(false);
    expect(config.PERSISTENCE_DRIVER).toBe('postgres');
    expect(config.INTERNAL_AUTH_MODE).toBe('oidc');
    expect(config.AUTH_DEV_BYPASS).toBe(false);
    expect(config.AUTH_LOCALHOST_BYPASS).toBe(false);
    expect(config.WEB_APP_PREVIEW_ENABLED).toBe(false);
    expect(config.MOBILE_API_TOKEN).toBe('');
    expect(config.CANARY_ENABLED).toBe(false);
    expect(config.VERTEX_MODEL_PROBE_ENABLED).toBe(false);
    expect(config.CANARY_MAX_COST_USD).toBe(0.03);
    expect(config.GRAPH_RAG_ENABLED).toBe(false);
    expect(config.GRAPH_SYNC_BATCH_LIMIT).toBe(25);
    expect(isModuleEnabled(config, 'google')).toBe(true);
  });

  it('parses overrides and coerces numbers', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      AGENT_PORT: '9000',
      POSTGRES_SOURCE_WRITES_FENCED: 'true',
      WEB_APP_PREVIEW_ENABLED: 'true',
    });
    expect(config.WEB_APP_PREVIEW_ENABLED).toBe(true);
    expect(config.QUEUE_DRIVER).toBe('cloudtasks');
    expect(config.AGENT_PORT).toBe(9000);
    expect(config.POSTGRES_SOURCE_WRITES_FENCED).toBe(true);
  });

  it('supports minimal and explicit module installations', () => {
    expect(parseAssistantModules('minimal')).toEqual([]);
    expect(parseAssistantModules('sms, reminders, sms')).toEqual(['sms', 'reminders']);
    expect(() => parseAssistantModules('google,unknown')).toThrow();

    const config = loadConfig({ ASSISTANT_MODULES: 'google,search' });
    expect(isModuleEnabled(config, 'google')).toBe(true);
    expect(isModuleEnabled(config, 'sms')).toBe(false);
  });

  it('rejects invalid driver and boolean values', () => {
    expect(() => loadConfig({ QUEUE_DRIVER: 'rabbitmq' })).toThrow();
    resetConfigForTest();
    expect(() => loadConfig({ AUTH_DEV_BYPASS: 'yes' })).toThrow();
    resetConfigForTest();
    expect(() => loadConfig({ AUTH_LOCALHOST_BYPASS: 'yes' })).toThrow();
    resetConfigForTest();
    expect(() => loadConfig({ POSTGRES_SOURCE_WRITES_FENCED: 'yes' })).toThrow();
    resetConfigForTest();
    expect(() => loadConfig({ FIRESTORE_DATABASE_ID: 'Invalid_Name' })).toThrow();
    resetConfigForTest();
    expect(() => loadConfig({ PERSISTENCE_DRIVER: 'firestore', NODE_ENV: 'production' })).toThrow(
      'FIRESTORE_DATABASE_ID must be explicit',
    );
  });

  it('requires the complete isolated read-only restore rehearsal profile', () => {
    const env = {
      NODE_ENV: 'test',
      RESTORE_REHEARSAL: 'true',
      RESTORE_REHEARSAL_ROOT: '/tmp/assistant_restore_0123456789ab_files',
      ASSISTANT_WORKSPACE_ID: 'restore-0123456789ab',
      DATABASE_URL:
        'postgres://assistant_restore_reader_0123456789ab:reader-password@127.0.0.1:55432/assistant_restore_0123456789ab_test',
      PERSISTENCE_DRIVER: 'postgres',
      QUEUE_DRIVER: 'inert',
      POSTGRES_SOURCE_WRITES_FENCED: 'true',
      FILES_DRIVER: 'local',
      OTEL_EXPORTER: 'none',
    };
    expect(validateRestoreRehearsalConfig(loadConfig(env), env)).toEqual([]);

    resetConfigForTest();
    const wrongReaderIdentity = {
      ...env,
      DATABASE_URL:
        'postgres://assistant_restore_reader_fedcba987654:reader-password@127.0.0.1:55432/assistant_restore_0123456789ab_test',
    };
    expect(
      validateRestoreRehearsalConfig(loadConfig(wrongReaderIdentity), wrongReaderIdentity),
    ).toContain(
      'RESTORE_REHEARSAL requires the run-scoped assistant_restore_reader_<run ID> database role',
    );

    const unsafeEnv = { ...env, OPENROUTER_API_KEY: 'configured', QUEUE_DRIVER: 'local' };
    resetConfigForTest();
    expect(validateRestoreRehearsalConfig(loadConfig(unsafeEnv), unsafeEnv)).toEqual(
      expect.arrayContaining([
        'RESTORE_REHEARSAL requires QUEUE_DRIVER=inert',
        'OPENROUTER_API_KEY must be empty during RESTORE_REHEARSAL',
      ]),
    );
    resetConfigForTest();
    const mismatchedIdentity = { ...env, ASSISTANT_WORKSPACE_ID: 'restore-abcdefabcdef' };
    expect(
      validateRestoreRehearsalConfig(loadConfig(mismatchedIdentity), mismatchedIdentity),
    ).toContain('RESTORE_REHEARSAL database and workspace identities must use the same run ID');
  });

  it('requires an explicit Firestore identity and permits every portable module', () => {
    const config = loadConfig({ PERSISTENCE_DRIVER: 'firestore' });
    expect(validateAgentPersistenceConfig(config, {})).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GCP_PROJECT'),
        expect.stringContaining('ASSISTANT_WORKSPACE_ID'),
        expect.stringContaining('FIRESTORE_AGENT_ID'),
        expect.stringContaining('FIRESTORE_EMBEDDING_SPACE'),
      ]),
    );
    expect(validateAgentPersistenceConfig(config, {}).join('\n')).not.toContain(
      'still needs PostgreSQL',
    );
    expect(() => parseFirestoreEmbeddingSpace('{"provider":"test"}')).toThrow(
      'FIRESTORE_EMBEDDING_SPACE',
    );
    const parsedSpace = parseFirestoreEmbeddingSpace(
      '{"provider":"test","model":"unit","dimensions":1536,"revision":"r1"}',
    );
    expect(Object.isFrozen(parsedSpace)).toBe(true);
    expect(() => {
      (parsedSpace as { revision: string }).revision = 'changed';
    }).toThrow();
    const env = {
      PERSISTENCE_DRIVER: 'firestore',
      GCP_PROJECT: 'demo-assistant-test',
      ASSISTANT_WORKSPACE_ID: 'customer-installation',
      FIRESTORE_AGENT_ID: '5f492da4-b38d-413e-ad4b-ded06f3a0d19',
      FIRESTORE_DATABASE_ID: 'assistant-production',
      FIRESTORE_EMBEDDING_SPACE:
        '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
      ASSISTANT_MODULES: 'reminders,calendar',
      QUEUE_DRIVER: 'local',
    };
    resetConfigForTest();
    expect(validateAgentPersistenceConfig(loadConfig(env), env)).toEqual([]);
    resetConfigForTest();
    expect(
      validateAgentPersistenceConfig(loadConfig({ ...env, ASSISTANT_MODULES: 'all' }), env),
    ).toEqual([]);
    // A module added later without a port is still refused.
    expect(
      validateAgentPersistenceConfig(
        { ...loadConfig(env), ASSISTANT_MODULES: ['future' as never] },
        env,
      ),
    ).toContain(
      'ASSISTANT_MODULES=future still needs PostgreSQL; Firestore agent mode supports reminders,calendar,calls,browser,code,search,maps,watches,push,sms,documents,google',
    );
    expect(
      validateAgentPersistenceConfig(loadConfig(env), {
        ...env,
        NODE_ENV: 'production',
        FIRESTORE_DATABASE_ID: undefined,
      }),
    ).toContain('FIRESTORE_DATABASE_ID must be explicit in production Firestore mode');
    expect(
      validateAgentPersistenceConfig(
        {
          ...loadConfig(env),
          QUEUE_DRIVER: 'cloudtasks',
          INTERNAL_AUTH_MODE: 'shared-secret',
          CANARY_ENABLED: true,
        },
        env,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('INTERNAL_AUTH_MODE=oidc'),
        expect.stringContaining('CANARY_ENABLED'),
      ]),
    );
    expect(
      validateAgentPersistenceConfig(
        { ...loadConfig(env), QUEUE_DRIVER: 'cloudtasks', INTERNAL_AUTH_MODE: 'oidc' },
        env,
      ),
    ).toEqual([]);
  });

  it('bounds and explicitly opts into real canary side effects', () => {
    expect(loadConfig({ CANARY_ENABLED: 'true', CANARY_MAX_COST_USD: '0.04' }).CANARY_ENABLED).toBe(
      true,
    );
    resetConfigForTest();
    expect(() => loadConfig({ CANARY_MAX_COST_USD: '1' })).toThrow();
  });

  it('requires Vertex when the private model probe is enabled in Firestore mode', () => {
    const config = loadConfig({
      PERSISTENCE_DRIVER: 'firestore',
      VERTEX_MODEL_PROBE_ENABLED: 'true',
    });
    expect(validateAgentPersistenceConfig(config, {})).toContain(
      'VERTEX_MODEL_PROBE_ENABLED requires LLM_PROVIDER=vertex',
    );
  });

  it('passes prod validation for a local config', () => {
    expect(validateProdConfig(loadConfig({}))).toEqual([]);
  });

  it('flags a cloud config missing required infrastructure', () => {
    const problems = validateProdConfig(
      loadConfig({ QUEUE_DRIVER: 'cloudtasks', INTERNAL_AUTH_MODE: 'oidc' }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AGENT_URL'),
        expect.stringContaining('GCP_PROJECT'),
        expect.stringContaining('INTERNAL_OIDC_AUDIENCE'),
        expect.stringContaining('INTERNAL_OIDC_SERVICE_ACCOUNT'),
      ]),
    );
  });

  it('accepts a complete cloud config', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      INTERNAL_AUTH_MODE: 'oidc',
      AGENT_URL: 'https://agent.example',
      GCP_PROJECT: 'proj',
      CLOUD_TASKS_QUEUE: 'agent-steps',
      INTERNAL_OIDC_AUDIENCE: 'https://agent.example',
      INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@proj.iam.gserviceaccount.com',
      OPENROUTER_API_KEY: 'key',
      PUBLIC_URL: 'https://agent.example',
    });
    expect(validateProdConfig(config)).toEqual([]);
  });

  it('requires only the selected model provider credentials in cloud mode', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      LLM_PROVIDER: 'vertex',
      VERTEX_PROJECT: 'customer-project',
      VERTEX_LOCATION: 'global',
    });
    expect(validateProdConfig(config).some((p) => /OPENROUTER|VERTEX/.test(p))).toBe(false);
    expect(validateProdConfig({ ...config, VERTEX_PROJECT: '', VERTEX_LOCATION: '' })).toEqual(
      expect.arrayContaining([
        expect.stringContaining('VERTEX_PROJECT'),
        expect.stringContaining('VERTEX_LOCATION'),
      ]),
    );
    expect(validateProdConfig({ ...config, LLM_PROVIDER: 'openrouter' })).toContain(
      'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter',
    );
  });

  // Module-specific production rules moved to each module's metadata; they are
  // covered by the conformance suite in @assistant/modules.
});
