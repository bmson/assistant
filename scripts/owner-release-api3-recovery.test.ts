import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimatedCostReleaseEnvironment } from '../infra/gcp/estimated-cost-release-config.mjs';
import {
  planApi3ForwardRecovery,
  reconcileApi3ForwardRecovery,
  verifyRestoreCheckpointPair,
} from './owner-release-api3-recovery.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  verifyCurrentSnapshot,
} from './owner-release-current-snapshot.js';
import { pairedWebContext } from './owner-web-release-native-controller.js';
import { projectNativeWebSnapshot } from './owner-web-release-native-proof.js';
import { tagHash } from './owner-web-tag-retirement.js';

const roles = ['web', 'agent'] as const;
type Role = (typeof roles)[number];
type Review = Parameters<typeof planApi3ForwardRecovery>[0];
const source = 'a'.repeat(40),
  resumeSource = 'b'.repeat(40),
  oldSource = 'c'.repeat(40);
const oldManifest = 'e'.repeat(64),
  evidence = 'f'.repeat(64);
const agentUri = 'https://assistant-agent-fixture-uw.a.run.app';
const ownerId = '11111111-1111-4111-8111-111111111111',
  installationId = 'fixture-installation';
const runId = '12345';
const costProfile: Review['costProfile'] = {
  format: 1,
  mode: 'compatible-off',
  source,
  projectId: 'bmson-assistant',
  installationId,
  ownerId,
  providerSecret: 'openrouter',
  providerVersion: '31',
  reviewedAt: '2026-11-18T16:00:00.000Z',
  expiresAt: '2026-11-18T16:30:00.000Z',
};
const allocation = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
const automaticScaling = { scalingMode: 'AUTOMATIC', maxInstanceCount: 12 };
const manual = { scalingMode: 'MANUAL', manualInstanceCount: 0 };
const phase = (role: Role, kind: 'p' | 'r' | 'park') =>
  `assistant-${role}-${kind}-${runId}-1-aaaaaaaa`;
const image = (role: Role, digest: string) =>
  `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}@sha256:${digest.repeat(64)}`;
const route = (revision: string, percent = 100, tag?: string) => ({
  type: allocation,
  revision,
  percent,
  ...(tag ? { tag } : {}),
});
const observedRoutes = (rows: ReturnType<typeof route>[], uri: string) =>
  rows.map((row) => ({
    ...row,
    ...(row.tag ? { uri: uri.replace('https://', `https://${row.tag}---`) } : {}),
  }));
const candidate = `candidate-${runId}-1`;
const resume = `resume-${runId}-1`;
const warmTag = `park-${runId}-1`;
const unsigned = {
  format: 1,
  release: source,
  storageDriver: 'firestore',
  schemaVersion: 1,
  selected: roles,
  components: Object.fromEntries(
    roles.map((role) => [
      role,
      {
        image: image(role, '3'),
        digest: `sha256:${'3'.repeat(64)}`,
        apiContract: 3,
        peerApi: { min: 3, max: 3 },
        schema: { min: 1, max: 1 },
      },
    ]),
  ),
};
const manifest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
const releaseManifest = JSON.stringify({ ...unsigned, manifestDigest: manifest });

