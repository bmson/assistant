import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { type AssistantModule, assistantModuleNames, parseAssistantModules } from './modules.js';

export {
  type AssistantModule,
  assistantModuleNames,
  isModuleEnabled,
  parseAssistantModules,
} from './modules.js';

// Load the repository's one environment file regardless of the process cwd.
export const repoRoot = process.env.ASSISTANT_REPO_ROOT
  ? path.resolve(process.env.ASSISTANT_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) {
  // dotenv >= 17 logs an "injected env" banner by default; keep script and CLI output clean.
  dotenv.config({ path: envFile, quiet: true });
}

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const enabledBooleanString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

/**
 * The single authoritative configuration schema for every app, package, worker,
 * and deployment script. Values stay flat because they map one-to-one to
 * environment variables and Secret Manager bindings.
 */
const ConfigSchema = z.object({
  // Safe generic identity defaults. Real installations write explicit values.
  ASSISTANT_NAME: z.string().trim().min(1).default('Assistant'),
  ASSISTANT_EMAIL: z.string().trim().email().default('assistant@example.com'),
  ASSISTANT_WORKSPACE_ID: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .default('assistant'),
  ASSISTANT_TIMEZONE: z.string().trim().min(1).default('UTC'),
  ASSISTANT_LOCALE: z.string().trim().min(2).default('en'),
  ASSISTANT_SIGNATURE: z.string().default('— Assistant'),
  ASSISTANT_MODULES: z
    .string()
    .default('all')
    .transform((value, ctx): AssistantModule[] => {
      try {
        return parseAssistantModules(value);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message:
            error instanceof Error
              ? error.message
              : `expected a comma-separated subset of: ${assistantModuleNames.join(', ')}`,
        });
        return z.NEVER;
      }
    }),

  DATABASE_URL: z.string().default('postgres://assistant:assistant@localhost:5432/assistant'),
  /** Process-level Drizzle write fence for a controlled PostgreSQL cutover window. */
  POSTGRES_SOURCE_WRITES_FENCED: booleanString,
  /** PostgreSQL remains the default; Firestore is an explicit agent-only preview profile. */
  PERSISTENCE_DRIVER: z.enum(['postgres', 'firestore']).default('postgres'),
  /** Named customer database; local emulator fixtures may use (default). */
  FIRESTORE_DATABASE_ID: z
    .string()
    .regex(/^\(default\)$|^[a-z][a-z0-9-]{2,61}[a-z0-9]$/)
    .default('(default)'),
  FIRESTORE_AGENT_ID: z.string().default(''),
  /** JSON embedding provenance: provider, model, dimensions, and revision. */
  FIRESTORE_EMBEDDING_SPACE: z.string().default(''),
  /**
   * Connection pool shape, per process.
   *
   * Every service builds its own pool, so the ceiling a database sees is this
   * times the number of running containers — an agent at concurrency 4 across
   * 3 instances plus 2 web instances is 50 connections against defaults that
   * are usually 25 or 100. `DB_POOL_MAX` is the knob for that.
   *
   * The timeouts exist because a pool without them degrades quietly: an idle
   * connection is held for the life of the process, and one pathological query
   * pins a connection with nothing to end it. `DB_STATEMENT_TIMEOUT_MS` is the
   * backstop — set it above the slowest legitimate query, not near it.
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(60_000),
  OPENROUTER_API_KEY: z.string().default(''),
  LLM_PROVIDER: z.enum(['openrouter', 'vertex']).default('openrouter'),
  VERTEX_PROJECT: z.string().default(''),
  VERTEX_LOCATION: z.string().default(''),
  OWNER_NAME: z.string().trim().min(1).default('Owner'),
  OWNER_EMAIL: z.string().trim().email().default('owner@example.com'),
  OWNER_PHONE: z.string().default(''),
  /** Optional separate production URL used by local deployment scripts. */
  PROD_DATABASE_URL: z.string().default(''),
  AUTH_SECRET: z.string().default(''),
  /**
   * `passkey` signs the owner in with WebAuthn credentials stored in Firestore
   * and needs no Google OAuth client. The installer issues a single-use claim
   * link; see docs/consumer-owner-passkeys.md.
   */
  OWNER_AUTH_MODE: z.enum(['google', 'passkey']).default('google'),
  AUTH_GOOGLE_ID: z.string().default(''),
  AUTH_GOOGLE_SECRET: z.string().default(''),
  AUTH_URL: z.string().default(''),
  AUTH_TRUST_HOST: z.enum(['true', 'false']).optional(),
  /**
   * Owner-generated bearer token for the native iOS client. Empty leaves the
   * mobile API behind the normal web session only. Keep this separate from
   * AUTH_SECRET: rotating a phone credential must not invalidate web sessions.
   */
  MOBILE_API_TOKEN: z.string().default(''),
  /** Secret Manager resource used only by installations that explicitly support rotation. */
  MOBILE_API_TOKEN_SECRET_NAME: z
    .string()
    .regex(/^$|^[A-Za-z0-9_-]{1,255}$/)
    .default(''),
  MOBILE_API_TOKEN_ROTATION_ENABLED: booleanString,
  QUEUE_DRIVER: z.enum(['local', 'cloudtasks', 'inert']).default('local'),
  /** Strictly fenced read-only runtime used only for local PostgreSQL restore rehearsals. */
  RESTORE_REHEARSAL: booleanString,
  /** Release-only maintenance fence while the service pair is being upgraded. */
  ASSISTANT_RELEASE_WRITES_PAUSED: booleanString,
  /** Opt in to retained chat pages only in development on a loopback origin. */
  WEB_APP_PREVIEW_ENABLED: booleanString,
  /** Dedicated local workspace root required when RESTORE_REHEARSAL=true. */
  RESTORE_REHEARSAL_ROOT: z.string().default(''),
  FILES_DRIVER: z.enum(['local', 'gcs']).default('local'),
  GCS_ENDPOINT: z.string().default('http://localhost:4443'),
  WORKSPACE_BUCKET: z.string().default('assistant-workspace'),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  WEB_PORT: z.coerce.number().default(3000),
  AGENT_PORT: z.coerce.number().default(8787),
  /**
   * Internal callbacks use Google-signed OIDC in deployed environments. The
   * shared-secret mode is an explicit local-development escape hatch only.
   */
  INTERNAL_AUTH_MODE: z.enum(['oidc', 'shared-secret']).default('oidc'),
  INTERNAL_API_SECRET: z.string().default(''),
  /** Service URL used to derive a distinct OIDC audience for each internal route. */
  INTERNAL_OIDC_AUDIENCE: z.string().default(''),
  INTERNAL_OIDC_SERVICE_ACCOUNT: z.string().default(''),
  /** Expected `email` claim on the Pub/Sub push ID token. */
  GMAIL_PUSH_SERVICE_ACCOUNT: z.string().default(''),
  /** Explicit opt-in for bypassing owner authentication outside production. */
  AUTH_DEV_BYPASS: booleanString,
  /**
   * Explicit bypass for a production-built container published only on the
   * local machine. Auth resolution additionally requires a loopback AUTH_URL
   * and QUEUE_DRIVER=local.
   */
  AUTH_LOCALHOST_BYPASS: booleanString,
  OTEL_SERVICE_NAME: z.string().default('assistant'),
  OTEL_EXPORTER: z.enum(['console', 'otlp', 'none']).default('none'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  BOT_GOOGLE_REFRESH_TOKEN: z.string().default(''),
  /** projects/<id>/topics/<name> — enables Gmail push; local dev polls instead. */
  GMAIL_PUBSUB_TOPIC: z.string().default(''),
  GCP_PROJECT: z.string().default(''),
  /** Standard or detailed Cloud Billing export: project.dataset.table. */
  GCP_BILLING_EXPORT_TABLE: z.string().default(''),
  GCP_BILLING_QUERY_PROJECT: z.string().default(''),
  GCP_BILLING_LOCATION: z.string().default('US'),
  GCP_BILLING_SCOPE: z.enum(['project', 'billing_account']).default('project'),
  /** Reject a billing query before it exceeds this scan allowance. */
  GCP_BILLING_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(1_000_000_000),
  GCP_LOCATION: z.string().default('us-west1'),
  CLOUD_TASKS_QUEUE: z.string().default('agent-steps'),
  /** The agent service's own public URL (Cloud Tasks callback target). */
  AGENT_URL: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),
  /** The web dashboard's public URL, for links the agent sends the owner. */
  WEB_URL: z.string().default(''),
  /** Caller ID for outbound calls; defaults to TWILIO_FROM_NUMBER. */
  TWILIO_VOICE_FROM_NUMBER: z.string().default(''),
  /** Country calling codes the assistant may dial, comma-separated (default: US/Canada). */
  CALL_ALLOWED_COUNTRY_CODES: z.string().default('1'),
  /** Outbound calls per rolling day. */
  CALL_DAILY_LIMIT: z.coerce.number().int().min(0).max(100).default(10),
  /** Hard ceiling on one call's length; a brief may ask for less. */
  CALL_MAX_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  PROFILE_ENC_KEY: z.string().default(''),
  /** Encryption key for owner-managed MCP bearer credentials. */
  MCP_ENC_KEY: z.string().default(''),
  /** local = detached child process; cloudrun = Cloud Run Job execution. */
  BROWSER_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  BROWSER_JOB_NAME: z.string().default('assistant-browser'),
  /** Code-execution worker: local child process vs Cloud Run Job. */
  CODE_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  CODE_JOB_NAME: z.string().default('assistant-code'),
  /** Document-processor worker: local child process vs Cloud Run Job. */
  PROCESSOR_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  PROCESSOR_JOB_NAME: z.string().default('assistant-processor'),
  /** HMAC key used by the owner's location Shortcut; empty disables ingest. */
  LOCATION_PING_SECRET: z.string().default(''),
  LOCATION_RETENTION_DAYS: z.coerce.number().min(1).max(90).default(3),
  /**
   * Whether to keep what the models were asked and what they answered, in the
   * `model_call_audit` table. The cost ledger alone cannot answer a question
   * about answer quality, so without this there is no way to review the
   * assistant's own output, compare a routing change against real traffic, or
   * notice a regression before an owner does.
   *
   * It is `off` by default because these rows necessarily contain the owner's
   * mail, calendar and conversations.
   *
   * `redacted` scrubs email addresses, phone numbers, long digit runs (booking,
   * account and card numbers) and URL paths before writing, keeping the shape
   * of the exchange and the reasoning while dropping the identifiers. `full`
   * stores the text verbatim: more useful for grounding review, and a much more
   * sensitive table — appropriate for a single-owner installation reviewing its
   * own assistant, not for one holding anyone else's mail.
   */
  LLM_AUDIT_CAPTURE: z.enum(['off', 'redacted', 'full']).default('off'),
  /** How long captured prompts and answers are kept before maintenance purges them. */
  LLM_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /**
   * APNs token auth for owner-facing push. All four together enable the push
   * module; any missing and it stands down. APNS_PRIVATE_KEY is the .p8 file
   * contents (base64-encoded so it fits one env line).
   */
  APNS_KEY_ID: z.string().default(''),
  APNS_TEAM_ID: z.string().default(''),
  APNS_PRIVATE_KEY: z.string().default(''),
  /** The iOS app's bundle id, which is the APNs topic. */
  APNS_BUNDLE_ID: z.string().default(''),
  /**
   * Apple Maps Server API + Maps Web Snapshots (directions and route maps).
   * Optional: when unset, the maps module signs with the APNS_* key, which
   * works when that .p8 key also has MapKit enabled in the developer portal.
   */
  MAPKIT_KEY_ID: z.string().default(''),
  MAPKIT_TEAM_ID: z.string().default(''),
  MAPKIT_PRIVATE_KEY: z.string().default(''),
  /**
   * Age-based pruning of conversation/tool/model history. 0 (the default)
   * keeps everything forever — deleting history is an owner policy decision,
   * so the platform ships the machinery and leaves the knob off. A positive
   * value makes the sweep prune rows older than that many days.
   */
  HISTORY_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .max(3650)
    .default(0)
    .refine((days) => days === 0 || days >= 30, {
      message: 'HISTORY_RETENTION_DAYS must be 0 (keep forever) or at least 30',
    }),
  /**
   * Same for the cost ledger. The floor is higher because budget hard caps
   * count a rolling month of cost_events — pruning inside that window would
   * quietly raise the spending limit.
   */
  COST_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .max(3650)
    .default(0)
    .refine((days) => days === 0 || days >= 60, {
      message: 'COST_RETENTION_DAYS must be 0 (keep forever) or at least 60',
    }),
  /**
   * Explicit true/false wins; otherwise Gmail sync runs only in production.
   * The google module is an additional hard gate.
   */
  GMAIL_SYNC_ENABLED: z.enum(['true', 'false']).optional(),
  /** Rollout gate for draining durable email observer work; deliberately off until acceptance closes. */
  EMAIL_OBSERVER_WORKER_ENABLED: booleanString,
  /**
   * What the assistant's mailbox IS.
   *
   * `direct` (the historical behaviour): people write to the assistant, and the
   * sender of a message is the party directing it. Sender trust therefore
   * decides what the resulting task may do.
   *
   * `forwarded`: the mailbox is a pipe the owner points their own mail into, so
   * the OWNER is the party directing the assistant and the sender is only
   * content. Ingest tasks run at owner trust *and* tainted — the direction and
   * the provenance are tracked separately (see `payload.ingest` in email-sync).
   * Nothing is ever auto-replied in this mode.
   */
  EMAIL_INGEST_MODE: z.enum(['direct', 'forwarded']).default('direct'),
  /**
   * How interesting a forwarded message must be (1-5) before it earns a full
   * triage task. Below it the message is still stored, indexed and remembered —
   * it just does not interrupt the owner or spend reasoning budget.
   */
  EMAIL_INGEST_IMPORTANCE_THRESHOLD: z.coerce.number().int().min(1).max(5).default(3),
  /**
   * How important a forwarded message must be (1-5) to interrupt the owner the
   * moment it lands — a deterministic heads-up that does not wait for the
   * triage task's own judgment. Default 4: a real commitment, money moving, or
   * a dated obligation. The deeper triage task still runs at the lower
   * importance threshold and may follow up with what it found.
   */
  EMAIL_INGEST_NOTIFY_THRESHOLD: z.coerce.number().int().min(1).max(5).default(4),
  /**
   * Daily ceiling on deep triage tasks from forwarded mail. Owner-trust tasks
   * bypass the external-sender flood backstop (`underExternalTaskLimit`), so
   * ingest needs its own brake or one busy day can exhaust the month's budget.
   */
  EMAIL_INGEST_MAX_TRIAGE_PER_DAY: z.coerce.number().int().min(0).max(1000).default(40),
  /** Separate paid-observer cap; never coupled to forwarded triage task volume. */
  EMAIL_OBSERVER_MAX_PAID_PER_DAY: z.coerce.number().int().min(0).max(1000).default(20),
  /**
   * Recipient domains the assistant may send mail to, comma-separated and
   * empty-means-unrestricted. This mirrors a restriction enforced at the mail
   * provider: without it the assistant queues approval cards for sends the
   * provider will bounce, which trains the owner to approve things that never
   * happen. Enforced as a hard rejection, never as an approval.
   */
  EMAIL_OUTBOUND_DOMAINS: z.string().default(''),
  SEARCH_PROVIDER: z.enum(['none', 'brave', 'tavily', 'serper']).default('none'),
  SEARCH_API_KEY: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_REPO: z.string().default(''),
  SELF_REPAIR_ENABLED: booleanString,
  SELF_REPAIR_PROVIDER: z.enum(['github', 'openai_hosted']).default('github'),
  SELF_REPAIR_OPENAI_API_KEY: z.string().default(''),
  SELF_REPAIR_GITHUB_TOKEN: z.string().default(''),
  SELF_REPAIR_CODING_MODEL: z.string().default('gpt-6.1-sol'),
  SELF_REPAIR_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  SELF_REPAIR_WORKER_REPO: z.string().default(''),
  SELF_REPAIR_ALLOW_EXECUTOR: booleanString,
  SELF_REPAIR_DAILY_LIMIT: z.coerce.number().int().min(1).max(5).default(2),
  SELF_REPAIR_WORKFLOW: z.string().default('self-repair.yml'),
  SELF_REPAIR_REF: z.string().default('main'),
  SELF_REPAIR_DEPLOYMENT_URL: z.string().default(''),
  TRACES_BUCKET: z.string().default(''),
  /** Explicit opt-in: canaries perform real provider side effects. */
  CANARY_ENABLED: booleanString,
  /** Explicit rehearsal-only opt-in: permits the authenticated, task-free Vertex probe. */
  VERTEX_MODEL_PROBE_ENABLED: booleanString,
  CANARY_MAX_COST_USD: z.coerce.number().min(0.01).max(0.1).default(0.03),
  CHAT_RECALL_ENABLED: booleanString,
  /** Evidence-grounded native card composition in final responses. */
  GENERATIVE_CARDS_ENABLED: enabledBooleanString,
  /** Allow cardable inbound mail to earn a card task below the urgency threshold. */
  PROACTIVE_CARDS_ENABLED: enabledBooleanString,
  /** Explicit opt-in: graph-backed personal-memory recall, layered over chat recall. */
  GRAPH_RAG_ENABLED: booleanString,
  /**
   * Source memories the offline graph sync extracts per run. This, not the
   * budget, is what actually paces a backfill: at two runs an hour the default
   * drains ~1,200 sources a day, well inside the run's own task cap. Raise it
   * to clear a backlog sooner and lower it again afterwards; the per-run budget
   * stays the safety net either way, since exhausting it ends the batch.
   */
  GRAPH_SYNC_BATCH_LIMIT: z.coerce.number().int().min(1).max(500).default(25),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Fail-closed profile check used before any restore-rehearsal process starts. */
