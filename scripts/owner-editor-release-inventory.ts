/** Protected, GET-only observations. Never authorizes traffic or maintenance. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  InventoryHttpError,
  InventoryLimitError,
  InventoryProcessError,
  type InventoryStage,
  type InventoryStageMarker,
  inventoryFailureDiagnostic,
  parseInventoryList,
} from './owner-editor-inventory-diagnostics.js';
import {
  encryptInventoryFailure,
  verifyFailureRecipient,
} from './owner-editor-inventory-failure-envelope.js';
import { compareIndexInventory } from './owner-editor-release-index-inventory.js';
import {
  createEditorMetadataRead,
  type EditorMetadataTarget,
  editorMetadataTarget,
  observeEditorReadiness,
} from './owner-editor-release-readiness.js';

export const PROJECT = 'bmson-assistant';
export const DATABASE = `projects/${PROJECT}/databases/assistant-production`;
export const REGION = 'us-west1';
export const SOURCE = '04c17b04ab9d76d005b04121927c189baa6edaf9';
export const MANIFEST_HASH = '5baaca10aa089b2eac771de7c9086317206bd937d09a89ea6e937ac945e03cd1';
const RUN_ROOT = `projects/${PROJECT}/locations/${REGION}`;
const LIMIT = 2 * 1024 * 1024;
const exec = promisify(execFile);
export type ReadJson = (url: string) => Promise<unknown>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid data');
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('invalid data');
  return value;
}
function instant(value: unknown, bound: 'floor' | 'ceil' = 'floor'): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value))
    throw new Error('invalid time');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error('invalid time');
  // Keep directional bounds explicit. Earliest coverage and future checks use
  // ceil; snapshot-age and expiry checks use floor. Preserve wire facts separately.
  const fraction = /\.([0-9]+)Z$/.exec(value)?.[1] ?? '';
  return time + (bound === 'ceil' && /[1-9]/.test(fraction.slice(3)) ? 1 : 0);
}
export function verifyManifest(bytes: Buffer): { groups: string[] } {
  if (hash(bytes) !== MANIFEST_HASH) throw new Error('manifest mismatch');
  const spec = record(JSON.parse(bytes.toString('utf8')));
  if (!Array.isArray(spec.indexes) || !Array.isArray(spec.fieldOverrides))
    throw new Error('invalid manifest');
  const groups = [
    ...new Set(
      [...spec.indexes, ...spec.fieldOverrides].map((x) =>
        text(record(x).collectionGroup, /^[A-Za-z][A-Za-z0-9_]{0,100}$/),
      ),
    ),
  ].sort();
  return { groups };
}
/** Preserve the wire-token bound without regex control-character literals. */
function isPageToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 2048 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  );
}
/** Exact target resources only; a validated immutable string is dispatched. */
export function allowedUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    throw new Error('invalid target');
  const firestore =
    url.hostname === 'firestore.googleapis.com' &&
    (url.pathname === `/v1/${DATABASE}` ||
      url.pathname === `/v1/projects/${PROJECT}/locations/${REGION}/backups` ||
      new RegExp(
        `^/v1/${DATABASE}/collectionGroups/(?:-|[A-Za-z][A-Za-z0-9_]{0,100})/indexes$`,
      ).test(url.pathname) ||
      new RegExp(`^/v1/${DATABASE}/collectionGroups/[A-Za-z][A-Za-z0-9_]{0,100}/fields$`).test(
        url.pathname,
      ));
  const run =
    url.hostname === 'run.googleapis.com' &&
    new RegExp(
      `^/v2/${RUN_ROOT}/services/assistant-(?:agent|web)(?:/revisions/assistant-(?:agent|web)-[a-z0-9-]{1,63})?$`,
    ).test(url.pathname);
  const keys = [...url.searchParams.keys()];
  if (
    (!firestore && !run) ||
    keys.some((k) => k !== 'pageSize' && k !== 'pageToken') ||
    new Set(keys).size !== keys.length
  )
    throw new Error('invalid target');
  if (url.search && !/(?:\/indexes|\/fields|\/backups)$/.test(url.pathname))
    throw new Error('invalid query');
  if (url.searchParams.has('pageSize') && url.searchParams.get('pageSize') !== '100')
    throw new Error('invalid page size');
  const token = url.searchParams.get('pageToken');
  if (token !== null && !isPageToken(token)) throw new Error('invalid page token');
  return url.href;
}
export function createReadOnlyGet(
  token: string,
  deadline: number,
  fetcher: typeof fetch = fetch,
): ReadJson {
  if (!/^[A-Za-z0-9._~-]{20,8192}$/.test(token)) throw new Error('invalid credential');
  let requests = 0;
  let total = 0;
  return async (input) => {
    const url = allowedUrl(input);
    const remaining = deadline - Date.now();
    if (remaining <= 0 || ++requests > 128) throw new Error('inventory bound');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(8000, remaining));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!response.ok) throw new InventoryHttpError(response.status);
      if (!response.body || Date.now() >= deadline) throw new Error('read unavailable');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (Date.now() >= deadline) throw new Error('inventory bound');
        if (next.done) break;
        size += next.value.byteLength;
        total += next.value.byteLength;
        if (size > LIMIT || total > 4 * LIMIT) throw new Error('inventory bound');
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Cancellation is best effort, never claimed as proof of server cancellation.
      void reader?.cancel().catch(() => undefined);
    }
  };
}
export async function listPages(read: ReadJson, resource: string, key: string): Promise<unknown[]> {
  const items: unknown[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 8; page++) {
    const url = new URL(resource);
    url.searchParams.set('pageSize', '100');
    if (token) url.searchParams.set('pageToken', token);
    const response = record(await read(allowedUrl(url.href)));
    if (Object.keys(response).some((k) => k !== key && k !== 'nextPageToken'))
      throw new Error('unknown page field');
    // ProtoJSON omits an empty repeated field.
    const rows = response[key] ?? [];
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid page');
    items.push(...rows);
    if (items.length > 800) throw new Error('inventory bound');
    if (response.nextPageToken === undefined || response.nextPageToken === '') return items;
    const nextToken = response.nextPageToken;
    if (!isPageToken(nextToken)) throw new Error('invalid page token');
    token = nextToken;
    if (tokens.has(token)) throw new Error('repeated page token');
    tokens.add(token);
  }
  throw new Error('inventory bound');
}
export function recoveryPoint(raw: unknown, backups: unknown[], now: number) {
  const db = record(raw);
  if (db.name !== DATABASE || db.locationId !== REGION) throw new Error('wrong database');
  const databaseUid = text(
    db.uid,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  if (db.pointInTimeRecoveryEnablement === 'POINT_IN_TIME_RECOVERY_ENABLED') {
    const earliestWire = text(
      db.earliestVersionTime,
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/,
    );
    const earliest = instant(earliestWire, 'ceil');
    const retention = text(db.versionRetentionPeriod, /^[1-9][0-9]{0,6}s$/);
    const seconds = Number(retention.slice(0, -1));
    if (seconds > 604800 || earliest > now || now - earliest > seconds * 1000 + 60000)
      throw new Error('invalid recovery coverage');
    const rounded = Math.floor(now / 60000) * 60000;
    const proposed = rounded >= earliest ? rounded : null;
    return {
      kind: 'pitr' as const,
      databaseUid,
      observedAt: new Date(now).toISOString(),
      earliestVersionTime: earliestWire,
      earliestComparisonUpperBound: new Date(earliest).toISOString(),
      retentionSeconds: seconds,
      operationCheckpoint: null,
      operationCheckpointQualified: false,
      proposedWholeMinuteSnapshot: proposed === null ? null : new Date(proposed).toISOString(),
      roundingMilliseconds: now - rounded,
      uncoveredWriteIntervalMilliseconds: proposed === null ? null : now - proposed,
      projectedSnapshotExpiry:
        proposed === null ? null : new Date(proposed + seconds * 1000).toISOString(),
      expiryGuaranteed: false,
      checkpointLimitation:
        proposed === null
          ? 'rounded_minute_outside_observed_coverage'
          : 'proposal_only_requires_accepted_recovery_procedure_and_fresh_coverage',
      restorationProven: false,
    };
  }
  const ready = backups
    .map(record)
    .filter((b) => b.database === DATABASE && b.state === 'READY')
    .map((b) => {
      if (
        text(
          b.databaseUid,
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        ) !== databaseUid
      )
        throw new Error('backup database incarnation mismatch');
      return {
        name: text(
          b.name,
          new RegExp(`^projects/${PROJECT}/locations/${REGION}/backups/[A-Za-z0-9_-]{1,128}$`),
        ),
        time: instant(b.snapshotTime, 'floor'),
        futureTime: instant(b.snapshotTime, 'ceil'),
        expiry: instant(b.expireTime, 'floor'),
        snapshotWire: text(b.snapshotTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/),
        expiryWire: text(b.expireTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/),
      };
    })
    .sort((a, b) => b.time - a.time);
  const best = ready[0];
  if (!best || best.futureTime > now || now - best.time > 26 * 3600000 || best.expiry <= now)
    throw new Error('recovery unavailable');
  return {
    kind: 'backup' as const,
    databaseUid,
    observedAt: new Date(now).toISOString(),
    name: best.name,
    operationCheckpointQualified: false,
    expiresAt: best.expiryWire,
    expiryComparisonLowerBound: new Date(best.expiry).toISOString(),
    checkpoint: best.snapshotWire,
    snapshotTime: best.snapshotWire,
    snapshotAgeComparisonLowerBound: new Date(best.time).toISOString(),
    snapshotFutureComparisonUpperBound: new Date(best.futureTime).toISOString(),
    uncoveredWriteIntervalSeconds: Math.ceil((now - best.time) / 1000),
    restorationProven: false,
  };
}
const allowedEnv = new Set([
  'PERSISTENCE_DRIVER',
  'FIRESTORE_DATABASE_ID',
  'ASSISTANT_RELEASE_SHA',
  'RELEASE_SHA',
  'ASSISTANT_RELEASE_API_CONTRACT',
  'ASSISTANT_RELEASE_SCHEMA_DRIVER',
  'ASSISTANT_RELEASE_SCHEMA_MIN',
  'ASSISTANT_RELEASE_SCHEMA_MAX',
  'ASSISTANT_RELEASE_SCHEMA_VERSION',
  'ASSISTANT_RELEASE_MANIFEST',
  'ASSISTANT_RELEASE_WRITES_PAUSED',
]);
/** Retain only immutable image/config hashes and explicit nonsecret release fields. */
export function serviceFacts(raw: unknown, service: 'agent' | 'web') {
  const value = record(raw);
  if (value.name !== `${RUN_ROOT}/services/assistant-${service}`) throw new Error('wrong service');
  const template = record(value.template);
  const account = text(
    template.serviceAccount,
    /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/,
  );
  if (!Array.isArray(template.containers) || template.containers.length !== 1)
    throw new Error('ambiguous containers');
  const container = record(template.containers[0]);
  const image = text(
    container.image,
    new RegExp(
      `^${REGION}-docker\\.pkg\\.dev/${PROJECT}/assistant/${service}@sha256:[a-f0-9]{64}$`,
    ),
  );
  const env: Record<string, string> = {};
  if (container.env !== undefined && !Array.isArray(container.env))
    throw new Error('invalid config');
  for (const rawEnv of (container.env ?? []) as unknown[]) {
    const entry = record(rawEnv);
    if (typeof entry.name !== 'string') throw new Error('invalid config');
    if (!allowedEnv.has(entry.name)) continue;
    if (
      entry.valueSource !== undefined ||
      entry.valueFrom !== undefined ||
      typeof entry.value !== 'string' ||
      entry.value.length > 128 ||
      /[^a-zA-Z0-9_.:-]/.test(entry.value) ||
      entry.name in env
    )
      throw new Error('invalid config');
    env[entry.name] = entry.value;
  }
  if (
    env.PERSISTENCE_DRIVER !== 'firestore' ||
    env.FIRESTORE_DATABASE_ID !== 'assistant-production' ||
    env.ASSISTANT_RELEASE_SCHEMA_DRIVER !== 'firestore' ||
    env.ASSISTANT_RELEASE_SCHEMA_MIN !== '1' ||
    env.ASSISTANT_RELEASE_SCHEMA_MAX !== '1' ||
    env.ASSISTANT_RELEASE_API_CONTRACT !== '1'
  )
    throw new Error('wrong persistence');
  if (!Array.isArray(value.trafficStatuses) || value.trafficStatuses.length !== 1)
    throw new Error('ambiguous traffic');
  const traffic = record(value.trafficStatuses[0]);
  const revision = text(traffic.revision, new RegExp(`^assistant-${service}-[a-z0-9-]{1,63}$`));
  if (traffic.percent !== 100 || (value.reconciling !== undefined && value.reconciling !== false))
    throw new Error('unsettled service');
  return {
    service,
    image,
    account,
    revision,
    nonsecretReleaseConfig: env,
    observedTemplateHash: hash(JSON.stringify(template)),
    servingRevisionVerified: false as const,
    // Private intermediate; removed before serializing the sanitized receipt.
    editorMetadataTarget: editorMetadataTarget(raw),
  };
}
export interface GlobalIndexLists {
  composites: unknown[];
  fields: unknown[];
  evidence: 'pinned-gcloud-576-complete-lists';
}
export async function collectInventory(
  read: ReadJson,
  manifest: Buffer,
  now = Date.now(),
  global?: GlobalIndexLists,
  observeEditor?: (target: EditorMetadataTarget) => Promise<unknown>,
  mark: InventoryStageMarker = () => undefined,
) {
  mark('source_manifest');
  const { groups } = verifyManifest(manifest);
  mark('index_comparison');
  const composites =
    global?.composites ??
    (await listPages(
      read,
      `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
      'indexes',
    ));
  const fields: unknown[] = global?.fields ?? [];
  if (!global)
    for (const group of groups)
      fields.push(
        ...(await listPages(
          read,
          `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/${group}/fields`,
          'fields',
        )),
      );
  // REST scope cannot prove global coverage. The production path uses the audited,
  // version-pinned CLI global commands with no filters/limit added by this script.
  const complete = global?.evidence === 'pinned-gcloud-576-complete-lists';
  mark('index_comparison');
  const indexes = await compareIndexInventory(manifest, composites, fields, {
    compositesComplete: true,
    fieldsComplete: complete,
  });
  mark('database_metadata');
  const database = record(await read(`https://firestore.googleapis.com/v1/${DATABASE}`));
  mark('recovery_metadata');
  const backups =
    database.pointInTimeRecoveryEnablement === 'POINT_IN_TIME_RECOVERY_ENABLED'
      ? []
      : await listPages(
          read,
          `https://firestore.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/backups`,
          'backups',
        );
  const point = recoveryPoint(database, backups, now);
  const services = [];
  const editorTargets: (EditorMetadataTarget | null)[] = [];
  for (const service of ['agent', 'web'] as const) {
    mark(service === 'agent' ? 'agent_service' : 'web_service');
    const facts = serviceFacts(
      await read(`https://run.googleapis.com/v2/${RUN_ROOT}/services/assistant-${service}`),
      service,
    );
    mark(service === 'agent' ? 'agent_revision' : 'web_revision');
    const revision = record(
      await read(
        `https://run.googleapis.com/v2/${RUN_ROOT}/services/assistant-${service}/revisions/${facts.revision}`,
      ),
    );
    if (
      revision.name !== `${RUN_ROOT}/services/assistant-${service}/revisions/${facts.revision}` ||
      !Array.isArray(revision.containers) ||
      revision.containers.length !== 1 ||
      record(revision.containers[0]).image !== facts.image ||
      revision.serviceAccount !== facts.account
    )
      throw new Error('serving revision mismatch');
    const revisionFacts = serviceFacts(
      {
        name: `${RUN_ROOT}/services/assistant-${service}`,
        template: { serviceAccount: revision.serviceAccount, containers: revision.containers },
        trafficStatuses: [{ revision: facts.revision, percent: 100 }],
      },
      service,
    );
    const sorted = (config: Record<string, string>) =>
      JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
    if (sorted(revisionFacts.nonsecretReleaseConfig) !== sorted(facts.nonsecretReleaseConfig))
      throw new Error('serving config mismatch');
    if (
      JSON.stringify(revisionFacts.editorMetadataTarget) !==
      JSON.stringify(facts.editorMetadataTarget)
    )
      throw new Error('serving editor target mismatch');
    editorTargets.push(facts.editorMetadataTarget);
    const { editorMetadataTarget: _privateTarget, ...publicFacts } = facts;
    services.push({
      ...publicFacts,
      servingRevisionVerified: true,
      observedRevisionHash: hash(JSON.stringify(revision)),
    });
  }
  mark('editor_metadata');
  const firstTarget = editorTargets[0];
  const editorReadiness =
    firstTarget &&
    editorTargets.length === 2 &&
    JSON.stringify(firstTarget) === JSON.stringify(editorTargets[1]) &&
    observeEditor
      ? await observeEditor(firstTarget)
      : { status: 'unknown', reason: 'editor_target_unbound_or_not_collected' };
  return {
    format: 1,
    candidateSource: SOURCE,
    manifestSha256: MANIFEST_HASH,
    target: DATABASE,
    observedAt: new Date(now).toISOString(),
    indexes,
    recoveryPoint: point,
    services,
    editorReadiness,
    mutationAuthorized: false,
    trafficAuthorized: false,
    maintenanceAuthorized: false,
    recoveryPairQualified: false,
    limitations: [
      global
        ? 'Index equality is scoped to the pinned CLI custom-index inventory; it is not permission to deploy and does not inventory TTL-only inherited fields.'
        : 'Global field inventory is unsupported for this REST-only path; manifest-group listing is scoped only.',
      'Serving revision image and account matched the service template; signed-image source and retained recovery configuration remain unqualified.',
      'No guarded recovery digests or accepted recovery procedure are supplied.',
      'PITR or backup presence does not prove a restore.',
      'No caller provenance or runtime source provenance is proved.',
    ],
  };
}
export function verifyPreAuthEnvironment(env: NodeJS.ProcessEnv) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'bmson/assistant' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_RUN_ATTEMPT !== '1' ||
    env.GCP_PROJECT !== PROJECT
  )
    throw new Error('untrusted context');
  text(
    env.GCP_DEPLOY_SERVICE_ACCOUNT,
    /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/,
  );
  text(
    env.GCP_WORKLOAD_IDENTITY_PROVIDER,
    /^projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-zA-Z0-9_-]+\/providers\/[a-zA-Z0-9_-]+$/,
  );
  text(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  text(env.GITHUB_RUN_ID, /^[1-9][0-9]{0,19}$/);
}
/** Reject local/default credentials. Only the explicit protected WIF action file is accepted. */
export function verifyWifEnvironment(env: NodeJS.ProcessEnv, load: (path: string) => unknown) {
  verifyPreAuthEnvironment(env);
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'bmson/assistant' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_RUN_ATTEMPT !== '1'
  )
    throw new Error('untrusted context');
  if (env.GCP_PROJECT !== PROJECT || !env.GITHUB_WORKSPACE || !env.RUNNER_TEMP)
    throw new Error('wrong target');
  const principal = text(
    env.GCP_DEPLOY_SERVICE_ACCOUNT,
    /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/,
  );
  const provider = text(
    env.GCP_WORKLOAD_IDENTITY_PROVIDER,
    /^projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-zA-Z0-9_-]+\/providers\/[a-zA-Z0-9_-]+$/,
  );
  const file = resolve(text(env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, /^\/.+/));
  if (
    dirname(file) !== resolve(env.GITHUB_WORKSPACE) ||
    !/^gha-creds-[a-zA-Z0-9_-]+\.json$/.test(file.split('/').at(-1) ?? '') ||
    env.GOOGLE_APPLICATION_CREDENTIALS !== file
  )
    throw new Error('untrusted credentials');
  const credential = record(load(file));
  if (
    credential.type !== 'external_account' ||
    credential.audience !== `//iam.googleapis.com/${provider}` ||
    credential.token_url !== 'https://sts.googleapis.com/v1/token' ||
    credential.service_account_impersonation_url !==
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${principal}:generateAccessToken`
  )
    throw new Error('untrusted credentials');
  return { principal, file, provider };
}
export const BASIC_EDITOR_COMMANDS = [
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
] as const;
/** Source declaration, not an operator flag. A present runtime cannot omit its gate. */
export function requiresBasicEditorPreflight(contract: unknown, runtimePresent: boolean): boolean {
  const web = record(record(record(contract).components).web);
  const capability = web.ownerEditorV1;
  if (capability === undefined && !runtimePresent) return false;
  if (
    !runtimePresent ||
    !Array.isArray(capability) ||
    JSON.stringify([...capability].sort()) !== JSON.stringify([...BASIC_EDITOR_COMMANDS].sort())
  )
    throw new Error('basic editor capability declaration mismatch');
  return true;
}
/** A positive observation is only one release prerequisite, never mutation authority. */
export function requireBasicEditorReadiness(receipt: unknown): void {
  const value = record(receipt),
    indexes = record(value.indexes),
    editor = record(value.editorReadiness);
  if (
    indexes.status !== 'exact_manifest_parity' ||
    editor.status !== 'ready' ||
    editor.epochReady !== true ||
    editor.ownerMatched !== true ||
    editor.privacyBound !== true ||
    editor.observationStable !== true ||
    editor.consistentSnapshot !== false ||
    !Array.isArray(value.services) ||
    value.services.length !== 2 ||
    !value.services.every((service) => record(service).servingRevisionVerified === true) ||
    !['pitr', 'backup'].includes(String(record(value.recoveryPoint).kind))
  )
    throw new Error('basic editor release prerequisites unproven');
}
async function main(mark: InventoryStageMarker) {
  mark('arguments');
  const mode = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !['--verify-source', '--collect', '--release-preflight'].includes(mode ?? '')
  )
    throw new Error('invalid arguments');
  const releasePreflight = mode === '--release-preflight';
  mark('source_capability');
  if (
    releasePreflight &&
    !requiresBasicEditorPreflight(
      JSON.parse(readFileSync('infra/gcp/release-contracts.json', 'utf8')),
      existsSync('apps/web/lib/owner-editor-runtime.ts'),
    )
  )
    return;
  mark('source_manifest');
  const manifest = readFileSync(
    releasePreflight
      ? 'infra/gcp/firestore/firestore.indexes.json'
      : '.approved-index-source/infra/gcp/firestore/firestore.indexes.json',
  );
  verifyManifest(manifest);
  mark('protected_context');
  verifyPreAuthEnvironment(process.env);
  const diagnosticRecipient = verifyFailureRecipient(process.env);
  if (mode === '--verify-source') return;
  const started = Date.now();
  mark('credential_file');
  const identity = verifyWifEnvironment(process.env, (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
      throw new Error('invalid credential file');
    return JSON.parse(readFileSync(file, 'utf8'));
  });
  mark('cli_context');
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error('invalid context');
  const cloudConfig = resolve(runnerTemp, 'owner-editor-inventory-gcloud');
  if (relative(resolve(runnerTemp), cloudConfig).startsWith('..'))
    throw new Error('invalid context');
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLOUDSDK_CONFIG: cloudConfig,
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: identity.file,
    CLOUDSDK_CORE_PROJECT: PROJECT,
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
  };
  let retainedBytes = 0;
  const command = async (args: readonly string[], maxBuffer = LIMIT / 2) => {
    const remaining = started + 60000 - Date.now();
    if (remaining <= 0) throw new InventoryLimitError('time_bound');
    const result = await exec('gcloud', [...args], {
      timeout: Math.min(8000, remaining),
      maxBuffer,
      env: childEnv,
      killSignal: 'SIGKILL',
    }).catch((error: unknown) => {
      if (
        diagnosticRecipient &&
        args.slice(0, 4).join(' ') === 'firestore indexes composite list'
      ) {
        writeFileSync(
          'owner-editor-inventory-failure.encrypted.json',
          `${JSON.stringify(encryptInventoryFailure(error, diagnosticRecipient, { sourceSha: process.env.GITHUB_SHA ?? '', runId: process.env.GITHUB_RUN_ID ?? '' }))}\n`,
          { flag: 'wx', mode: 0o600 },
        );
      }
      throw new InventoryProcessError(error);
    });
    retainedBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (retainedBytes > 4 * LIMIT) throw new InventoryLimitError('output_bound');
    return result.stdout;
  };
  mark('cli_version');
  const version = record(JSON.parse(await command(['version', '--format=json'], 32768)));
  if (version['Google Cloud SDK'] !== '576.0.0') throw new Error('unaudited CLI');
  const lists: unknown[][] = [];
  for (const kind of ['composite', 'fields']) {
    mark(kind === 'composite' ? 'cli_composites' : 'cli_fields');
    const value = parseInventoryList(
      await command([
        'firestore',
        'indexes',
        kind,
        'list',
        `--project=${PROJECT}`,
        '--database=assistant-production',
        '--format=json',
        '--page-size=100',
        '--quiet',
      ]),
    );
    lists.push(value);
  }
  mark('access_token');
  const token = await command(['auth', 'print-access-token', '--quiet'], 16384);
  const receipt = await collectInventory(
    createReadOnlyGet(token.trim(), started + 60000),
    manifest,
    Date.now(),
    {
      composites: lists[0] ?? [],
      fields: lists[1] ?? [],
      evidence: 'pinned-gcloud-576-complete-lists',
    },
    (target) =>
      observeEditorReadiness(
        createEditorMetadataRead(token.trim(), started + 60000, target),
        target,
      ),
    mark,
  );
  mark('receipt_serialization');
  const output = JSON.stringify({
    ...receipt,
    observationIdentity: {
      principal: identity.principal,
      provider: identity.provider,
      binding: 'explicit-protected-workflow-WIF-config; not independent caller proof',
    },
    workflowSource: process.env.GITHUB_SHA,
    workflowRun: process.env.GITHUB_RUN_ID,
  });
  if (Buffer.byteLength(output) > 65536) throw new Error('receipt bound');
  mark('receipt_write');
  writeFileSync('owner-editor-release-inventory.json', `${output}\n`, { flag: 'wx', mode: 0o600 });
  if (releasePreflight) {
    mark('release_readiness');
    requireBasicEditorReadiness(receipt);
  }
}
if (process.argv[1]?.endsWith('/owner-editor-release-inventory.ts')) {
  let stage: InventoryStage = 'arguments';
  main((current) => {
    stage = current;
  }).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(inventoryFailureDiagnostic(stage, error))}\n`);
    process.exitCode = 1;
  });
}
