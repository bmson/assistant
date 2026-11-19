import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { API3_RECOVERY_REVIEW_PUBLIC_KEY } from './api3-recovery-review-key.mjs';
import { createManifest, validateManifest } from './release-manifest.mjs';

export const IMAGE_ROOT = 'us-west1-docker.pkg.dev/bmson-assistant/assistant';
export const ROLES = ['agent', 'web', 'browser', 'code', 'processor'];
export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const SOURCE = /^[a-f0-9]{40}$/;
export const RUN_ID = /^[1-9][0-9]{0,19}$/;
const HASH = /^[a-f0-9]{64}$/;
const REHEARSAL_ROOT = 'projects/friendly-vigil-514906-p2/locations/us-west1/services';
const TTL_MS = 24 * 60 * 60 * 1000;

function check(condition) {
  if (!condition)
    throw new Error('Authenticated API 3 recovery qualification is missing or invalid');
}

function record(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).sort().join(',') === keys.split(',').sort().join(','));
  return value;
}

function matches(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

export function readBoundedJSON(path, maximum = 16 * 1024) {
  const stat = statSync(path);
  check(stat.isFile() && stat.size > 0 && stat.size <= maximum);
  const bytes = readFileSync(path);
  check(bytes.length > 0 && bytes.length <= maximum);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function validatePrebuiltImages(value, source, runId) {
  const images = record(value, 'source,runId,completedAt,digests');
  check(matches(source, SOURCE) && images.source === source);
  check(matches(runId, RUN_ID) && images.runId === runId);
  check(Number.isSafeInteger(images.completedAt) && images.completedAt > 0);
  record(images.digests, ROLES.join(','));
  check(ROLES.every((role) => matches(images.digests[role], DIGEST)));
  return images;
}

function hashJSON(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// The rehearsal uses a project-specific binding. Only the physical project and
// registry change at promotion: both bindings are calculated from this same build.
export function rehearsalManifest(prebuilt) {
  return hashJSON({
    api: 3,
    roles: { agent: prebuilt.digests.agent, web: prebuilt.digests.web },
    run: prebuilt.runId,
    schema: 1,
    scope: 'synthetic-google-ai-only',
    source: prebuilt.source,
  });
}

export function verifyPromotionManifest(actual, prebuilt) {
  const contract = readBoundedJSON(new URL('./release-contracts.json', import.meta.url));
  const expected = createManifest({
    release: prebuilt.source,
    imageRoot: IMAGE_ROOT,
    selected: ROLES,
    digests: prebuilt.digests,
    contract,
    storageDriver: 'firestore',
  });
  validateManifest(expected);
  check(expected.schemaVersion === 1);
  const manifestDigest = hashJSON(expected);
  check(JSON.stringify(actual) === JSON.stringify({ ...expected, manifestDigest }));
  return manifestDigest;
}

function decode(value, maxBytes) {
  check(matches(value, /^[A-Za-z0-9_-]+$/) && value.length <= Math.ceil((maxBytes * 4) / 3));
  const bytes = Buffer.from(value, 'base64url');
  check(bytes.length <= maxBytes && bytes.toString('base64url') === value);
  return bytes;
}

function revision(role, phase, runId, source) {
  return `assistant-${role}-${phase}-${runId}-1-${source.slice(0, 8)}`;
}

function verifyClosed(raw, role, expectedRevision) {
  const fact = record(
    raw,
    'service,revision,latestCreated,latestReady,generation,observedGeneration,scalingMode,manualInstances,desired,observed',
  );
  check(fact.service === `${REHEARSAL_ROOT}/assistant-${role}`);
  check(
    fact.revision === expectedRevision &&
      fact.latestCreated === expectedRevision &&
      fact.latestReady === expectedRevision,
  );
  check(matches(fact.generation, RUN_ID) && fact.observedGeneration === fact.generation);
  check(fact.scalingMode === 'MANUAL' && fact.manualInstances === 0);
  for (const routes of [fact.desired, fact.observed]) {
    check(Array.isArray(routes) && routes.length === 1);
    const row = record(routes[0], 'revision,percent,tag');
    check(row.revision === expectedRevision && row.percent === 100 && row.tag === '');
  }
}

/**
 * Validate concrete observations in the authenticated review. Native evidence stays private
 * with the reviewer, who checks provider snapshots and digest-preserving mirrors before signing.
 */
export function validateRecoveryObservations(raw, prebuilt, now = Date.now()) {
  const value = record(
    raw,
    'format,kind,source,buildRunId,observedAt,expiresAt,manifest,images,staged,mixed,parking,closed,evidence',
  );
  check(value.format === 1 && value.kind === 'firestore-api3-recovery-review');
  check(value.source === prebuilt.source && value.buildRunId === prebuilt.runId);
  check(
    Number.isSafeInteger(value.observedAt) &&
      Number.isSafeInteger(value.expiresAt) &&
      prebuilt.completedAt <= value.observedAt &&
      value.observedAt <= now &&
      now < value.expiresAt &&
      value.expiresAt - value.observedAt <= TTL_MS,
  );
  check(value.manifest === rehearsalManifest(prebuilt));
  const images = record(value.images, 'agent,web');
  for (const role of ['agent', 'web']) check(images[role] === prebuilt.digests[role]);
  const { source, buildRunId: run } = value;
  const agent = revision('agent', 'p', run, source);
  const web = revision('web', 'p', run, source);
  const parked = revision('agent', 'park', run, source);
  const staged = record(value.staged, 'agent,web,agentTag,agentTagPercent');
  check(staged.agentTag === `candidate-${run}-1` && staged.agentTagPercent === 0);
  const direct = record(
    staged.agent,
    'service,revision,source,manifest,writesPaused,mcpOAuthEnabled',
  );
  check(
    direct.service === 'assistant-agent' &&
      direct.revision === agent &&
      direct.source === source &&
      direct.manifest === value.manifest &&
      direct.writesPaused === true &&
      direct.mcpOAuthEnabled === false,
  );
  const webProbe = record(staged.web, 'revision,sha,status,ready,writesPaused,peer');
  check(
    webProbe.revision === web &&
      webProbe.sha === source &&
      webProbe.status === 200 &&
      webProbe.ready === true &&
      webProbe.writesPaused === true &&
      webProbe.peer === 'staged',
  );

  const mixed = record(value.mixed, 'agentRevision,agentApi,webRevision,webApi');
  check(
    mixed.agentApi === 1 &&
      matches(mixed.agentRevision, /^assistant-agent-[a-z0-9-]{1,47}$/) &&
      mixed.agentRevision !== agent &&
      mixed.agentRevision !== parked &&
      mixed.webApi === 3 &&
      mixed.webRevision === web,
  );
  const parking = record(
    value.parking,
    'revision,tag,percent,canonical,latestReady,source,manifest,writesPaused,mcpOAuthEnabled,createdWithoutTag,priorLatest',
  );
  check(
    parking.createdWithoutTag === parked &&
      parking.priorLatest === revision('agent', 'r', run, source),
  );
  check(
    parking.revision === parked &&
      parking.tag === `park-${run}-1` &&
      parking.percent === 0 &&
      parking.canonical === mixed.agentRevision &&
      parking.latestReady === parked &&
      parking.source === source &&
      parking.manifest === value.manifest &&
      parking.writesPaused === true &&
      parking.mcpOAuthEnabled === false,
  );

  const closed = record(value.closed, 'agent,web');
  verifyClosed(closed.agent, 'agent', parked);
  verifyClosed(closed.web, 'web', web);
  const evidence = record(
    value.evidence,
    'staged,mixed,successor,parkCreation,startup,closed,images',
  );
  check(Object.values(evidence).every((item) => matches(item, HASH)));
  return value;
}

export function verifyApi3RecoveryProof({ envelope, publicKey, prebuilt, now }) {
  const signed = record(JSON.parse(envelope), 'payload,signature');
  const payload = decode(signed.payload, 8 * 1024);
  const signature = decode(signed.signature, 64);
  const key = createPublicKey({ key: decode(publicKey, 128), format: 'der', type: 'spki' });
  check(key.asymmetricKeyType === 'ed25519' && signature.length === 64);
  check(verify(null, payload, key, signature));
  return validateRecoveryObservations(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)),
    prebuilt,
    now,
  );
}

export function protectedRecoveryReview(env, source) {
  check(typeof env.API3_RECOVERY_PROOF === 'string' && env.API3_RECOVERY_PROOF.length <= 12 * 1024);
  check(typeof env.RELEASE_PREBUILT_IMAGES_PATH === 'string');
  const prebuilt = validatePrebuiltImages(
    readBoundedJSON(env.RELEASE_PREBUILT_IMAGES_PATH),
    source,
    env.RELEASE_PREBUILT_RUN_ID,
  );
  return verifyApi3RecoveryProof({
    envelope: env.API3_RECOVERY_PROOF,
    publicKey: API3_RECOVERY_REVIEW_PUBLIC_KEY,
    prebuilt,
  });
}