export function validateRestoreRehearsalConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!config.RESTORE_REHEARSAL) return [];
  const problems: string[] = [];
  if (env.NODE_ENV === 'production') problems.push('RESTORE_REHEARSAL cannot run in production');
  if (config.PERSISTENCE_DRIVER !== 'postgres')
    problems.push('RESTORE_REHEARSAL requires PERSISTENCE_DRIVER=postgres');
  if (config.QUEUE_DRIVER !== 'inert')
    problems.push('RESTORE_REHEARSAL requires QUEUE_DRIVER=inert');
  if (!config.POSTGRES_SOURCE_WRITES_FENCED)
    problems.push('POSTGRES_SOURCE_WRITES_FENCED=true is required for RESTORE_REHEARSAL');
  const workspaceRunId = config.ASSISTANT_WORKSPACE_ID.match(/^restore-([a-f0-9]{12})$/)?.[1];
  if (!workspaceRunId)
    problems.push('ASSISTANT_WORKSPACE_ID must be restore-<12 hex> during RESTORE_REHEARSAL');
  if (config.FILES_DRIVER !== 'local')
    problems.push('RESTORE_REHEARSAL requires FILES_DRIVER=local');
  if (
    config.BROWSER_DRIVER !== 'local' ||
    config.CODE_DRIVER !== 'local' ||
    config.PROCESSOR_DRIVER !== 'local'
  )
    problems.push('RESTORE_REHEARSAL requires local browser, code, and processor drivers');
  if (
    !/^\/(?:[^/]+\/)*assistant_restore_[a-f0-9]{12}_files$/.test(config.RESTORE_REHEARSAL_ROOT) ||
    config.RESTORE_REHEARSAL_ROOT.split('/').includes('..')
  )
    problems.push(
      'RESTORE_REHEARSAL_ROOT must be an absolute assistant_restore_<12 hex>_files directory',
    );
  if (config.DATABASE_URL) {
    try {
      const database = new URL(config.DATABASE_URL);
      const host = database.hostname.replace(/^\[|\]$/g, '');
      const octets = host.split('.').map(Number);
      const loopback =
        host === '::1' ||
        (octets.length === 4 &&
          octets[0] === 127 &&
          octets.every((octet) => octet >= 0 && octet <= 255));
      const name = decodeURIComponent(database.pathname.slice(1));
      if (
        !['postgres:', 'postgresql:'].includes(database.protocol) ||
        !loopback ||
        !/^assistant_restore_[a-f0-9]{12}_test$/.test(name)
      )
        problems.push(
          'RESTORE_REHEARSAL requires a loopback assistant_restore_<12 hex>_test database',
        );
      const databaseRunId = name.match(/^assistant_restore_([a-f0-9]{12})_test$/)?.[1];
      if (databaseRunId && workspaceRunId && databaseRunId !== workspaceRunId)
        problems.push(
          'RESTORE_REHEARSAL database and workspace identities must use the same run ID',
        );
      if (
        !workspaceRunId ||
        decodeURIComponent(database.username) !== `assistant_restore_reader_${workspaceRunId}`
      )
        problems.push(
          'RESTORE_REHEARSAL requires the run-scoped assistant_restore_reader_<run ID> database role',
        );
      if (!database.password)
        problems.push('RESTORE_REHEARSAL requires an explicit read-only database credential');
    } catch {
      problems.push('RESTORE_REHEARSAL requires a valid PostgreSQL DATABASE_URL');
    }
  }
  const externalCredentials = [
    'OPENROUTER_API_KEY',
    'AUTH_GOOGLE_SECRET',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'BOT_GOOGLE_REFRESH_TOKEN',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'MOBILE_API_TOKEN',
    'INTERNAL_API_SECRET',
    'LOCATION_PING_SECRET',
  ] as const;
  for (const key of externalCredentials) {
    if (config[key]) problems.push(`${key} must be empty during RESTORE_REHEARSAL`);
  }
  if (config.GCP_PROJECT || config.AGENT_URL || config.WEB_URL || config.GMAIL_PUBSUB_TOPIC)
    problems.push(
      'Cloud project, callback, and push routing must be unset during RESTORE_REHEARSAL',
    );
  if (config.AUTH_DEV_BYPASS || config.AUTH_LOCALHOST_BYPASS)
    problems.push('Authentication bypasses must be disabled during RESTORE_REHEARSAL');
  if (config.OTEL_EXPORTER !== 'none')
    problems.push('OTEL_EXPORTER=none is required during RESTORE_REHEARSAL');
  return problems;
}

