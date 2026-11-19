import type { Config } from './index.js';

type ReleaseConfig = Pick<
  Config,
  | 'MCP_OAUTH_ENABLED'
  | 'PERSISTENCE_DRIVER'
  | 'POSTGRES_SOURCE_WRITES_FENCED'
  | 'ASSISTANT_RELEASE_WRITES_PAUSED'
  | 'RESTORE_REHEARSAL'
>;

/** Checks local release declarations. Release admission must verify the actual serving pair. */
export function mcpOAuthReleaseReady(
  config: ReleaseConfig,
  role: 'web' | 'agent',
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const driver = config.PERSISTENCE_DRIVER;
  const schema = driver === 'postgres' ? '138' : '1';
  const peer = role === 'web' ? 'AGENT' : 'WEB';
  return (
    config.MCP_OAUTH_ENABLED &&
    !config.RESTORE_REHEARSAL &&
    !config.ASSISTANT_RELEASE_WRITES_PAUSED &&
    !(driver === 'postgres' && config.POSTGRES_SOURCE_WRITES_FENCED) &&
    env.ASSISTANT_RELEASE_API_CONTRACT === '3' &&
    env[`ASSISTANT_RELEASE_${peer}_API_MIN`] === '3' &&
    env[`ASSISTANT_RELEASE_${peer}_API_MAX`] === '3' &&
    env.ASSISTANT_RELEASE_SCHEMA_DRIVER === driver &&
    env.ASSISTANT_RELEASE_SCHEMA_VERSION === schema &&
    env.ASSISTANT_RELEASE_SCHEMA_MIN === schema &&
    env.ASSISTANT_RELEASE_SCHEMA_MAX === schema &&
    /^[a-f0-9]{64}$/.test(env.ASSISTANT_RELEASE_MANIFEST ?? '')
  );
}
