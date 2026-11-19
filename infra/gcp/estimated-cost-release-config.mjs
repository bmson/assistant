import { pathToFileURL } from 'node:url';

/** Nonsecret release configuration. External proof verification belongs to the
 * protected operator; this module only validates and applies the bounded delta. */
const HASH = /^[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[1-9][0-9]*$/;
const keys = [
  'format',
  'mode',
  'source',
  'projectId',
  'installationId',
  'ownerId',
  'providerSecret',
  'providerVersion',
  'reviewedAt',
  'expiresAt',
];
const proofs = ['baselineReceiptSha256', 'writersReceiptSha256', 'drainReceiptSha256'];
function requireConfig(value) {
  if (!value) throw new Error('Invalid estimated cost release configuration');
}
function time(value) {
  requireConfig(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
  return Date.parse(value);
}

export function validateEstimatedCostReleaseProfile(profile, expected = {}) {
  requireConfig(profile && typeof profile === 'object' && !Array.isArray(profile));
  const enabled = profile.mode === 'enable';
  const expectedKeys = [
    ...keys,
    ...(profile.projectNumber === undefined ? [] : ['projectNumber']),
    ...(enabled ? proofs : []),
  ].sort();
  requireConfig(JSON.stringify(Object.keys(profile).sort()) === JSON.stringify(expectedKeys));
  requireConfig(profile.format === 1 && ['compatible-off', 'enable'].includes(profile.mode));
  requireConfig(typeof profile.source === 'string' && SOURCE.test(profile.source));
  requireConfig(
    [profile.projectId, profile.installationId].every(
      (value) => typeof value === 'string' && ID.test(value),
    ),
  );
  requireConfig(
    typeof profile.ownerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(profile.ownerId),
  );
  requireConfig(
    typeof profile.providerSecret === 'string' &&
      /^[A-Za-z0-9_-]{1,255}$/.test(profile.providerSecret),
  );
  requireConfig(
    typeof profile.providerVersion === 'string' && VERSION.test(profile.providerVersion),
  );
  if (profile.projectNumber !== undefined)
    requireConfig(
      typeof profile.projectNumber === 'string' && /^[0-9]{6,30}$/.test(profile.projectNumber),
    );
  const reviewed = time(profile.reviewedAt),
    expires = time(profile.expiresAt);
  requireConfig(expires > reviewed && expires - reviewed <= 30 * 60 * 1000);
  if (enabled)
    for (const key of proofs)
      requireConfig(typeof profile[key] === 'string' && HASH.test(profile[key]));
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'now') {
      const now = value instanceof Date ? value.getTime() : value;
      requireConfig(Number.isFinite(now) && reviewed <= now && now < expires);
    } else requireConfig(profile[key] === value);
  }
  return profile;
}

export function estimatedCostReleaseProfile(raw, expected = {}) {
  if (raw === undefined || raw === '') return undefined;
  requireConfig(typeof raw === 'string' && raw.length <= 8192);
  let profile;
  try {
    profile = JSON.parse(raw);
  } catch {
    throw new Error('Invalid estimated cost release configuration');
  }
  validateEstimatedCostReleaseProfile(profile, expected);
  return Object.freeze({ ...profile });
}

export function estimatedCostReleaseEnvironment(profile) {
  validateEstimatedCostReleaseProfile(profile);
  return {
    ESTIMATED_COST_APPROVAL_ENABLED: String(profile.mode === 'enable'),
    ESTIMATED_COST_PROVIDER_SOURCE_JSON: JSON.stringify({
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      installationId: profile.installationId,
      projectId: profile.projectId,
      secretVersion: `projects/${profile.projectId}/secrets/${profile.providerSecret}/versions/${profile.providerVersion}`,
      sourceRelease: profile.source,
    }),
  };
}

/** Preserve the existing secret identity and every unrelated setting; only its
 * numeric version may change. Credentials never enter this profile or output. */
export function pinEstimatedCostProvider(env, profile) {
  validateEstimatedCostReleaseProfile(profile);
  requireConfig(Array.isArray(env) && env.length <= 256);
  const names = env.map((entry) => entry?.name);
  requireConfig(
    names.every((name) => typeof name === 'string') && new Set(names).size === names.length,
  );
  const literal = (name) => {
    const entry = env.find((entry) => entry.name === name);
    requireConfig(entry && Object.keys(entry).sort().join(',') === 'name,value');
    return entry.value;
  };
  requireConfig(literal('GCP_PROJECT') === profile.projectId);
  requireConfig(literal('ASSISTANT_WORKSPACE_ID') === profile.installationId);
  requireConfig(literal('FIRESTORE_AGENT_ID') === profile.ownerId);
  const entry = env.find((entry) => entry.name === 'OPENROUTER_API_KEY');
  requireConfig(entry && Object.keys(entry).sort().join(',') === 'name,valueSource');
  requireConfig(entry.valueSource && Object.keys(entry.valueSource).join(',') === 'secretKeyRef');
  const reference = entry.valueSource.secretKeyRef;
  requireConfig(reference && Object.keys(reference).sort().join(',') === 'secret,version');
  const allowed = [
    profile.providerSecret,
    `projects/${profile.projectId}/secrets/${profile.providerSecret}`,
  ];
  if (profile.projectNumber)
    allowed.push(`projects/${profile.projectNumber}/secrets/${profile.providerSecret}`);
  requireConfig(allowed.includes(reference.secret));
  requireConfig(
    reference.version === 'latest' ||
      (typeof reference.version === 'string' && VERSION.test(reference.version)),
  );
  return env.map((item) =>
    item === entry
      ? {
          ...entry,
          valueSource: { secretKeyRef: { ...reference, version: profile.providerVersion } },
        }
      : item,
  );
}

