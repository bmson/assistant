import {
  type BootstrapReceipt,
  bootstrapDigest,
  disabled,
  object,
  RUN_ROOT,
  requireProof,
  SERVICE_ROOT,
  scalingConfigurationDigest,
} from './owner-release-current-snapshot.js';
/** Reviewed bootstrap scaling transport and existing-phase checkpoints. */
import {
  type Snapshot,
  type State,
  verifyLifecycleState,
} from './owner-web-release-lifecycle-model.js';
import { nativeStableConfigurationDigest } from './owner-web-release-native-proof.js';
import type { FixtureDependencies } from './owner-web-release-native-session.js';
import { boundedResponseJson } from './owner-web-release-operator-hold.js';

export * from './owner-release-current-snapshot.js';

type Obj = Record<string, unknown>;
const same = (a: unknown, b: unknown) => bootstrapDigest(a) === bootstrapDigest(b);
function literal(template: Obj, name: string) {
  const cs = template.containers;
  requireProof(Array.isArray(cs) && cs.length === 1);
  const env = object(cs[0]).env;
  requireProof(Array.isArray(env));
  const es = env.map(object).filter((e) => e.name === name);
  requireProof(es.length === 1 && typeof es[0]?.value === 'string' && !es[0].valueSource);
  return es[0]?.value;
}
export type CandidateIdentity = {
  revision: string;
  image: string;
  source: string;
  manifest: string;
  runId: string;
  attempt: string;
  pausedAgentRevision?: string;
};
function validateCandidate(
  service: string,
  s: Obj,
  r: Obj,
  expected: CandidateIdentity,
  paused: boolean,
  healthy: boolean,
) {
  requireProof(r.name === `${service}/revisions/${expected.revision}` && r.service === service);
  if (healthy) {
    requireProof(s.observedGeneration === s.generation);
    requireProof(
      String(s.latestCreatedRevision).split('/').at(-1) === expected.revision &&
        String(s.latestReadyRevision).split('/').at(-1) === expected.revision,
    );
    const conditions = r.conditions;
    requireProof(Array.isArray(conditions) && conditions.length > 0 && conditions.length <= 16);
    requireProof(
      conditions
        .map(object)
        .every(
          (c) =>
            c.state === 'CONDITION_SUCCEEDED' &&
            c.reason === undefined &&
            c.revisionReason === undefined,
        ),
    );
    requireProof(
      conditions.map(object).filter((c) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED')
        .length === 1,
    );
  }
  const t = object(s.template),
    cs = t.containers;
  requireProof(Array.isArray(cs) && cs.length === 1 && object(cs[0]).image === expected.image);
  requireProof(
    t.revision === expected.revision &&
      literal(t, 'ASSISTANT_RELEASE_MANIFEST') === expected.manifest,
  );
  requireProof(literal(t, 'ASSISTANT_RELEASE_SOURCE_SHA') === expected.source);
  requireProof(
    literal(t, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID') === expected.runId &&
      literal(t, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT') === expected.attempt,
  );
  requireProof(literal(t, 'ASSISTANT_RELEASE_WRITES_PAUSED') === String(paused));
  const projected: Obj = {};
  for (const key of Object.keys(t)) if (r[key] !== undefined) projected[key] = r[key];
  projected.revision = expected.revision;
  requireProof(same(t, projected));
}
export function planScalingRestore(
  receipt: BootstrapReceipt,
  role: 'agent' | 'web',
  service: unknown,
  revision: unknown,
  expected: CandidateIdentity,
  forHold = false,
) {
  requireProof(receipt.kind === 'disabled-bootstrap');
  const s = object(service),
    r = object(revision),
    b = receipt.services[role];
  requireProof(receipt.source === expected.source && expected.revision !== b.revision);
  requireProof(s.name === b.service && s.uid === b.uid && disabled(s) && s.reconciling !== true);
  requireProof(typeof s.etag === 'string' && s.etag.length > 0);
  validateCandidate(b.service, s, r, expected, role === 'web', !forHold);
  for (const rows of [s.traffic, s.trafficStatuses]) {
    const expectedRows = [
      {
        revision: expected.revision,
        tag: `candidate-${expected.runId}-${expected.attempt}`,
        percent: 100,
      },
    ];
    requireProof(same(normalizedAgentRows(rows), expectedRows));
  }
  return { name: b.service, etag: s.etag, scaling: object(b.automaticScaling) };
}
/** Metadata-only checkpoint: no phase or admission transition is introduced. */
export function scalingCheckpoint(
  state: State,
  fresh: Snapshot,
  expectedStableHash: string,
): State {
  verifyLifecycleState(state);
  requireProof(
    ['promotedP', 'retired', 'agentReady'].includes(state.phase) &&
      !state.pending &&
      !state.admissionPossible &&
      !state.retirementAttempt,
  );
  const before = state.snapshot;
  const keys = Object.keys(before).filter(
    (k) =>
      ![
        'etag',
        'generation',
        'observedGeneration',
        'stableConfigSha256',
        'admissionDisabled',
        'succeeded',
      ].includes(k),
  );
  requireProof(
    same(
      Object.fromEntries(keys.map((k) => [k, before[k as keyof Snapshot]])),
      Object.fromEntries(keys.map((k) => [k, fresh[k as keyof Snapshot]])),
    ),
  );
  requireProof(
    fresh.stableConfigSha256 === expectedStableHash &&
      fresh.etag !== before.etag &&
      BigInt(fresh.generation) > BigInt(before.generation) &&
      fresh.observedGeneration === fresh.generation,
  );
  const { receipt: prior, ...body } = {
    ...state,
    snapshot: fresh,
    previousReceipt: state.receipt,
    ordinal: state.ordinal + 1,
  };
  return { ...body, receipt: bootstrapDigest(body) };
}
export type ScalingIO = Pick<FixtureDependencies, 'now' | 'sleep' | 'request'> & {
  recordIntent: (value: unknown) => Promise<void>;
};
export async function readBootstrapNative(io: Pick<ScalingIO, 'request'>, path: string) {
  requireProof(path.startsWith(SERVICE_ROOT) && !path.includes('?'));
  const response = await io.request(`${RUN_ROOT}${path}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  return object(await boundedResponseJson(response, 2 * 1024 * 1024, 15000));
}
/** Single PATCH; unknown result is retained and never retried by this adapter. */
export async function restoreScaling(
  io: ScalingIO,
  receipt: BootstrapReceipt,
  role: 'agent' | 'web',
  expected: CandidateIdentity,
  hold = false,
  expectedAfterConfiguration?: string,
  expectedBeforeServiceSha256?: string,
) {
  const deadline = io.now() + 180000;
  async function request(path: string, body?: Obj) {
    requireProof(io.now() < deadline);
    const response = await io.request(`${RUN_ROOT}${path}`, {
      method: body ? 'PATCH' : 'GET',
      ...(body
        ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
        : {}),
      signal: AbortSignal.timeout(Math.min(15000, deadline - io.now())),
      redirect: 'error',
    });
    requireProof(
      response.ok && Number(response.headers.get('content-length') ?? 0) <= 2 * 1024 * 1024,
    );
    return object(
      await boundedResponseJson(response, 2 * 1024 * 1024, Math.min(15000, deadline - io.now())),
    );
  }
  const name = receipt.services[role].service,
    before = await request(name),
    revision = await request(`${name}/revisions/${expected.revision}`);
  if (expectedBeforeServiceSha256)
    requireProof(bootstrapDigest(before) === expectedBeforeServiceSha256);
  const probe = hold
    ? { ...before, scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 } }
    : before;
  if (hold) requireProof(same(before.scaling, receipt.services[role].automaticScaling));
  if (hold)
    requireProof(
      expectedAfterConfiguration &&
        scalingConfigurationDigest(before) === expectedAfterConfiguration,
    );
  const body = planScalingRestore(receipt, role, probe, revision, expected, hold);
  if (hold) body.scaling = { scalingMode: 'MANUAL', manualInstanceCount: 0 };
  await io.recordIntent({
    kind: 'bootstrap-scaling',
    role,
    source: expected.source,
    beforeSha256: bootstrapDigest(before),
    requestSha256: bootstrapDigest(body),
    outcome: 'attempted',
  });
  try {
    let op = await request(`${name}?updateMask=scaling`, body);
    requireProof(
      typeof op.name === 'string' &&
        /^projects\/bmson-assistant\/locations\/us-west1\/operations\/[A-Za-z0-9-]+$/.test(op.name),
    );
    const operation = op.name;
    for (let n = 0; op.done !== true; n++) {
      requireProof(n < 50 && !op.error);
      await io.sleep(3000, AbortSignal.timeout(Math.max(1, deadline - io.now())));
      op = await request(operation);
      requireProof(op.name === operation);
    }
    requireProof(!op.error && object(op.response).name === name);
    const after = await request(name);
    const beforeConfig = { ...before };
    delete beforeConfig.scaling;
    const afterConfig = { ...after };
    delete afterConfig.scaling;
    requireProof(
      scalingConfigurationDigest(beforeConfig) === scalingConfigurationDigest(afterConfig),
    );
    requireProof(
      same(after.scaling, body.scaling) && after.reconciling !== true && after.etag !== before.etag,
    );
    await io.recordIntent({
      kind: 'bootstrap-scaling',
      role,
      source: expected.source,
      beforeSha256: bootstrapDigest(before),
      afterSha256: bootstrapDigest(after),
      afterConfigurationSha256: scalingConfigurationDigest(after),
      operation,
      outcome: 'completed',
    });
    return { before, after, revision };
  } catch {
    await io.recordIntent({
      kind: 'bootstrap-scaling',
      role,
      source: expected.source,
      beforeSha256: bootstrapDigest(before),
      outcome: 'unknown',
    });
    throw new Error('Bootstrap scaling outcome unconfirmed; no retry or legacy resume');
  }
}

export function preparePausedAgentResume(
  receipt: BootstrapReceipt,
  service: unknown,
  revision: unknown,
  expected: CandidateIdentity,
) {
  const s = object(service),
    r = object(revision),
    b = receipt.services.agent;
  requireProof(
    receipt.kind === 'disabled-bootstrap' && s.name === b.service && s.uid === b.uid && disabled(s),
  );
  validateCandidate(b.service, s, r, expected, true, true);
  const tag = `candidate-${expected.runId}-${expected.attempt}`;
  const expectedRows = [
    { revision: b.revision, tag: '', percent: 100 },
    { revision: expected.revision, tag, percent: 0 },
  ];
  for (const rows of [s.traffic, s.trafficStatuses])
    requireProof(
      same(
        normalizedAgentRows(rows).sort((a, b) => String(a.tag).localeCompare(String(b.tag))),
        expectedRows.sort((a, b) => a.tag.localeCompare(b.tag)),
      ),
    );
  const template = JSON.parse(JSON.stringify(s.template)) as Obj;
  delete template.revision;
  const container = object((template.containers as unknown[])[0]);
  const env = container.env as Obj[];
  const pause = env.find((e) => e.name === 'ASSISTANT_RELEASE_WRITES_PAUSED');
  requireProof(pause);
  pause.value = 'false';
  return {
    source: expected.source,
    runId: expected.runId,
    attempt: expected.attempt,
    manifest: expected.manifest,
    image: expected.image,
    pausedRevision: expected.revision,
    pausedUid: bootstrapDigest(r.uid),
    serviceUid: b.uid,
    expectedUnpausedTemplateSha256: bootstrapDigest(template),
    serviceStableConfigSha256: nativeStableConfigurationDigest(s),
  };
}
function normalizedAgentRows(value: unknown) {
  requireProof(Array.isArray(value));
  return value.map(object).map((r) => {
    requireProof(r.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION');
    return { revision: r.revision, tag: r.tag ?? '', percent: r.percent ?? 0 };
  });
}
/** One atomic, named agent successor. No in-place unpause and no second create attempt. */
export async function createAgentResume(
  io: ScalingIO,
  receipt: BootstrapReceipt,
  paused: CandidateIdentity,
) {
  const name = receipt.services.agent.service,
    revision = `assistant-agent-r-${paused.runId}-${paused.attempt}-${paused.source.slice(0, 8)}`;
  const before = await readBootstrapNative(io, name),
    old = await readBootstrapNative(io, `${name}/revisions/${paused.revision}`);
  const prepared = preparePausedAgentResume(receipt, before, old, paused);
  const missing = await io.request(`${RUN_ROOT}${name}/revisions/${revision}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  void missing.body?.cancel().catch(() => undefined);
  requireProof(missing.status === 404);
  const template = JSON.parse(JSON.stringify(before.template)) as Obj;
  template.revision = revision;
  const env = object((template.containers as unknown[])[0]).env as Obj[];
  const flag = env.find((e) => e.name === 'ASSISTANT_RELEASE_WRITES_PAUSED');
  requireProof(flag);
  flag.value = 'false';
  const traffic = (before.traffic as unknown[])
    .map(object)
    .map((row) =>
      row.tag === `candidate-${paused.runId}-${paused.attempt}` ? { ...row, revision } : row,
    );
  const body = { name, etag: before.etag, template, traffic };
  const expected = { ...paused, revision };
  await io.recordIntent({
    kind: 'bootstrap-agent-successor',
    outcome: 'attempted',
    source: paused.source,
    runId: paused.runId,
    attempt: paused.attempt,
    manifest: paused.manifest,
    revision,
    beforeSha256: bootstrapDigest(before),
    requestSha256: bootstrapDigest(body),
    prepared,
  });
  const deadline = io.now() + 180000;
  let knownFailure = false;
  async function get(path: string, patch?: Obj) {
    requireProof(io.now() < deadline);
    const response = await io.request(`${RUN_ROOT}${path}`, {
      method: patch ? 'PATCH' : 'GET',
      ...(patch
        ? { body: JSON.stringify(patch), headers: { 'Content-Type': 'application/json' } }
        : {}),
      signal: AbortSignal.timeout(Math.min(15000, deadline - io.now())),
      redirect: 'error',
    });
    return object(
      await boundedResponseJson(response, 2 * 1024 * 1024, Math.min(15000, deadline - io.now())),
    );
  }
  async function observed(disposition: string) {
    const service = await readBootstrapNative(io, name),
      fresh = await readBootstrapNative(io, `${name}/revisions/${revision}`);
    // Same candidate tag is reassigned; the disabled old canonical stays100%.
    const wantedRows = [
      { revision: receipt.services.agent.revision, tag: '', percent: 100 },
      { revision, tag: `candidate-${paused.runId}-${paused.attempt}`, percent: 0 },
    ];
    for (const rows of [service.traffic, service.trafficStatuses])
      requireProof(
        same(
          normalizedAgentRows(rows).sort((a, b) => String(a.tag).localeCompare(String(b.tag))),
          wantedRows.sort((a, b) => a.tag.localeCompare(b.tag)),
        ),
      );
    requireProof(
      service.name === name &&
        service.uid === before.uid &&
        disabled(service) &&
        service.reconciling !== true &&
        nativeStableConfigurationDigest(service) === nativeStableConfigurationDigest(before),
    );
    validateCandidate(name, service, fresh, expected, false, true);
    requireProof(bootstrapDigest(fresh.uid) !== prepared.pausedUid);
    const actual = { ...object(service.template) };
    delete actual.revision;
    requireProof(bootstrapDigest(actual) === prepared.expectedUnpausedTemplateSha256);
    const result = {
      kind: 'bootstrap-agent-successor',
      outcome: 'observed_exact_successor',
      disposition,
      source: paused.source,
      runId: paused.runId,
      attempt: paused.attempt,
      manifest: paused.manifest,
      revision,
      image: paused.image,
      pausedRevision: paused.revision,
      pausedUid: prepared.pausedUid,
      serviceStableConfigSha256: nativeStableConfigurationDigest(service),
      templateSha256: bootstrapDigest(actual),
      uidSha256: bootstrapDigest(fresh.uid),
      afterSha256: bootstrapDigest(service),
      operationProven: disposition === 'operation_completed',
    };
    await io.recordIntent(result);
    return result;
  }
  try {
    let op = await get(`${name}?updateMask=template,traffic`, body);
    requireProof(
      typeof op.name === 'string' &&
        /^projects\/bmson-assistant\/locations\/us-west1\/operations\/[A-Za-z0-9-]+$/.test(op.name),
    );
    const operation = op.name;
    for (let n = 0; op.done !== true; n++) {
      if (op.error) {
        knownFailure = true;
        throw new Error('Operation failed');
      }
      requireProof(n < 50);
      await io.sleep(3000, AbortSignal.timeout(Math.max(1, deadline - io.now())));
      op = await get(operation);
      requireProof(op.name === operation);
    }
    if (op.error) {
      knownFailure = true;
      throw new Error('Operation failed');
    }
    requireProof(object(op.response).name === name);
    return await observed('operation_completed');
  } catch {
    await io.recordIntent({
      kind: 'bootstrap-agent-successor',
      outcome: 'unknown',
      source: paused.source,
      revision,
      requestSha256: bootstrapDigest(body),
    });
    if (!knownFailure) {
      try {
        return await observed('read_only_reconciliation_after_unknown');
      } catch {
        /* No retry or invented operation proof. */
      }
    }
    throw new Error(
      'Agent successor outcome unresolved; retain marker-aware candidates for forward recovery',
    );
  }
}