const FirestoreEmbeddingSpaceSchema = z.strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  dimensions: z.number().int().min(1).max(2048),
  revision: z.string().trim().min(1),
});

export function parseFirestoreEmbeddingSpace(value: string) {
  try {
    return Object.freeze(FirestoreEmbeddingSpaceSchema.parse(JSON.parse(value)));
  } catch {
    throw new Error('FIRESTORE_EMBEDDING_SPACE must be JSON {provider,model,dimensions,revision}');
  }
}

/**
 * Every setting name in the schema, including optional ones that are absent
 * from a parsed configuration. Modules declare the keys they own, and a
 * conformance test checks those declarations against this list.
 */
export const configKeyNames = Object.keys(ConfigSchema.shape) as readonly (keyof Config)[];

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!cached) {
    const parsed = ConfigSchema.parse(env);
    if (
      parsed.PERSISTENCE_DRIVER === 'firestore' &&
      env.NODE_ENV === 'production' &&
      !env.FIRESTORE_DATABASE_ID?.trim()
    )
      throw new Error('FIRESTORE_DATABASE_ID must be explicit in production Firestore mode');
    cached = parsed;
  }
  return cached;
}

/** Local validation only; model availability and service-account permissions need live checks. */
export function modelProviderConfigProblems(config: Config): string[] {
  const problems: string[] = [];
  if (config.LLM_PROVIDER !== 'vertex' && !config.OPENROUTER_API_KEY) {
    problems.push('OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter');
  }
  if (config.LLM_PROVIDER === 'vertex') {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.VERTEX_PROJECT))
      problems.push('VERTEX_PROJECT must identify the customer Google project');
    if (!/^(?:global|[a-z][a-z0-9-]*[0-9])$/.test(config.VERTEX_LOCATION))
      problems.push('VERTEX_LOCATION must be an explicit Vertex region or global');
  }
  return problems;
}