function template(role: Role, revision: string, kind: 'old' | 'paused' | 'resumed') {
  const old = kind === 'old',
    contract = old ? '1' : '3';
  const peer = role === 'agent' ? 'WEB' : 'AGENT';
  return {
    revision,
    serviceAccount: `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`,
    timeout: role === 'web' ? '300s' : '3600s',
    containers: [
      {
        image: image(role, old ? '2' : '3'),
        env: [
          ...Object.entries({
            GCP_PROJECT: 'bmson-assistant',
            ...(!old ? estimatedCostReleaseEnvironment(costProfile) : {}),
            PERSISTENCE_DRIVER: 'firestore',
            FIRESTORE_DATABASE_ID: 'assistant-production',
            FIRESTORE_AGENT_ID: ownerId,
            ASSISTANT_WORKSPACE_ID: installationId,
            ...(role === 'web' ? { AGENT_URL: agentUri } : {}),
            ASSISTANT_RELEASE_API_CONTRACT: contract,
            [`ASSISTANT_RELEASE_${peer}_API_MIN`]: contract,
            [`ASSISTANT_RELEASE_${peer}_API_MAX`]: contract,
            ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
            ASSISTANT_RELEASE_SCHEMA_MIN: '1',
            ASSISTANT_RELEASE_SCHEMA_MAX: '1',
            ASSISTANT_RELEASE_SCHEMA_VERSION: '1',
            ASSISTANT_RELEASE_SOURCE_SHA: old ? oldSource : source,
            ASSISTANT_RELEASE_MANIFEST: old ? oldManifest : manifest,
            ASSISTANT_RELEASE_WORKFLOW_RUN_ID: old ? '1234' : runId,
            ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: '1',
            ASSISTANT_RELEASE_WRITES_PAUSED: String(kind === 'paused'),
            MCP_OAUTH_ENABLED: 'false',
          }).map(([name, value]) => ({ name, value })),
          {
            name: 'OPENROUTER_API_KEY',
            valueSource: { secretKeyRef: { secret: 'openrouter', version: '31' } },
          },
        ],
      },
    ],
  };
}
function revision(name: string, draft: ReturnType<typeof template>) {
  const { revision, ...fields } = draft;
  return {
    ...fields,
    name: `${name}/revisions/${revision}`,
    service: name,
    uid: `uid-${revision}`,
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
  };
}
function roleFixture(role: Role) {
  const name = `projects/bmson-assistant/locations/us-west1/services/assistant-${role}`;
  const old = `assistant-${role}-old`;
  const original = template(role, old, 'old');
  const originalRevision = revision(name, original);
  const service = {
    name,
    uid: `svc-${role}`,
    etag: 'etag-2',
    generation: '2',
    observedGeneration: '2',
    latestCreatedRevision: old,
    latestReadyRevision: old,
    urls: [role === 'agent' ? agentUri : 'https://assistant-web-fixture-uw.a.run.app'],
    uri: role === 'agent' ? agentUri : 'https://assistant-web-fixture-uw.a.run.app',
    template: original,
    scaling: structuredClone(manual) as typeof manual | typeof automaticScaling,
    traffic: [route(old)],
    trafficStatuses: observedRoutes(
      [route(old)],
      role === 'agent' ? agentUri : 'https://assistant-web-fixture-uw.a.run.app',
    ),
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
  };
  const binding = {
    service: name,
    uid: service.uid,
    revision: old,
    image: image(role, '2'),
    serviceSha256: bootstrapDigest(service),
    revisionSha256: bootstrapDigest(originalRevision),
    automaticScaling,
    proof: {
      uid: tagHash(originalRevision.uid),
      image: image(role, '2'),
      source: oldSource,
      manifest: oldManifest,
      runId: '1234',
      attempt: '1',
      paused: false,
      templateSha256: bootstrapDigest(original),
    },
  };
  return { native: { service, revisions: { [old]: originalRevision } }, binding, old };
}
function scenario() {
  const web = roleFixture('web'),
    agent = roleFixture('agent');
  const pair = { web: web.native, agent: agent.native };
  const original: BootstrapReceipt = {
    kind: 'disabled-bootstrap',
    format: 1,
    source,
    closureReceiptSha256: evidence,
    drainReceiptSha256: evidence,
    recoveryReceiptSha256: evidence,
    services: { web: web.binding, agent: agent.binding },
  };
  const review: Review = {
    original,
    originalSha256: bootstrapDigest(original),
    costProfile,
    source,
    resumeSource,
    manifest,
    releaseManifest,
    runId,
    ownerId,
    installationId,
    images: { web: image('web', '3'), agent: image('agent', '3') },
    signedImagesReceiptSha256: evidence,
    deliveryHoldReceiptSha256: evidence,
    transitionSettlementReceiptSha256: evidence,
  };
  function add(role: Role, kind: 'p' | 'r') {
    const name = phase(role, kind),
      native = pair[role];
    const next = template(role, name, kind === 'p' ? 'paused' : 'resumed');
    native.revisions[name] = revision(native.service.name, next);
    native.service.template = next;
    native.service.latestCreatedRevision = name;
    native.service.latestReadyRevision = name;
    return name;
  }
  function setRouting(role: Role, rows: ReturnType<typeof route>[], auto = false) {
    pair[role].service.scaling = structuredClone(auto ? automaticScaling : manual);
    pair[role].service.traffic = structuredClone(rows);
    pair[role].service.trafficStatuses = observedRoutes(rows, pair[role].service.uri);
  }
  return { review, pair, add, setRouting, old: { web: web.old, agent: agent.old } };
}
type Case = ReturnType<typeof scenario>;
function settle(f: Case) {
  return {
    evidenceSha256: evidence,
    serviceSha256: {
      web: bootstrapDigest(f.pair.web.service),
      agent: bootstrapDigest(f.pair.agent.service),
    },
  };
}
function advance(f: Case, plan: ReturnType<typeof planApi3ForwardRecovery>) {
  if (plan.outcome !== 'action') throw new Error(`Expected a recovery action, got ${plan.outcome}`);
  const action = plan.action,
    native = f.pair[action.role];
  const before = structuredClone(f.pair);
  const settlement = settle(f);
  const traffic = (action.body.traffic ?? native.service.traffic) as ReturnType<typeof route>[];
  native.service.traffic = structuredClone(traffic);
  native.service.trafficStatuses = observedRoutes(traffic, native.service.uri);
  if (action.body.scaling) native.service.scaling = structuredClone(manual);
  if (action.body.template) {
    const draft = action.body.template as ReturnType<typeof template>;
    native.revisions[draft.revision] = revision(native.service.name, draft);
    native.service.template = structuredClone(draft);
    native.service.latestCreatedRevision = draft.revision;
  }
  native.service.generation = String(Number(native.service.generation) + 1);
  native.service.observedGeneration = native.service.generation;
  native.service.etag = `etag-${native.service.generation}`;
  const observed = reconcileApi3ForwardRecovery(
    f.review,
    { pair: before, settlement, action },
    f.pair,
  );
  expect(observed).toMatchObject({ outcome: 'observed-exact-effect', operationProven: false });
  return observed;
}
function readyAndPin(f: Case, role: Role, target = phase(role, 'park')) {
  const warm = planApi3ForwardRecovery(f.review, f.pair, settle(f));
  expect(warm).toMatchObject({
    outcome: 'action',
    action: { role, step: 'warm', updateMask: 'traffic' },
  });
  advance(f, warm);
  const pending = planApi3ForwardRecovery(f.review, f.pair, settle(f));
  expect(pending).toEqual({ outcome: 'startup-required', role, revision: target });
  f.pair[role].service.latestReadyRevision = target;
  const pin = planApi3ForwardRecovery(f.review, f.pair, settle(f));
  expect(pin).toMatchObject({
    outcome: 'action',
    action: {
      role,
      step: 'pin',
      body: { traffic: [route(target)] },
    },
  });
  advance(f, pin);
}
function assertClosed(f: Case, expected: Record<Role, string>) {
  const result = planApi3ForwardRecovery(f.review, f.pair, settle(f));
  if (result.outcome !== 'closed-api3-pair')
    throw new Error(`Pair did not close. Received ${result.outcome}`);
  expect(result.receipt.source).toBe(resumeSource);
  expect(result.receiptSha256).toBe(bootstrapDigest(result.receipt));
  for (const role of roles) {
    const binding = result.receipt.services[role];
    const native = f.pair[role];
    expect(binding.revision).toBe(expected[role]);
    expect(binding.proof).toMatchObject({
      source,
      manifest,
      paused: true,
      image: image(role, '3'),
    });
    verifyCurrentSnapshot(binding, native.service, native.revisions[binding.revision]);
  }
  const binding = result.receipt.services.web;
  const context = pairedWebContext({
    source: resumeSource,
    runId: '23456',
    attempt: '1',
    manifestDigest: 'a'.repeat(64),
    manifest: {
      components: {
        web: {
          apiContract: 3,
          image: image('web', '4'),
          peerApi: { min: 3, max: 3 },
          schema: { min: 1, max: 1 },
        },
      },
      storageDriver: 'firestore',
      schemaVersion: 1,
    },
    current: {
      revision: binding.revision,
      binding: {
        proof: binding.proof,
        serviceSha256: binding.serviceSha256,
        revisionSha256: binding.revisionSha256,
        reviewedEvidenceSha256: result.receiptSha256,
        preclosed: true,
      },
    },
  });
  const native = f.pair.web;
  expect(
    projectNativeWebSnapshot(
      native.service,
      { [binding.revision]: native.revisions[binding.revision] },
      context,
    ),
  ).toMatchObject({
    latestCreated: binding.revision,
    latestReady: binding.revision,
    admissionDisabled: true,
  });
}