export function verifyEstimatedCostProvider(env, profile) {
  const pinned = pinEstimatedCostProvider(env, profile);
  requireConfig(JSON.stringify(pinned) === JSON.stringify(env));
  const expected = estimatedCostReleaseEnvironment(profile);
  for (const [key, value] of Object.entries(expected)) {
    const item = env.find((item) => item.name === key);
    requireConfig(
      item && Object.keys(item).sort().join(',') === 'name,value' && item.value === value,
    );
  }
}

/** Normalize only the documented v1/v2 native environment representations.
 * This reads references, never Secret Manager payloads. */
export function estimatedCostNativeEnvironment(raw) {
  requireConfig(raw && typeof raw === 'object' && !Array.isArray(raw));
  const representations = [
    raw.containers,
    raw.template?.containers,
    raw.spec?.containers,
    raw.spec?.template?.spec?.containers,
  ].filter((value) => value !== undefined);
  requireConfig(representations.length === 1);
  const containers = representations[0];
  requireConfig(Array.isArray(containers) && containers.length === 1);
  const env = containers[0]?.env;
  requireConfig(Array.isArray(env) && env.length <= 256);
  return env.map((entry) => {
    requireConfig(entry && typeof entry === 'object' && typeof entry.name === 'string');
    if (entry.valueFrom !== undefined) {
      requireConfig(Object.keys(entry).sort().join(',') === 'name,valueFrom');
      requireConfig(Object.keys(entry.valueFrom ?? {}).join(',') === 'secretKeyRef');
      const reference = entry.valueFrom.secretKeyRef;
      requireConfig(reference && Object.keys(reference).sort().join(',') === 'key,name');
      return {
        name: entry.name,
        valueSource: { secretKeyRef: { secret: reference.name, version: reference.key } },
      };
    }
    return entry;
  });
}

/** An existing source-bound manifest must be deliberately refreshed on every
 * paired deployment, including a compatible OFF deployment. */
export function requireEstimatedCostReleaseProfile(raw, profile) {
  const env = estimatedCostNativeEnvironment(raw);
  const names = env.map((entry) => entry.name);
  requireConfig(new Set(names).size === names.length);
  if (
    !profile &&
    env.some(
      (entry) =>
        (entry.name === 'ESTIMATED_COST_APPROVAL_ENABLED' && entry.value !== 'false') ||
        (entry.name === 'ESTIMATED_COST_PROVIDER_SOURCE_JSON' && entry.value !== ''),
    )
  )
    throw new Error('A source-bound estimated cost release profile is required');
  if (profile) pinEstimatedCostProvider(env, profile);
}

/** Use a delimiter excluded by every validated profile field. JSON commas are
 * data, and must never become additional gcloud environment assignments. */
export function estimatedCostAgentArguments(raw, profile, existingAssignments) {
  validateEstimatedCostReleaseProfile(profile);
  requireConfig(
    typeof existingAssignments === 'string' &&
      existingAssignments.length <= 8192 &&
      !/[~\r\n]/.test(existingAssignments),
  );
  const assignments = existingAssignments.split(',');
  const names = assignments.map((entry) => entry.split('=')[0]);
  requireConfig(
    assignments.every((entry) => /^[A-Z][A-Z0-9_]*=[^,~\r\n]+$/.test(entry)) &&
      new Set(names).size === names.length &&
      !names.some((name) => name.startsWith('ESTIMATED_COST_')),
  );
  const pinned = pinEstimatedCostProvider(estimatedCostNativeEnvironment(raw), profile);
  const reference = pinned.find((entry) => entry.name === 'OPENROUTER_API_KEY').valueSource
    .secretKeyRef;
  assignments.push(
    ...Object.entries(estimatedCostReleaseEnvironment(profile)).map(
      ([name, value]) => `${name}=${value}`,
    ),
  );
  return {
    envArgument: `^~^${assignments.join('~')}`,
    secretArgument: `OPENROUTER_API_KEY=${reference.secret}:${reference.version}`,
  };
}

export function validateEstimatedCostReleaseInvocation(profile, env, now = Date.now()) {
  if (!profile) return;
  validateEstimatedCostReleaseProfile(profile, {
    source: env.IMAGE_TAG,
    projectId: env.GCP_PROJECT,
    now,
  });
  requireConfig(
    env.RELEASE_COMPONENTS === 'agent,web' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === 'bmson/assistant' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_WORKFLOW_REF === 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main' &&
      env.GITHUB_WORKFLOW_SHA === profile.source &&
      env.GITHUB_SHA === profile.source &&
      ['workflow_run', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) &&
      /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') &&
      env.GITHUB_RUN_ATTEMPT === '1',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Protected release input, outside Turbo tasks.
    const profile = estimatedCostReleaseProfile(process.env.ESTIMATED_COST_RELEASE_PROFILE_JSON);
    const mode = process.argv[2];
    if (mode === '--preflight') validateEstimatedCostReleaseInvocation(profile, process.env);
    else {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        requireConfig(Buffer.byteLength(input) <= 2 * 1024 * 1024);
      }
      const raw = JSON.parse(input);
      if (mode === '--require-profile') requireEstimatedCostReleaseProfile(raw, profile);
      else if (mode === '--agent-plan') {
        validateEstimatedCostReleaseInvocation(profile, process.env);
        requireConfig(profile);
        process.stdout.write(
          JSON.stringify(estimatedCostAgentArguments(raw, profile, process.argv[3])),
        );
      } else if (mode === '--verify-revision') {
        requireConfig(profile);
        verifyEstimatedCostProvider(estimatedCostNativeEnvironment(raw), profile);
      } else throw new Error('Invalid estimated cost release mode');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
