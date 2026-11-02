/** Default-off hosted READ-ONLY qualification. No release/journal/traffic writer is imported. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyNativeQualificationJwt } from '../apps/agent/scripts/verify-native-web-qualification-jwt.js';
import { simulateOriginBinding } from './owner-web-release-journal-model.js';
import {
  type QualificationClock,
  QualificationHold,
  qualificationBudget,
  qualificationRequire,
  type ReadOnlyRequest,
} from './owner-web-release-qualification-budget.js';
import {
  QUALIFICATION_MANIFEST as PIN,
  verifyQualificationManifest,
} from './owner-web-release-qualification-manifest.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';
import { planWebTrafficReconciliation } from './owner-web-traffic-reconciliation-model.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => {
  qualificationRequire(v && typeof v === 'object' && !Array.isArray(v));
  return v as Obj;
};
const string = (v: unknown, re: RegExp): string => {
  qualificationRequire(typeof v === 'string' && re.test(v), 'context');
  return v;
};
const API = 'https://api.github.com/repos/bmson/assistant',
  ISSUER = 'https://token.actions.githubusercontent.com',
  DISCOVERY = `${ISSUER}/.well-known/openid-configuration`,
  JWKS = `${ISSUER}/.well-known/jwks`,
  JOURNAL_AUD = 'assistant-web-journal-v1',
  STS = 'https://sts.googleapis.com/v1/token';
export const QUALIFICATION_WORKFLOWS = [
  'deploy.yml',
  'cleanup.yml',
  'owner-web-tag-retirement.yml',
  'owner-editor-v1-maintenance.yml',
  'prepare-owner-editor-index.yml',
  'workspace-import.yml',
  'workspace-export.yml',
  'owner-editor-release-inventory.yml',
].map((n) => `.github/workflows/${n}`);
const NON_OPERATIVE = ['ci.yml', 'self-repair.yml', 'ios.yml', 'agent-image-pr-smoke.yml'].map(
    (n) => `.github/workflows/${n}`,
  ),
  STATUSES = ['in_progress', 'queued', 'waiting', 'pending', 'requested'];
export function qualificationContext(env: NodeJS.ProcessEnv, head: string) {
  qualificationRequire(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === 'bmson/assistant' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      env.GITHUB_WORKFLOW_REF === 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main' &&
      env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA &&
      env.OWNER_NATIVE_WEB_QUALIFICATION === 'read_only' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      env.RUNNER_OS === 'Linux' &&
      env.RUNNER_ARCH === 'X64' &&
      env.RUNNER_TEMP === '/home/runner/work/_temp',
    'context',
  );
  const source = string(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  qualificationRequire(
    head === source &&
      (!env.QUALIFICATION_REQUESTED_SHA || env.QUALIFICATION_REQUESTED_SHA === source) &&
      env.QUALIFICATION_BREAK_GLASS !== 'true',
    'context',
  );
  qualificationRequire(
    env.GCP_PROJECT === 'bmson-assistant' &&
      env.GCP_REGION === 'us-west1' &&
      env.ARTIFACT_REPOSITORY === 'assistant',
    'context',
  );
  const runId = string(env.GITHUB_RUN_ID, /^[1-9][0-9]{0,19}$/),
    provider = string(
      env.GCP_WORKLOAD_IDENTITY_PROVIDER,
      /^projects\/[1-9][0-9]{0,19}\/locations\/global\/workloadIdentityPools\/[a-z0-9_-]{1,63}\/providers\/[a-z0-9_-]{1,63}$/,
    ),
    principal = string(
      env.GCP_DEPLOY_SERVICE_ACCOUNT,
      /^[a-z][a-z0-9-]{4,62}@bmson-assistant\.iam\.gserviceaccount\.com$/,
    );
  const base = new URL(string(env.ACTIONS_ID_TOKEN_REQUEST_URL, /^https:\/\/[^\s]{1,4096}$/));
  qualificationRequire(
    /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(base.hostname) &&
      !base.username &&
      !base.password &&
      !base.port &&
      !base.hash,
    'context',
  );
  const providerAud = `https://iam.googleapis.com/${provider}`,
    tokenUrls = [JOURNAL_AUD, providerAud].map((aud) => {
      const u = new URL(base);
      u.searchParams.set('audience', aud);
      return u.href;
    });
  return {
    source,
    runId,
    provider,
    principal,
    providerAud,
    tokenUrls,
    oidcRequestToken: string(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, /^[A-Za-z0-9._~-]{1,16384}$/),
    githubToken: string(env.GH_TOKEN, /^[A-Za-z0-9_]{1,4096}$/),
  };
}
export interface QualificationDependencies extends QualificationClock {
  request: typeof fetch;
  head: () => string;
}
export type QualificationReport = {
  format: 1;
  status: 'HOLD';
  mutationAuthorized: false;
  runtimeEligible: false;
  coldContinuationAuthorized: false;
  requestedSource?: string;
  verifiedOrigin?: { source: string; runId: string; jobId: string; checkRunId: string };
  checks: Record<string, unknown>;
  reason: QualificationHold['reason'];
  budget?: ReturnType<ReturnType<typeof qualificationBudget>['summary']>;
};
export async function qualifyNativeWebReadOnly(
  env: NodeJS.ProcessEnv,
  deps: QualificationDependencies,
): Promise<QualificationReport> {
  const report: QualificationReport = {
    format: 1,
    status: 'HOLD',
    mutationAuthorized: false,
    runtimeEligible: false,
    coldContinuationAuthorized: false,
    checks: {},
    reason: 'context',
  };
  let budget: ReturnType<typeof qualificationBudget> | undefined;
  try {
    const c = qualificationContext(env, deps.head());
    report.requestedSource = c.source;
    const githubPaths = new Set([
        `${API}/actions/runs/${c.runId}`,
        `${API}/actions/runs/${c.runId}/attempts/1/jobs?per_page=100&page=1`,
        `${API}/actions/runs/${PIN.runId}/attempts/1`,
        `${API}/actions/artifacts/${PIN.id}`,
        `${API}/actions/artifacts/${PIN.id}/zip`,
        ...STATUSES.map((status) => `${API}/actions/runs?per_page=100&page=1&status=${status}`),
      ]),
      nativePaths = new Set([
        `https://run.googleapis.com/v2/${WEB_SERVICE}`,
        ...HISTORICAL_WEB_TAGS.map(
          (p) => `https://run.googleapis.com/v2/${WEB_SERVICE}/revisions/${p.revision}`,
        ),
      ]),
      iam = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${c.principal}:generateAccessToken`;
    const allowed = (r: ReadOnlyRequest) => {
      if (r.kind === 'sts') return r.method === 'POST' && r.url === STS;
      if (r.kind === 'iam') return r.method === 'POST' && r.url === iam;
      if (r.method !== 'GET') return false;
      if (r.kind === 'oidc') return c.tokenUrls.includes(r.url);
      if (r.kind === 'discovery') return r.url === DISCOVERY;
      if (r.kind === 'jwks') return r.url === JWKS;
      if (r.kind === 'github') return githubPaths.has(r.url);
      if (r.kind === 'native') return nativePaths.has(r.url);
      if (r.kind === 'blob') {
        const u = new URL(r.url);
        return (
          /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(u.hostname) &&
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          !u.port &&
          !u.hash &&
          r.url.length <= 8192 &&
          r.headers === undefined
        );
      }
      return false;
    };
    budget = qualificationBudget(deps.request, deps, allowed);
    const b = budget;
    const gh = (url: string, manualRedirect = false) => ({
      kind: 'github' as const,
      url,
      method: 'GET' as const,
      headers: {
        Authorization: `Bearer ${c.githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      manualRedirect,
    });
    const oidc = async (index: number) => {
      const response = obj(
        (
          await b.json({
            kind: 'oidc',
            url: c.tokenUrls[index] as string,
            method: 'GET',
            headers: { Authorization: `Bearer ${c.oidcRequestToken}` },
          })
        ).value,
      );
      return string(response.value, /^[A-Za-z0-9_.-]{1,16384}$/);
    };
    report.reason = 'identity';
    const journalJwt = await oidc(0),
      configuration = obj(
        (await b.json({ kind: 'discovery', url: DISCOVERY, method: 'GET' })).value,
      );
    qualificationRequire(
      configuration.issuer === ISSUER && configuration.jwks_uri === JWKS,
      'identity',
    );
    const jwks = (await b.json({ kind: 'jwks', url: JWKS, method: 'GET' })).value,
      journalClaims = await verifyNativeQualificationJwt(journalJwt, jwks, JOURNAL_AUD, deps.now());
    const run = obj((await b.json(gh(`${API}/actions/runs/${c.runId}`))).value),
      jobsResponse = await b.json(
        gh(`${API}/actions/runs/${c.runId}/attempts/1/jobs?per_page=100&page=1`),
      ),
      jobs = obj(jobsResponse.value);
    qualificationRequire(
      Array.isArray(jobs.jobs) &&
        jobs.jobs.length <= 100 &&
        jobs.total_count === jobs.jobs.length &&
        !jobsResponse.headers.get('link')?.includes('rel="next"'),
      'metadata',
    );
    const matches = jobs.jobs
      .map(obj)
      .filter(
        (j) =>
          j.check_run_url ===
          `https://api.github.com/repos/bmson/assistant/check-runs/${journalClaims.check_run_id}`,
      );
    qualificationRequire(matches.length === 1, 'identity');
    const origin = simulateOriginBinding(journalClaims, run, matches[0] as Obj, deps.now());
    qualificationRequire(
      origin.source === c.source &&
        origin.runId === c.runId &&
        jobs.jobs
          .map(obj)
          .every(
            (j) =>
              j.id === matches[0]?.id || (j.status === 'completed' && j.conclusion === 'skipped'),
          ),
      'identity',
    );
    report.verifiedOrigin = {
      source: origin.source,
      runId: origin.runId,
      jobId: origin.jobId,
      checkRunId: origin.checkRunId,
    };
    report.checks.identity = 'observed';
    const providerJwt = await oidc(1),
      providerClaims = await verifyNativeQualificationJwt(
        providerJwt,
        jwks,
        c.providerAud,
        deps.now(),
      );
    for (const key of [
      'sha',
      'repository',
      'workflow_ref',
      'event_name',
      'workflow_sha',
      'repository_id',
      'repository_owner_id',
      'run_id',
      'run_attempt',
      'check_run_id',
      'environment',
      'ref',
    ])
      qualificationRequire(providerClaims[key] === journalClaims[key], 'identity');
    report.reason = 'artifact';
    const oldRun = obj((await b.json(gh(`${API}/actions/runs/${PIN.runId}/attempts/1`))).value);
    qualificationRequire(
      oldRun.id === PIN.runId &&
        oldRun.run_attempt === 1 &&
        oldRun.head_sha === PIN.source &&
        oldRun.path === '.github/workflows/deploy.yml' &&
        obj(oldRun.repository).id === 1304152266 &&
        obj(oldRun.head_repository).id === 1304152266 &&
        oldRun.status === 'completed',
      'artifact',
    );
    const artifact = obj((await b.json(gh(`${API}/actions/artifacts/${PIN.id}`))).value);
    qualificationRequire(
      artifact.id === PIN.id &&
        artifact.name === PIN.name &&
        artifact.expired === false &&
        artifact.size_in_bytes === PIN.bytes &&
        artifact.digest === `sha256:${PIN.archiveSha256}` &&
        obj(artifact.workflow_run).id === PIN.runId &&
        obj(artifact.workflow_run).head_sha === PIN.source,
      'artifact',
    );
    const redirect = await b.bytes(gh(`${API}/actions/artifacts/${PIN.id}/zip`, true), 1),
      location = string(redirect.headers.get('location'), /^https:\/\/[^\s]{1,8192}$/),
      archive = await b.bytes({ kind: 'blob', url: location, method: 'GET' }, 4 * 1024 * 1024);
    report.checks.manifestAccess = verifyQualificationManifest(archive.bytes);
    report.reason = 'inventory';
    let observed = 0;
    for (const status of STATUSES) {
      const response = await b.json(gh(`${API}/actions/runs?per_page=100&page=1&status=${status}`)),
        list = obj(response.value);
      qualificationRequire(
        Array.isArray(list.workflow_runs) &&
          list.workflow_runs.length <= 100 &&
          list.total_count === list.workflow_runs.length &&
          !response.headers.get('link')?.includes('rel="next"'),
        'inventory',
      );
      for (const value of list.workflow_runs) {
        const row = obj(value);
        qualificationRequire(
          typeof row.id === 'number' &&
            Number.isSafeInteger(row.id) &&
            typeof row.path === 'string' &&
            row.status === status &&
            typeof row.head_sha === 'string' &&
            /^[a-f0-9]{40}$/.test(row.head_sha),
          'inventory',
        );
        if (String(row.id) === c.runId) {
          qualificationRequire(
            row.path === '.github/workflows/deploy.yml' && row.head_sha === c.source,
            'inventory',
          );
          continue;
        }
        if (QUALIFICATION_WORKFLOWS.includes(row.path)) {
          report.checks.blockedWorkflow = row.path;
          throw new QualificationHold('inventory');
        }
        qualificationRequire(NON_OPERATIVE.includes(row.path), 'inventory');
        observed++;
      }
    }
    report.checks.operativeRuns = 'none_observed_in_bounded_nonatomic_queries';
    report.checks.nonOperativeObserved = observed;
    report.checks.quiescence = 'UNKNOWN_not_process_or_credential_expiry_proof';
    report.reason = 'identity';
    const federated = obj(
      (
        await b.json({
          kind: 'sts',
          url: STS,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audience: `//iam.googleapis.com/${c.provider}`,
            grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
            requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
            scope: 'https://www.googleapis.com/auth/cloud-platform',
            subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
            subjectToken: providerJwt,
          }),
        })
      ).value,
    );
    qualificationRequire(
      federated.token_type === 'Bearer' &&
        federated.issued_token_type === 'urn:ietf:params:oauth:token-type:access_token' &&
        typeof federated.expires_in === 'number' &&
        federated.expires_in > 0 &&
        federated.expires_in <= 3600,
      'identity',
    );
    const federatedToken = string(federated.access_token, /^[A-Za-z0-9._~-]{1,16384}$/),
      access = obj(
        (
          await b.json({
            kind: 'iam',
            url: iam,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${federatedToken}`,
            },
            body: JSON.stringify({
              scope: ['https://www.googleapis.com/auth/cloud-platform'],
              lifetime: '600s',
            }),
          })
        ).value,
      ),
      token = string(access.accessToken, /^[A-Za-z0-9._~-]{1,16384}$/),
      expire = Date.parse(string(access.expireTime, /^[0-9T:.Z-]{20,30}$/));
    qualificationRequire(expire > deps.now() && expire - deps.now() <= 610000, 'identity');
    report.reason = 'native';
    const nativeGet = async (path: string) =>
        obj(
          (
            await b.json(
              {
                kind: 'native',
                url: `https://run.googleapis.com/v2/${path}`,
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` },
              },
              2 * 1024 * 1024,
            )
          ).value,
        ),
      service = await nativeGet(WEB_SERVICE);
    qualificationRequire(service.name === WEB_SERVICE, 'native');
    const annotations = service.annotations === undefined ? {} : obj(service.annotations);
    qualificationRequire(
      Object.values(annotations).every((v) => typeof v === 'string') &&
        Buffer.byteLength(JSON.stringify(annotations)) <= 65536 &&
        !Object.hasOwn(annotations, 'assistant.release/journal-v1'),
      'native',
    );
    const revisions: Record<string, unknown> = {};
    for (const p of HISTORICAL_WEB_TAGS)
      revisions[p.revision] = await nativeGet(`${WEB_SERVICE}/revisions/${p.revision}`);
    const packet = planWebTrafficReconciliation(
      service,
      revisions,
      c.source,
      new Date(deps.now()).toISOString(),
    );
    b.assertWithin();
    report.checks.native = {
      serviceUid: packet.before.uid,
      etag: packet.before.etag,
      generation: packet.before.generation,
      desiredRows: packet.before.desired.length,
      observedRows: packet.before.observed.length,
      knownMismatch: true,
      head: 'absent',
      templateSha256: packet.before.templateSha256,
      configurationSha256: packet.before.configurationSha256,
      rootUriSha256: packet.before.rootUriSha256,
    };
    report.reason = 'quiescence';
    report.checks.remainingGates = [
      'quiescence_and_old_writer_lifetime',
      'genesis_anchor',
      'metadata_semantics',
      'cold_recovery_disabled',
      'manager_same_job_approval_channel',
    ];
  } catch (e) {
    if (e instanceof QualificationHold) report.reason = e.reason;
    report.checks.stopped = true;
  } finally {
    if (budget) report.budget = budget.summary();
  }
  return report;
}
function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only') {
    process.exitCode = 2;
    return;
  }
  const env = process.env;
  void qualifyNativeWebReadOnly(env, {
    request: fetch,
    now: Date.now,
    monotonic: () => performance.now(),
    head: () =>
      execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
        cwd: env.GITHUB_WORKSPACE,
        env: { PATH: '/usr/bin:/bin' },
        timeout: 5000,
        maxBuffer: 128,
        encoding: 'utf8',
      }).trim(),
  })
    .then((report) => {
      if (env.RUNNER_TEMP !== '/home/runner/work/_temp')
        throw new Error('Qualification output held');
      writeFileSync(
        resolve(env.RUNNER_TEMP, 'owner-web-release-qualification.json'),
        `${JSON.stringify(report)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      process.exitCode = 2;
    })
    .catch(() => {
      process.exitCode = 2;
    });
}
if (process.argv[1]?.endsWith('/owner-web-release-qualification.ts')) main();