describe('recover a partially staged Firestore transition', () => {
  it('closes an alias that was attached to the original agent after a failed create', () => {
    const f = scenario();
    f.setRouting('agent', [route(f.old.agent, 100, candidate)]);
    const close = planApi3ForwardRecovery(f.review, f.pair);
    expect(close).toMatchObject({
      outcome: 'action',
      action: {
        role: 'agent',
        step: 'close',
        updateMask: 'scaling,traffic',
        body: { scaling: manual, traffic: [route(f.old.agent)] },
      },
    });
    advance(f, close);
    expect(planApi3ForwardRecovery(f.review, f.pair)).toMatchObject({
      outcome: 'settlement-required',
    });
    expect(planApi3ForwardRecovery(f.review, f.pair, settle(f))).toEqual({
      outcome: 'paused-template-review-required',
      missingPaused: ['web', 'agent'],
    });
    f.review.pausedTemplates = {
      web: template('web', phase('web', 'p'), 'paused'),
      agent: template('agent', phase('agent', 'p'), 'paused'),
    };
    for (const role of roles) {
      const create = planApi3ForwardRecovery(f.review, f.pair, settle(f));
      expect(create).toMatchObject({ outcome: 'action', action: { step: 'create-paused', role } });
      advance(f, create);
      readyAndPin(f, role);
    }
    assertClosed(f, { web: phase('web', 'park'), agent: phase('agent', 'park') });
  });

  it('closes paused web and pins the API 3 agent when its successor never materialized', () => {
    const f = scenario(),
      web = f.add('web', 'p'),
      agent = f.add('agent', 'p');
    f.setRouting('web', [route(web, 100, candidate)], true);
    f.setRouting('agent', [route(f.old.agent), route(agent, 0, candidate)]);
    for (const role of roles) {
      const close = planApi3ForwardRecovery(f.review, f.pair);
      expect(close).toMatchObject({ outcome: 'action', action: { role, step: 'close' } });
      advance(f, close);
    }
    const pin = planApi3ForwardRecovery(f.review, f.pair, settle(f));
    expect(pin).toMatchObject({
      outcome: 'action',
      action: {
        role: 'agent',
        step: 'pin',
        updateMask: 'traffic',
        body: { traffic: [route(agent)] },
      },
    });
    advance(f, pin);
    assertClosed(f, { web, agent });
  });

  it.each(roles)('rejects a stale candidate URL in the final %s inventory', (role) => {
    const f = scenario();
    for (const side of roles) f.setRouting(side, [route(f.add(side, 'p'))]);
    const { service } = f.pair[role];
    service.urls.push(service.uri.replace('https://', `https://${candidate}---`));
    expect(() => planApi3ForwardRecovery(f.review, f.pair, settle(f))).toThrow();
  });

  it('accepts both canonical agent URLs in the final inventory', () => {
    const f = scenario();
    for (const role of roles) f.setRouting(role, [route(f.add(role, 'p'))]);
    f.pair.agent.service.urls.push('https://assistant-agent-83709630368.us-west1.run.app');
    assertClosed(f, { web: phase('web', 'p'), agent: phase('agent', 'p') });
  });

  it.each([false, true])(
    'recovers after the named unpaused agent may have admitted work, promoted=%s',
    (promoted) => {
      const f = scenario(),
        web = f.add('web', 'p');
      f.add('agent', 'p');
      const agent = f.add('agent', 'r');
      f.setRouting('web', [route(web, 100, candidate)], true);
      f.setRouting(
        'agent',
        promoted
          ? [route(agent, 100, candidate)]
          : [route(f.old.agent), route(agent, 0, candidate)],
        promoted,
      );
      for (const role of roles) {
        const close = planApi3ForwardRecovery(f.review, f.pair);
        expect(close).toMatchObject({ outcome: 'action', action: { role, step: 'close' } });
        advance(f, close);
      }
      const settlement = settle(f);
      const create = planApi3ForwardRecovery(f.review, f.pair, settlement);
      expect(create).toMatchObject({
        outcome: 'action',
        action: {
          role: 'agent',
          step: 'create-paused',
          updateMask: 'template',
          body: {
            template: template('agent', phase('agent', 'park'), 'paused'),
          },
        },
      });
      advance(f, create);
      readyAndPin(f, 'agent');
      expect(() => planApi3ForwardRecovery(f.review, f.pair, settlement)).toThrow();
      assertClosed(f, { web, agent: phase('agent', 'park') });
    },
  );

  it('closes reachable web R and parks both exact API 3 role images', () => {
    const f = scenario(),
      webP = f.add('web', 'p');
    const webR = f.add('web', 'r');
    f.add('agent', 'p');
    const agentR = f.add('agent', 'r');
    f.setRouting('web', [route(webP, 100, candidate), route(webR, 0, resume)], true);
    f.setRouting('agent', [route(agentR, 100, candidate)], true);
    for (const role of roles) {
      const close = planApi3ForwardRecovery(f.review, f.pair);
      expect(close).toMatchObject({ outcome: 'action', action: { role, step: 'close' } });
      advance(f, close);
    }
    for (const role of roles) {
      const create = planApi3ForwardRecovery(f.review, f.pair, settle(f));
      expect(create).toMatchObject({ outcome: 'action', action: { role, step: 'create-paused' } });
      advance(f, create);
      readyAndPin(f, role);
    }
    assertClosed(f, { web: phase('web', 'park'), agent: phase('agent', 'park') });
  });

  it.each([
    'foreign-tag',
    'route-disagreement',
    'wrong-image',
    'wrong-source',
    'oauth-enabled',
    'still-reconciling',
  ] as const)('fails closed with %s', (kind) => {
    const f = scenario(),
      agent = f.add('agent', 'p');
    f.setRouting('agent', [
      route(f.old.agent),
      route(agent, 0, kind === 'foreign-tag' ? 'manual-canary' : candidate),
    ]);
    if (kind === 'route-disagreement')
      f.pair.agent.service.trafficStatuses = [route(agent, 100, candidate)];
    if (kind === 'wrong-image') f.review.images.agent = image('agent', 'f');
    if (kind === 'still-reconciling') Object.assign(f.pair.agent.service, { reconciling: true });
    const env = f.pair.agent.service.template.containers[0]?.env;
    if (kind === 'wrong-source' || kind === 'oauth-enabled') {
      const entry = env?.find(
        (v) =>
          v.name ===
          (kind === 'wrong-source' ? 'ASSISTANT_RELEASE_SOURCE_SHA' : 'MCP_OAUTH_ENABLED'),
      );
      if (!entry) throw new Error('Missing synthetic env');
      if ('value' in entry) entry.value = kind === 'wrong-source' ? oldSource : 'true';
    }
    expect(() => planApi3ForwardRecovery(f.review, f.pair)).toThrow();
  });

  it('requires review of failed transition operations before planning closure', () => {
    const f = scenario();
    f.review.transitionSettlementReceiptSha256 = '';
    expect(() => planApi3ForwardRecovery(f.review, f.pair)).toThrow();
  });

  it('does not trust the readiness of a different tag URL or stale latest revision', () => {
    const f = scenario();
    f.review.pausedTemplates = {
      web: template('web', phase('web', 'p'), 'paused'),
      agent: template('agent', phase('agent', 'p'), 'paused'),
    };
    advance(f, planApi3ForwardRecovery(f.review, f.pair, settle(f)));
    advance(f, planApi3ForwardRecovery(f.review, f.pair, settle(f)));
    const state = f.pair.web.service;
    state.trafficStatuses = state.trafficStatuses.map((row) => ({
      ...row,
      uri: 'https://foreign.example',
    }));
    expect(() => planApi3ForwardRecovery(f.review, f.pair, settle(f))).toThrow();
    state.trafficStatuses = observedRoutes(state.traffic, state.uri);
    expect(planApi3ForwardRecovery(f.review, f.pair, settle(f))).toEqual({
      outcome: 'startup-required',
      role: 'web',
      revision: phase('web', 'park'),
    });
  });

  it('writes one private reviewed action through the offline CLI', () => {
    const f = scenario();
    f.setRouting('agent', [route(f.old.agent, 100, candidate)]);
    const directory = mkdtempSync(join(tmpdir(), 'assistant-api3-recovery-'));
    try {
      const input = join(directory, 'input.json');
      const output = join(directory, 'output.json');
      const packet = { review: f.review, pair: f.pair, imageProofs: [] };
      const digest = bootstrapDigest(packet);
      writeFileSync(input, JSON.stringify(packet), { mode: 0o600, flag: 'wx' });
      const script = fileURLToPath(new URL('./owner-release-api3-recovery.ts', import.meta.url));
      execFileSync(process.execPath, ['--import', 'tsx', script, input, digest, output], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      });
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        inputSha256: digest,
        ...planApi3ForwardRecovery(f.review, f.pair),
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('keeps a lost response unresolved for no effect or unrelated drift', () => {
    const f = scenario();
    f.setRouting('agent', [route(f.old.agent, 100, candidate)]);
    const plan = planApi3ForwardRecovery(f.review, f.pair);
    if (plan.outcome !== 'action') throw new Error('Missing planned closure');
    const prior = { pair: structuredClone(f.pair), action: plan.action };
    expect(() => reconcileApi3ForwardRecovery(f.review, prior, f.pair)).toThrow();
    advance(f, plan);
    expect(reconcileApi3ForwardRecovery(f.review, prior, f.pair).operationProven).toBe(false);
    f.pair.agent.service.ingress = 'INGRESS_TRAFFIC_ALL';
    expect(() => reconcileApi3ForwardRecovery(f.review, prior, f.pair)).toThrow();
  });

  it('rehearses an actual mixed-pair recovery through successive offline CLI invocations', () => {
    const f = scenario();
    const web = f.add('web', 'p');
    f.add('agent', 'p');
    const agentSuccessor = f.add('agent', 'r');
    f.setRouting('web', [route(web, 100, candidate)], true);
    f.setRouting('agent', [route(f.old.agent), route(agentSuccessor, 0, candidate)]);
    const directory = mkdtempSync(join(tmpdir(), 'assistant-api3-mixed-rehearsal-'));
    const script = fileURLToPath(new URL('./owner-release-api3-recovery.ts', import.meta.url));
    type Plan = ReturnType<typeof planApi3ForwardRecovery>;
    type Prior = Parameters<typeof reconcileApi3ForwardRecovery>[1];
    let call = 0;
    function offline(
      settlement?: ReturnType<typeof settle>,
      prior?: Prior,
      observed = f.pair,
      expectedActionSha256?: string,
    ) {
      const input = join(directory, `input-${++call}.json`);
      const output = join(directory, `output-${call}.json`);
      const packet = {
        review: f.review,
        pair: observed,
        imageProofs: [],
        settlement,
        expectedActionSha256,
        ...(prior
          ? { reconcile: prior, unresolvedAttemptSha256: bootstrapDigest(prior.action) }
          : {}),
      };
      const serialized = JSON.stringify(packet);
      const digest = bootstrapDigest(JSON.parse(serialized));
      writeFileSync(input, serialized, { mode: 0o600, flag: 'wx' });
      execFileSync(process.execPath, ['--import', 'tsx', script, input, digest, output], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      });
      expect(statSync(output).mode & 0o777).toBe(0o600);
      return JSON.parse(readFileSync(output, 'utf8')) as Plan;
    }
    function dispatch(step: string, role: Role, settlement?: ReturnType<typeof settle>) {
      const plan = offline(settlement);
      if (plan.outcome !== 'action') throw new Error('Expected a reviewed recovery action');
      expect(plan.action).toMatchObject({ step, role, pairSha256: bootstrapDigest(f.pair) });
      const requestDigest = bootstrapDigest(plan.action);
      expect(offline(settlement, undefined, f.pair, requestDigest)).toMatchObject({
        outcome: 'action',
        action: plan.action,
      });
      if (settlement) {
        const swapped = { ...settlement, evidenceSha256: '9'.repeat(64) };
        expect(() => offline(swapped, undefined, f.pair, requestDigest)).toThrow();
      }
      const prior = { pair: structuredClone(f.pair), settlement, action: plan.action };
      const unknown = offline(undefined, prior);
      expect(unknown).toMatchObject({ outcome: 'observation-required', operationProven: false });
      expect(unknown).not.toHaveProperty('action');
      advance(f, plan);
      expect(offline(undefined, prior)).toMatchObject({
        outcome: 'observed-exact-effect',
        requestSha256: requestDigest,
        operationProven: false,
      });
      expect(() => offline(settlement, undefined, f.pair, requestDigest)).toThrow();
      return plan.action;
    }
    try {
      dispatch('close', 'web');
      dispatch('close', 'agent');
      expect(offline()).toMatchObject({ outcome: 'settlement-required' });
      const create = dispatch('create-paused', 'agent', settle(f));
      expect(create.updateMask).toBe('template');
      expect(create.body).not.toHaveProperty('traffic');
      expect(f.pair.agent.service.traffic).toEqual([route(f.old.agent)]);
      const warm = dispatch('warm', 'agent', settle(f));
      const parked = phase('agent', 'park');
      expect(warm.body.traffic).toEqual([route(f.old.agent), route(parked, 0, warmTag)]);
      expect(offline(settle(f))).toMatchObject({
        outcome: 'startup-required',
        role: 'agent',
        revision: parked,
      });
      f.pair.agent.service.latestReadyRevision = parked;
      const pin = dispatch('pin', 'agent', settle(f));
      expect(pin.body.traffic).toEqual([route(parked)]);
      expect(offline(settle(f))).toMatchObject({
        outcome: 'closed-api3-pair',
        receipt: {
          source: resumeSource,
          services: { web: { revision: web }, agent: { revision: parked } },
        },
      });
      assertClosed(f, { web, agent: parked });
    } finally {
      rmSync(directory, { recursive: true });
    }
  }, 45000);
});

describe('restore target checkpoint routing', () => {
  function staged() {
    const f = scenario();
    const agent = f.add('agent', 'p'),
      web = f.add('web', 'p');
    f.setRouting('agent', [route(f.old.agent), route(agent, 0, candidate)]);
    f.setRouting('web', [route(web)], true);
    return f;
  }
  it('accepts an untouched drained pair only for restoration and the exact staged pair for admission', () => {
    const untouched = scenario();
    expect(() =>
      verifyRestoreCheckpointPair(untouched.review, untouched.pair, 'pre_admission_restore'),
    ).not.toThrow();
    expect(() =>
      verifyRestoreCheckpointPair(untouched.review, untouched.pair, 'before_admission'),
    ).toThrow();
    const f = staged();
    for (const stage of [
      'before_admission',
      'pre_admission_restore',
      'post_admission_forward',
    ] as const)
      expect(() => verifyRestoreCheckpointPair(f.review, f.pair, stage)).not.toThrow();
  });
  it('rejects a pre-admission direction after an agent successor even with zero percent traffic', () => {
    const f = staged();
    const next = f.add('agent', 'r');
    f.setRouting('agent', [route(f.old.agent), route(next, 0, candidate)]);
    expect(() => verifyRestoreCheckpointPair(f.review, f.pair, 'pre_admission_restore')).toThrow();
    expect(() =>
      verifyRestoreCheckpointPair(f.review, f.pair, 'post_admission_forward'),
    ).not.toThrow();
  });
  it('preserves provider-quoted etags in action preconditions and holds malformed values', () => {
    const f = staged();
    const quoted = `"${'aB3/'.repeat(26)}ZQ=="`;
    f.pair.web.service.etag = quoted;
    expect(() => verifyRestoreCheckpointPair(f.review, f.pair, 'before_admission')).not.toThrow();
    expect(planApi3ForwardRecovery(f.review, f.pair)).toMatchObject({
      outcome: 'action',
      action: { body: { etag: quoted } },
    });
    for (const malformed of [
      quoted.slice(1),
      quoted.slice(0, -1),
      '""',
      `W/${quoted}`,
      'malformed\r\netag',
    ]) {
      f.pair.web.service.etag = malformed;
      expect(() => verifyRestoreCheckpointPair(f.review, f.pair, 'before_admission')).toThrow();
    }
  });
  it('requires the resumed canonical agent and the paused canonical web immediately before web admission', () => {
    const f = staged();
    const agent = f.add('agent', 'r');
    f.setRouting('agent', [route(f.old.agent), route(agent, 0, candidate)]);
    expect(() =>
      verifyRestoreCheckpointPair(f.review, f.pair, 'post_admission_forward'),
    ).not.toThrow();
    expect(() => verifyRestoreCheckpointPair(f.review, f.pair, 'before_web_resume')).toThrow();
    f.setRouting('agent', [route(agent), route(agent, 0, candidate)], true);
    expect(() => verifyRestoreCheckpointPair(f.review, f.pair, 'before_web_resume')).not.toThrow();
    f.setRouting('agent', [route(agent), route(f.old.agent, 0, candidate)], true);
    expect(() => verifyRestoreCheckpointPair(f.review, f.pair, 'before_web_resume')).toThrow();
  });
  it('holds on original revision substitution, exposed old traffic, foreign aliases and unhealthy staged readiness', () => {
    for (const mutation of [
      (f: Case) => {
        const old = f.pair.web.revisions[f.old.web];
        if (old) old.timeout = '900s';
      },
      (f: Case) => f.setRouting('web', [route(f.old.web)], true),
      (f: Case) =>
        f.setRouting('web', [route(phase('web', 'p')), route(f.old.web, 0, 'unrelated')], true),
      (f: Case) => {
        const revision = f.pair.web.revisions[phase('web', 'p')];
        revision?.conditions.push({ type: 'Ready', state: 'CONDITION_FAILED' });
      },
    ]) {
      const f = staged();
      mutation(f);
      expect(() => verifyRestoreCheckpointPair(f.review, f.pair, 'before_admission')).toThrow();
    }
  });
});