/**
 * Modules whose every runtime path — tools, jobs, callbacks, sweep steps,
 * ticks, and owner-notifier legs — runs on Firestore persistence. A module
 * joins only once each of its rows in docs/firestore-agent-runtime-inventory.md
 * is Ready.
 */
export const FIRESTORE_PORTABLE_MODULES: readonly AssistantModule[] = [
  'reminders',
  'calendar',
  'calls',
  'browser',
  'code',
  'search',
  'maps',
  'watches',
  'push',
  'sms',
  'documents',
  'google',
];

/**
 * Firestore agent mode's configuration guard. Every module is portable today;
 * the module check stays so a module added later without a port is refused
 * instead of silently reaching SQL.
 */
export function validateAgentPersistenceConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (config.PERSISTENCE_DRIVER !== 'firestore') return [];
  const problems: string[] = [];
  if (!config.GCP_PROJECT.trim()) problems.push('GCP_PROJECT is required in Firestore agent mode');
  if (env.NODE_ENV === 'production' && !env.FIRESTORE_DATABASE_ID?.trim())
    problems.push('FIRESTORE_DATABASE_ID must be explicit in production Firestore mode');
  if (!Object.hasOwn(env, 'ASSISTANT_WORKSPACE_ID') || !env.ASSISTANT_WORKSPACE_ID?.trim())
    problems.push('ASSISTANT_WORKSPACE_ID must be explicit in Firestore agent mode');
  if (!z.uuid().safeParse(config.FIRESTORE_AGENT_ID).success)
    problems.push('FIRESTORE_AGENT_ID must be an explicit UUID in Firestore agent mode');
  if (!config.FIRESTORE_EMBEDDING_SPACE.trim())
    problems.push(
      'FIRESTORE_EMBEDDING_SPACE is required as JSON {provider,model,dimensions,revision}',
    );
  else {
    try {
      parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE);
    } catch {
      problems.push('FIRESTORE_EMBEDDING_SPACE must be JSON {provider,model,dimensions,revision}');
    }
  }
  const unported = config.ASSISTANT_MODULES.filter(
    (module) => !FIRESTORE_PORTABLE_MODULES.includes(module),
  );
  if (unported.length)
    problems.push(
      `ASSISTANT_MODULES=${unported.join(',')} still needs PostgreSQL; Firestore agent mode supports ${FIRESTORE_PORTABLE_MODULES.join(',')}`,
    );
  // Cloud Tasks is supported: the scheduled /internal/sweep dispatches the
  // durable Firestore outbox. The shared-secret internal auth refuses
  // cloudtasks deployments on its own, so OIDC is required in practice.
  if (config.QUEUE_DRIVER === 'cloudtasks' && config.INTERNAL_AUTH_MODE !== 'oidc')
    problems.push('INTERNAL_AUTH_MODE=oidc is required for Firestore agent mode with Cloud Tasks');
  if (config.CANARY_ENABLED) problems.push('CANARY_ENABLED must be false in Firestore agent mode');
  if (config.VERTEX_MODEL_PROBE_ENABLED && config.LLM_PROVIDER !== 'vertex')
    problems.push('VERTEX_MODEL_PROBE_ENABLED requires LLM_PROVIDER=vertex');
  if (config.LOCATION_PING_SECRET)
    problems.push('LOCATION_PING_SECRET must be empty in Firestore agent mode');
  return problems;
}

