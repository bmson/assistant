/** Unwired raw-response projection. No IO, credentials or supplied-proof acceptance. */

import {
  type Context,
  type NativeProof,
  type Row,
  releaseIdentity,
  type Snapshot,
} from './owner-web-release-lifecycle-model.js';
import {
  HISTORICAL_WEB_TAGS,
  immutableWebRevision,
  tagHash,
  WEB_SERVICE,
} from './owner-web-tag-retirement.js';
import { reconciliationDigest as digest } from './owner-web-traffic-reconciliation-model.js';

type Obj = Record<string, unknown>;
export function requireNative(value: unknown): asserts value {
  if (!value) throw new Error('Native release validation held');
}
export function nativeObject(v: unknown): Obj {
  requireNative(v && typeof v === 'object' && !Array.isArray(v));
  return v as Obj;
}
function text(v: unknown, re: RegExp): string {
  requireNative(typeof v === 'string' && re.test(v));
  return v;
}
export function nativeRevisionName(v: unknown) {
  const name = text(v, /^[A-Za-z0-9/_-]{1,512}$/);
  return text(
    name.startsWith(`${WEB_SERVICE}/revisions/`)
      ? name.slice(`${WEB_SERVICE}/revisions/`.length)
      : name,
    /^assistant-web-[a-z0-9-]{1,49}$/,
  );
}
export const TEMPLATE_FIELDS = [
  'revision',
  'labels',
  'annotations',
  'scaling',
  'vpcAccess',
  'timeout',
  'serviceAccount',
  'containers',
  'volumes',
  'executionEnvironment',
  'encryptionKey',
  'maxInstanceRequestConcurrency',
  'serviceMesh',
  'encryptionKeyRevocationAction',
  'encryptionKeyShutdownDuration',
  'sessionAffinity',
  'healthCheckDisabled',
  'nodeSelector',
  'client',
  'clientVersion',
  'gpuZonalRedundancyDisabled',
] as const;
function template(value: unknown): Obj {
  const t = nativeObject(value);
  requireNative(Object.keys(t).every((k) => (TEMPLATE_FIELDS as readonly string[]).includes(k)));
  return t;
}
function environment(r: Obj): Record<string, string> {
  const containers = r.containers;
  requireNative(Array.isArray(containers) && containers.length === 1);
  const env = nativeObject(containers[0]).env;
  requireNative(Array.isArray(env) && env.length <= 256);
  const result: Record<string, string> = {},
    seen = new Set<string>();
  for (const e of env) {
    const entry = nativeObject(e),
      name = text(entry.name, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    requireNative(!seen.has(name));
    seen.add(name);
    if (name.startsWith('ASSISTANT_RELEASE_')) {
      requireNative(Object.keys(entry).sort().join(',') === 'name,value');
      result[name] = text(entry.value, /^[A-Za-z0-9_.:-]{1,128}$/);
    }
  }
  return result;
}
function revisionProof(raw: unknown, name: string, c: Context): NativeProof {
  const r = nativeObject(raw);
  const conditions = r.conditions;
  requireNative(Array.isArray(conditions) && conditions.length > 0 && conditions.length <= 16);
  const ready = conditions.map(nativeObject).filter((c) => c.type === 'Ready');
  requireNative(conditions.every((c) => nativeObject(c).state === 'CONDITION_SUCCEEDED'));
  requireNative(
    r.name === `${WEB_SERVICE}/revisions/${name}` &&
      r.service === WEB_SERVICE &&
      ready.length === 1 &&
      ready[0]?.state === 'CONDITION_SUCCEEDED' &&
      (r.reconciling === undefined || r.reconciling === false),
  );
  const uid = text(r.uid, /^[A-Za-z0-9-]{1,128}$/),
    env = environment(r),
    pin = HISTORICAL_WEB_TAGS.find((p) => p.revision === name && p.revision === c.canonical);
  let image: string,
    source: string,
    runId: string,
    attempt: string,
    manifest: string,
    paused: boolean;
  if (pin) {
    image = pin.image;
    source = pin.source;
    const parts = pin.tag.split('-');
    runId = parts[1] ?? '';
    attempt = parts[2] ?? '';
    paused = pin.writesPaused;
    manifest = text(env.ASSISTANT_RELEASE_MANIFEST, /^[a-f0-9]{64}$/);
    requireNative(!env.ASSISTANT_RELEASE_SOURCE_SHA || env.ASSISTANT_RELEASE_SOURCE_SHA === source);
    requireNative(
      !env.ASSISTANT_RELEASE_WORKFLOW_RUN_ID || env.ASSISTANT_RELEASE_WORKFLOW_RUN_ID === runId,
    );
    requireNative(
      !env.ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT ||
        env.ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT === attempt,
    );
  } else {
    const role =
      name === releaseIdentity(c, 'P').revision
        ? 'P'
        : name === releaseIdentity(c, 'R').revision
          ? 'R'
          : null;
    requireNative(role);
    image = c.image;
    source = c.source;
    runId = c.runId;
    attempt = c.attempt;
    manifest = c.manifest;
    paused = role === 'P';
    for (const [key, value] of Object.entries(c.releaseEnv)) requireNative(env[key] === value);
  }
  requireNative(env.ASSISTANT_RELEASE_WRITES_PAUSED === String(paused));
  immutableWebRevision(r, name, image, paused);
  const projected: Obj = {};
  for (const key of TEMPLATE_FIELDS)
    if (key !== 'revision' && r[key] !== undefined) projected[key] = r[key];
  projected.revision = name;
  return {
    uid: tagHash(uid),
    image,
    source,
    runId,
    attempt,
    manifest,
    paused,
    templateSha256: digest(template(projected)),
  };
}
function uri(v: unknown): string {
  const value = text(v, /^https:\/\/[^\s]{1,512}$/),
    u = new URL(value);
  requireNative(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash &&
      /^(?:[a-z][a-z0-9-]{0,62}---)?assistant-web-[a-z0-9]+-uw\.a\.run\.app$/.test(u.hostname),
  );
  return value;
}
function traffic(v: unknown, status: boolean): Row[] {
  requireNative(Array.isArray(v) && v.length > 0 && v.length <= 8);
  return v.map((value) => {
    const r = nativeObject(value);
    requireNative(
      Object.keys(r).every((k) =>
        ['type', 'revision', 'percent', 'tag', ...(status ? ['uri'] : [])].includes(k),
      ),
    );
    requireNative(r.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION');
    const percent = r.percent === undefined ? 0 : r.percent;
    requireNative(percent === 0 || percent === 100);
    return {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: nativeRevisionName(r.revision),
      tag:
        r.tag === undefined
          ? ''
          : text(r.tag, /^(candidate|resume)-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/),
      percent,
    };
  });
}
const OUTPUT = new Set([
  'name',
  'uid',
  'generation',
  'observedGeneration',
  'createTime',
  'updateTime',
  'deleteTime',
  'expireTime',
  'creator',
  'lastModifier',
  'conditions',
  'terminalCondition',
  'latestReadyRevision',
  'latestCreatedRevision',
  'traffic',
  'trafficStatuses',
  'uri',
  'urls',
  'reconciling',
  'etag',
  'template',
]);
/** Full native revisions are consumed here; external hashes/booleans are never accepted. */
function projectSnapshot(raw: unknown, native: Record<string, unknown>, c: Context): Snapshot {
  const s = nativeObject(raw);
  requireNative(
    s.name === WEB_SERVICE &&
      (s.reconciling === undefined || s.reconciling === false) &&
      nativeObject(s.terminalCondition).state === 'CONDITION_SUCCEEDED' &&
      s.deleteTime === undefined &&
      s.expireTime === undefined,
  );
  const desired = traffic(s.traffic, false),
    observed = traffic(s.trafficStatuses, true),
    root = uri(s.uri),
    rawRows = s.trafficStatuses as unknown[],
    tagUris: Record<string, string> = {};
  requireNative(/^assistant-web-[a-z0-9]+-uw\.a\.run\.app$/.test(new URL(root).hostname));
  for (let i = 0; i < observed.length; i++) {
    const row = observed[i];
    requireNative(row);
    if (row.tag) {
      const address = uri(nativeObject(rawRows[i]).uri);
      requireNative(
        new URL(address).hostname === `${row.tag}---${new URL(root).hostname}` &&
          !Object.hasOwn(tagUris, row.tag),
      );
      const pin = HISTORICAL_WEB_TAGS.find((p) => p.tag === row.tag);
      if (pin) requireNative(pin.revision === row.revision && tagHash(address) === pin.uriSha256);
      tagUris[row.tag] = tagHash(address);
    }
  }
  const known = [c.canonical, releaseIdentity(c, 'P').revision, releaseIdentity(c, 'R').revision];
  requireNative(
    Object.keys(native).length > 0 &&
      Object.keys(native).length <= 3 &&
      Object.keys(native).every((n) => known.includes(n)),
  );
  const revisions = Object.fromEntries(
    Object.entries(native).map(([name, value]) => [name, revisionProof(value, name, c)]),
  );
  requireNative(Array.isArray(s.urls) && s.urls.length <= 9);
  const urls = s.urls.map((v) => tagHash(uri(v))),
    t = template(s.template),
    latestReady = nativeRevisionName(s.latestReadyRevision),
    latestCreated = nativeRevisionName(s.latestCreatedRevision);
  requireNative(
    latestReady === latestCreated &&
      revisions[latestReady] &&
      revisions[latestReady]?.templateSha256 === digest(t),
  );
  const generation = text(s.generation, /^[1-9][0-9]{0,18}$/);
  requireNative(generation === s.observedGeneration);
  return {
    name: WEB_SERVICE,
    uid: text(s.uid, /^[A-Za-z0-9-]{1,128}$/),
    etag: text(s.etag, /^[ -~]{1,512}$/),
    generation,
    observedGeneration: generation,
    reconciling: false,
    succeeded: true,
    desired,
    observed,
    latestReady,
    latestCreated,
    template: t,
    stableConfigSha256: digest(
      Object.fromEntries(Object.entries(s).filter(([k]) => !OUTPUT.has(k))),
    ),
    rootUriSha256: tagHash(root),
    tagUris,
    urls,
    revisions,
  };
}

/** Public converter never exposes parser/URL errors or native payload in its exception. */
export function projectNativeWebSnapshot(
  raw: unknown,
  native: Record<string, unknown>,
  context: Context,
): Snapshot {
  try {
    return projectSnapshot(raw, native, context);
  } catch {
    throw new Error('Native release validation held');
  }
}
