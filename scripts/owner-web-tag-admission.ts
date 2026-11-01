/** Fixed-service BASIC5 rollout barrier. Called only by the protected paired release. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { verifyPreAuthEnvironment } from './owner-editor-release-inventory.js';
import { readProtectedWebTagArtifact } from './owner-web-tag-artifact.js';
import { protectedWebTagCloud } from './owner-web-tag-cloud.js';
import {
  extractCreationArchive,
  parseWebManifest,
  resolveProtectedOwnedWebTag,
  type WebTagCreationProof,
  type WebTagCreationReceipt,
  type WebTagCreationRecord,
} from './owner-web-tag-provenance.js';
import {
  executeOwnedWebTagRetirement,
  HISTORICAL_WEB_TAGS,
  immutableWebRevision,
  planOwnedWebTagRetirement,
  type RetirementPlan,
  tagHash,
  validateOwnedProof,
  verifyOwnedWebTagRetirement,
  WEB_SERVICE,
  webTagTrafficSnapshot,
} from './owner-web-tag-retirement.js';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const rec = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid admission metadata');
  return value as Record<string, unknown>;
};
export function verifyAdmissionContext(env: NodeJS.ProcessEnv) {
  verifyPreAuthEnvironment(env);
  if (
    env.GITHUB_WORKFLOW_REF !== 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main' ||
    !['workflow_run', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '') ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.OWNER_TAG_RELEASE_SOURCE !== env.GITHUB_SHA ||
    env.OWNER_TAG_STAGING_TAG !== `candidate-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
  )
    throw new Error('Untrusted paired rollout source');
}
function boundedFile(path: string, limit = 256 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit)
    throw new Error('Invalid admission receipt file');
  return readFileSync(path);
}
function literal(raw: unknown, name: string) {
  const containers = rec(raw).containers;
  if (!Array.isArray(containers) || containers.length !== 1)
    throw new Error('Ambiguous native containers');
  const env = rec(containers[0]).env;
  if (!Array.isArray(env)) throw new Error('Missing native environment');
  const matches = env.map(rec).filter((entry) => entry.name === name);
  if (
    matches.length !== 1 ||
    typeof matches[0]?.value !== 'string' ||
    matches[0].valueSource !== undefined
  )
    throw new Error('Missing literal native creation identity');
  return matches[0].value;
}
type Capture = {
  format: 1;
  source: string;
  runId: number;
  runAttempt: number;
  uid: string;
  canonical: string;
  proofs: WebTagCreationProof[];
};
export async function runWebTagAdmission(mode: string | undefined) {
  if (
    ![
      '--capture',
      '--record-candidate',
      '--retire-after-paused',
      '--verify-admission',
      '--record-resume',
    ].includes(mode ?? '')
  )
    throw new Error('Invalid admission mode');
  verifyAdmissionContext(process.env);
  const source = process.env.OWNER_TAG_RELEASE_SOURCE ?? '';
  const runId = Number(process.env.GITHUB_RUN_ID),
    runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !Number.isSafeInteger(runId) ||
    !Number.isSafeInteger(runAttempt) ||
    `${runId}-${runAttempt}`.length > 21
  )
    throw new Error('Unbounded release identity');
  if (!process.env.RUNNER_TEMP || !process.env.OWNER_TAG_MANIFEST_PATH)
    throw new Error('Missing protected release files');
  const temp = resolve(process.env.RUNNER_TEMP),
    manifestPath = resolve(process.env.OWNER_TAG_MANIFEST_PATH);
  if (dirname(manifestPath) !== temp)
    throw new Error('Release manifest outside protected temporary directory');
  const manifestBytes = boundedFile(manifestPath),
    manifest = rec(JSON.parse(manifestBytes.toString('utf8')));
  const verifiedManifest = parseWebManifest(manifestBytes);
  const manifestDigest = manifest.manifestDigest;
  const unsigned = { ...manifest };
  delete unsigned.manifestDigest;
  const image = rec(rec(manifest.components).web).image;
  if (
    verifiedManifest.release !== source ||
    manifest.format !== 1 ||
    manifest.release !== source ||
    manifest.storageDriver !== 'firestore' ||
    !Array.isArray(manifest.selected) ||
    !manifest.selected.includes('web') ||
    !manifest.selected.includes('agent') ||
    manifestDigest !== hash(JSON.stringify(unsigned)) ||
    manifestDigest !== process.env.OWNER_TAG_MANIFEST_DIGEST ||
    typeof image !== 'string' ||
    !/^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/.test(image)
  )
    throw new Error('Unverified paired release manifest');
  const path = (name: string) => resolve(temp, name);
  const capturePath = path('owner-web-tag-capture.json'),
    creationPath = path('owner-web-tag-creation.json'),
    barrierPath = path('owner-web-tag-barrier.json');
  const save = (target: string, value: unknown, replace = false) => {
    const bytes = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Admission receipt exceeds bound');
    if (replace) {
      const next = `${target}.next`;
      writeFileSync(next, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(next, target);
    } else writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  };
  const io = await protectedWebTagCloud();
  const artifactCache = new Map<string, Awaited<ReturnType<typeof readProtectedWebTagArtifact>>>();
  async function priorProof(
    revision: string,
    tag: string,
    rows: ReturnType<typeof webTagTrafficSnapshot>['rows'],
  ) {
    const native = await io.readRevision(revision);
    const live = rows.filter((row) => row.tag === tag);
    if (live.length > 1) throw new Error('Ambiguous prior alias');
    const fixed = HISTORICAL_WEB_TAGS.find(
      (proof) => proof.revision === revision && proof.tag === tag,
    );
    if (fixed) {
      immutableWebRevision(native, fixed.revision, fixed.image, fixed.writesPaused);
      if (
        live.length &&
        (live[0]?.revision !== revision || !live[0].uri || tagHash(live[0].uri) !== fixed.uriSha256)
      )
        throw new Error('Historical alias identity changed');
      return { ...fixed, legacyBarrierCompleted: false, nativeTagObserved: live.length === 1 };
    }
    const match = /^(candidate|resume)-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(tag);
    if (!match) throw new Error('Unknown operator alias blocks admission');
    const priorRun = Number(match[2]),
      priorAttempt = Number(match[3]);
    const cacheKey = `${priorRun}-${priorAttempt}`;
    let artifact = artifactCache.get(cacheKey);
    if (!artifact) {
      artifact = await readProtectedWebTagArtifact(priorRun, priorAttempt);
      artifactCache.set(cacheKey, artifact);
    }
    const { runMetadata: run, artifactMetadata: metadata, archiveBytes } = artifact;
    const workflowRun = rec(metadata.workflow_run);
    const extracted = extractCreationArchive(archiveBytes);
    const proof = resolveProtectedOwnedWebTag({
      runMetadata: {
        repository: rec(run.repository).full_name,
        headRepository: rec(run.head_repository).full_name,
        workflowPath: run.path,
        headBranch: run.head_branch,
        event: run.event,
        runId: run.id,
        runAttempt: run.run_attempt,
        headSha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion,
      },
      artifactMetadata: {
        name: metadata.name,
        digest: metadata.digest,
        sizeInBytes: metadata.size_in_bytes,
        expired: metadata.expired,
        workflowRun: { id: workflowRun.id, headSha: workflowRun.head_sha },
      },
      archiveBytes,
      ...extracted,
      nativeWebRevision: native,
      expectedKind: match[1] as 'candidate' | 'resume',
      serviceTagObservation: live[0]
        ? { status: 'present', service: WEB_SERVICE, ...live[0], tag, uri: live[0].uri ?? '' }
        : { status: 'absent', service: WEB_SERVICE, tag },
    });
    if (proof.revision !== revision)
      throw new Error('Prior immutable revision differs from creation receipt');
    return proof;
  }
  const readCapture = () => {
    const raw = rec(JSON.parse(boundedFile(capturePath, 64 * 1024).toString('utf8')));
    if (
      raw.format !== 1 ||
      raw.source !== source ||
      raw.runId !== runId ||
      raw.runAttempt !== runAttempt ||
      typeof raw.uid !== 'string' ||
      typeof raw.canonical !== 'string' ||
      !Array.isArray(raw.proofs) ||
      raw.proofs.length < 1 ||
      raw.proofs.length > 8
    )
      throw new Error('Invalid captured release identity');
    const proofs = raw.proofs.map((item) => {
      const p = rec(item);
      if (typeof p.legacyBarrierCompleted !== 'boolean' || typeof p.nativeTagObserved !== 'boolean')
        throw new Error('Invalid captured proof');
      return {
        ...validateOwnedProof(p),
        legacyBarrierCompleted: p.legacyBarrierCompleted,
        nativeTagObserved: p.nativeTagObserved,
      };
    });
    return { ...raw, proofs } as Capture;
  };
  if (mode === '--capture') {
    const snapshot = webTagTrafficSnapshot(await io.readService());
    const canonical = snapshot.rows.filter((row) => row.percent === 100);
    if (
      canonical.length !== 1 ||
      snapshot.rows.some((row) => row.percent > 0 && row !== canonical[0])
    )
      throw new Error('Prior canonical traffic is ambiguous');
    const current = canonical[0];
    if (!current) throw new Error('Missing prior canonical');
    const proofs: WebTagCreationProof[] = [];
    for (const row of snapshot.rows) {
      if (row.tag) proofs.push(await priorProof(row.revision, row.tag, snapshot.rows));
      else if (row.percent !== 100) throw new Error('Unknown untagged historical target');
    }
    if (!current.tag) {
      const fixed = HISTORICAL_WEB_TAGS.find((proof) => proof.revision === current.revision);
      if (fixed) {
        if (!proofs.some((proof) => proof.tag === fixed.tag))
          proofs.push(await priorProof(current.revision, fixed.tag, snapshot.rows));
      } else {
        const native = await io.readRevision(current.revision);
        const priorRun = literal(native, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID'),
          priorAttempt = literal(native, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT');
        const kind =
          literal(native, 'ASSISTANT_RELEASE_WRITES_PAUSED') === 'true' ? 'candidate' : 'resume';
        proofs.push(
          await priorProof(current.revision, `${kind}-${priorRun}-${priorAttempt}`, snapshot.rows),
        );
      }
    }
    const canonicalProof = proofs.find((proof) => proof.revision === current.revision);
    if (!canonicalProof) throw new Error('Prior canonical ownership unverified');
    if (!canonicalProof.legacyBarrierCompleted) {
      for (const fixed of HISTORICAL_WEB_TAGS)
        if (!proofs.some((proof) => proof.tag === fixed.tag))
          proofs.push(await priorProof(fixed.revision, fixed.tag, snapshot.rows));
    }
    save(capturePath, {
      format: 1,
      source,
      runId,
      runAttempt,
      uid: snapshot.uid,
      canonical: current.revision,
      proofs,
    });
    return;
  }
  const capture = readCapture();
  const service = await io.readService(),
    snapshot = webTagTrafficSnapshot(service);
  if (snapshot.uid !== capture.uid) throw new Error('Captured service identity changed');
  if (mode === '--retire-after-paused') {
    const candidate = snapshot.rows.find((row) => row.tag === process.env.OWNER_TAG_STAGING_TAG);
    if (candidate?.percent !== 100 || !candidate.uri)
      throw new Error('Paused candidate not canonical');
    const native: Record<string, unknown> = {};
    native[candidate.revision] = await io.readRevision(candidate.revision);
    const proofs = [];
    for (const old of capture.proofs) {
      const fresh = await priorProof(old.revision, old.tag, snapshot.rows);
      if (JSON.stringify(validateOwnedProof(fresh)) !== JSON.stringify(validateOwnedProof(old)))
        throw new Error('Captured ownership proof changed');
      proofs.push(fresh);
      native[fresh.revision] = await io.readRevision(fresh.revision);
    }
    const plan = planOwnedWebTagRetirement(service, native, proofs, {
      revision: candidate.revision,
      image,
      tag: candidate.tag,
      uriSha256: tagHash(candidate.uri),
      paused: true,
    });
    const result = await executeOwnedWebTagRetirement(plan, io);
    save(barrierPath, { format: 1, source, runId, runAttempt, uid: capture.uid, plan, result });
    return;
  }
  const barrier = () => {
    const value = rec(JSON.parse(boundedFile(barrierPath, 64 * 1024).toString('utf8')));
    const result = rec(value.result);
    if (
      value.format !== 1 ||
      value.source !== source ||
      value.runId !== runId ||
      value.runAttempt !== runAttempt ||
      value.uid !== snapshot.uid ||
      result.drainCompleted !== true ||
      result.drainSeconds !== 600
    )
      throw new Error('Mandatory retirement/drain barrier incomplete');
    return value.plan as RetirementPlan;
  };
  if (mode === '--verify-admission') {
    verifyOwnedWebTagRetirement(service, barrier());
    return;
  }
  const kind = mode === '--record-candidate' ? 'candidate' : 'resume';
  if (kind === 'resume') barrier();
  const tag = `${kind}-${runId}-${runAttempt}`,
    live = snapshot.rows.filter((row) => row.tag === tag);
  if (live.length !== 1 || !live[0]?.uri) throw new Error('Created alias identity unverified');
  const row = live[0],
    native = await io.readRevision(row.revision);
  if (!row.uri) throw new Error('Created alias URI missing');
  immutableWebRevision(native, row.revision, image, kind === 'candidate');
  if (
    literal(native, 'ASSISTANT_RELEASE_SOURCE_SHA') !== source ||
    literal(native, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID') !== String(runId) ||
    literal(native, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT') !== String(runAttempt)
  )
    throw new Error('Created revision source identity unverified');
  const record: WebTagCreationRecord = {
    kind,
    revision: row.revision,
    image,
    writesPaused: kind === 'candidate',
    uriSha256: tagHash(row.uri),
    legacyBarrierCompleted: kind === 'resume',
  };
  let receipt: WebTagCreationReceipt;
  if (kind === 'candidate') {
    receipt = {
      format: 1,
      runId,
      runAttempt,
      source,
      manifestSha256: hash(manifestBytes),
      records: [record],
    };
    writeFileSync(path('release-manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    save(creationPath, receipt);
  } else {
    const prior = rec(JSON.parse(boundedFile(creationPath, 32 * 1024).toString('utf8')));
    if (
      prior.source !== source ||
      prior.runId !== runId ||
      prior.runAttempt !== runAttempt ||
      prior.manifestSha256 !== hash(manifestBytes) ||
      !Array.isArray(prior.records) ||
      prior.records.length !== 1 ||
      rec(prior.records[0]).kind !== 'candidate'
    )
      throw new Error('Prior candidate creation receipt unverified');
    receipt = {
      format: 1,
      runId,
      runAttempt,
      source,
      manifestSha256: hash(manifestBytes),
      records: [prior.records[0] as WebTagCreationRecord, record],
    };
    save(creationPath, receipt, true);
  }
}
if (process.argv[1]?.endsWith('/owner-web-tag-admission.ts'))
  (process.argv.length === 3
    ? runWebTagAdmission(process.argv[2])
    : Promise.reject(new Error('Invalid admission arguments'))
  ).catch(() => {
    process.stderr.write(
      'BASIC5 web alias ownership or retirement/drain barrier stopped; admission is unapproved.\n',
    );
    process.exitCode = 1;
  });