/**
 * Fail loudly when a cloud-shaped installation would otherwise boot broken.
 * Local and intentionally minimal installations may run in a degraded state.
 *
 * This covers the platform's own settings only. Module-specific problems are
 * declared by each module and collected by `validateAssistantConfig` in
 * `@assistant/modules`, which is what apps and setup tooling should call.
 */
export function validateProdConfig(config: Config = loadConfig()): string[] {
  if (config.QUEUE_DRIVER !== 'cloudtasks') return [];
  const problems: string[] = [];
  if (!config.AGENT_URL) problems.push('AGENT_URL is required when QUEUE_DRIVER=cloudtasks');
  if (!config.GCP_PROJECT) problems.push('GCP_PROJECT is required when QUEUE_DRIVER=cloudtasks');
  if (!config.CLOUD_TASKS_QUEUE) problems.push('CLOUD_TASKS_QUEUE is required');
  if (config.INTERNAL_AUTH_MODE === 'oidc') {
    if (!config.INTERNAL_OIDC_AUDIENCE) {
      problems.push('INTERNAL_OIDC_AUDIENCE is required when INTERNAL_AUTH_MODE=oidc');
    }
    if (!config.INTERNAL_OIDC_SERVICE_ACCOUNT) {
      problems.push('INTERNAL_OIDC_SERVICE_ACCOUNT is required when INTERNAL_AUTH_MODE=oidc');
    }
  }
  problems.push(...modelProviderConfigProblems(config));
  if (config.PUBLIC_URL.includes('localhost')) {
    problems.push('PUBLIC_URL still points at localhost — set the public service URL for webhooks');
  }
  if (config.FILES_DRIVER === 'gcs' && !config.WORKSPACE_BUCKET) {
    problems.push('WORKSPACE_BUCKET is required when FILES_DRIVER=gcs');
  }
  return problems;
}

/**
 * The recipient domains the assistant may send to, lowercased. An empty list
 * means unrestricted — callers must treat it that way rather than as "deny
 * everything", so an installation that never sets this keeps working.
 */
export function outboundEmailDomains(config: Config = loadConfig()): readonly string[] {
  return config.EMAIL_OUTBOUND_DOMAINS.split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * May the assistant send mail to this address? Unrestricted when no domains are
 * configured. Subdomains do NOT inherit: `EMAIL_OUTBOUND_DOMAINS=example.com`
 * permits `a@example.com` and not `a@mail.example.com`, because the point is to
 * mirror a provider-side rule exactly rather than to guess at its intent.
 */
export function outboundEmailAllowed(address: string, config: Config = loadConfig()): boolean {
  const domains = outboundEmailDomains(config);
  if (domains.length === 0) return true;
  const domain = address.trim().toLowerCase().split('@').pop() ?? '';
  return domain.length > 0 && domains.includes(domain);
}

/**
 * Drop the process-level cache and re-parse — used by settings actions that
 * persist a new value (for example rotating the mobile token) and need the
 * running process to honour it without a restart.
 */
export function reloadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  cached = undefined;
  return loadConfig(env);
}

/** Test seam — clears the process-level config cache. */
export function resetConfigForTest(): void {
  cached = undefined;
}
