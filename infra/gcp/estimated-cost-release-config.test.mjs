import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimatedCostAgentArguments,
  estimatedCostNativeEnvironment,
  estimatedCostReleaseEnvironment,
  estimatedCostReleaseProfile,
  pinEstimatedCostProvider,
  requireEstimatedCostReleaseProfile,
  validateEstimatedCostReleaseInvocation,
  validateEstimatedCostReleaseProfile,
  verifyEstimatedCostProvider,
} from './estimated-cost-release-config.mjs';

const source = 'a'.repeat(40);
const now = new Date('2026-11-18T09:05:00.000Z');
const base = {
  format: 1,
  mode: 'compatible-off',
  source,
  projectId: 'test-project',
  installationId: 'test-installation',
  ownerId: 'owner',
  providerSecret: 'existing-openrouter',
  providerVersion: '31',
  reviewedAt: '2026-11-18T09:00:00.000Z',
  expiresAt: '2026-11-18T09:30:00.000Z',
};
const enabled = () => ({
  ...base,
  mode: 'enable',
  baselineReceiptSha256: 'b'.repeat(64),
  writersReceiptSha256: 'c'.repeat(64),
  drainReceiptSha256: 'd'.repeat(64),
});
const env = (secret = 'existing-openrouter') => [
  { name: 'GCP_PROJECT', value: 'test-project' },
  { name: 'ASSISTANT_WORKSPACE_ID', value: 'test-installation' },
  { name: 'FIRESTORE_AGENT_ID', value: 'owner' },
  { name: 'OPENROUTER_API_KEY', valueSource: { secretKeyRef: { secret, version: 'latest' } } },
  { name: 'OTHER_SECRET', valueSource: { secretKeyRef: { secret: 'keep', version: '7' } } },
  { name: 'UNCHANGED', value: 'keep' },
];

test('absent profile leaves legacy release input unused', () => {
  assert.equal(estimatedCostReleaseProfile(undefined), undefined);
  assert.equal(estimatedCostReleaseProfile(''), undefined);
});

test('profile binds source, target and a current bounded review window', () => {
  const result = estimatedCostReleaseProfile(JSON.stringify(base), {
    source,
    projectId: base.projectId,
    installationId: base.installationId,
    ownerId: base.ownerId,
    now,
  });
  assert.deepEqual(result, base);
  assert.ok(Object.isFrozen(result));
  for (const expected of [
    { source: 'f'.repeat(40) },
    { projectId: 'other' },
    { installationId: 'other' },
    { ownerId: 'other' },
    { now: Date.parse(base.expiresAt) },
    { now: Date.parse(base.reviewedAt) - 1 },
  ])
    assert.throws(() => validateEstimatedCostReleaseProfile(base, expected));
});

test('enable requires the exact baseline, writer and drain proof references', () => {
  assert.doesNotThrow(() => validateEstimatedCostReleaseProfile(enabled(), { now }));
  for (const key of ['baselineReceiptSha256', 'writersReceiptSha256', 'drainReceiptSha256']) {
    const profile = enabled();
    delete profile[key];
    assert.throws(() => validateEstimatedCostReleaseProfile(profile));
    assert.throws(() =>
      validateEstimatedCostReleaseProfile({ ...enabled(), [key]: ['a'.repeat(64)] }),
    );
  }
  assert.throws(() =>
    validateEstimatedCostReleaseProfile({ ...base, baselineReceiptSha256: 'b'.repeat(64) }),
  );
});

test('strict shape rejects credentials, nonnumeric secret versions and invalid times', () => {
  for (const profile of [
    null,
    [],
    {},
    { ...base, credential: 'synthetic' },
    { ...base, providerVersion: 'latest' },
    { ...base, source: [source] },
    { ...base, projectId: [base.projectId] },
    { ...base, providerSecret: 'other/project' },
    { ...base, expiresAt: '2026-11-18T09:30:00.001Z' },
    { ...base, reviewedAt: 'bad' },
  ])
    assert.throws(() => validateEstimatedCostReleaseProfile(profile));
  assert.throws(() => estimatedCostReleaseProfile('null'));
  assert.throws(() => estimatedCostReleaseProfile('{'));
  assert.throws(() => estimatedCostReleaseProfile(' '.repeat(8193)));
});

test('environment emits the exact runtime source manifest and stays off during staging', () => {
  const off = estimatedCostReleaseEnvironment(base);
  assert.equal(off.ESTIMATED_COST_APPROVAL_ENABLED, 'false');
  assert.deepEqual(JSON.parse(off.ESTIMATED_COST_PROVIDER_SOURCE_JSON), {
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1',
    installationId: base.installationId,
    projectId: base.projectId,
    secretVersion: 'projects/test-project/secrets/existing-openrouter/versions/31',
    sourceRelease: source,
  });
  assert.equal(estimatedCostReleaseEnvironment(enabled()).ESTIMATED_COST_APPROVAL_ENABLED, 'true');
});

test('pin preserves the existing identity and every unrelated entry', () => {
  for (const secret of [
    'existing-openrouter',
    'projects/test-project/secrets/existing-openrouter',
  ]) {
    const before = env(secret);
    const original = structuredClone(before);
    const after = pinEstimatedCostProvider(before, base);
    assert.deepEqual(before, original);
    assert.equal(after[3].valueSource.secretKeyRef.version, '31');
    assert.equal(after[3].valueSource.secretKeyRef.secret, secret);
    assert.deepEqual(after.slice(4), before.slice(4));
  }
  const profile = { ...base, projectNumber: '1234567890' };
  const after = pinEstimatedCostProvider(
    env('projects/1234567890/secrets/existing-openrouter'),
    profile,
  );
  assert.equal(after[3].valueSource.secretKeyRef.version, '31');
});

test('pin rejects different project, owner, installation or provider credential sources', () => {
  for (const index of [0, 1, 2]) {
    const before = env();
    before[index].value = 'other';
    assert.throws(() => pinEstimatedCostProvider(before, base));
  }
  for (const secret of [
    'new-secret',
    'projects/other/secrets/existing-openrouter',
    'projects/1234567890/secrets/existing-openrouter',
  ])
    assert.throws(() => pinEstimatedCostProvider(env(secret), base));
  const literal = env();
  literal[3] = { name: 'OPENROUTER_API_KEY', value: 'synthetic' };
  assert.throws(() => pinEstimatedCostProvider(literal, base));
  assert.throws(() => pinEstimatedCostProvider([...env(), env()[3]], base));
  assert.throws(() =>
    pinEstimatedCostProvider(
      env().filter((item) => item.name !== 'OPENROUTER_API_KEY'),
      base,
    ),
  );
});

test('readback requires actual numeric binding and exact feature environment', () => {
  const profile = enabled();
  const deployed = [
    ...pinEstimatedCostProvider(env(), profile),
    ...Object.entries(estimatedCostReleaseEnvironment(profile)).map(([name, value]) => ({
      name,
      value,
    })),
  ];
  assert.doesNotThrow(() => verifyEstimatedCostProvider(deployed, profile));
  const drifted = structuredClone(deployed);
  drifted[3].valueSource.secretKeyRef.version = 'latest';
  assert.throws(() => verifyEstimatedCostProvider(drifted, profile));
  const wrong = structuredClone(deployed);
  wrong.find((item) => item.name === 'ESTIMATED_COST_APPROVAL_ENABLED').value = 'false';
  assert.throws(() => verifyEstimatedCostProvider(wrong, profile));
});

const v1 = () => ({
  spec: {
    template: {
      spec: {
        containers: [
          {
            env: env().map((entry) =>
              entry.valueSource
                ? {
                    name: entry.name,
                    valueFrom: {
                      secretKeyRef: {
                        name: entry.valueSource.secretKeyRef.secret,
                        key: entry.valueSource.secretKeyRef.version,
                      },
                    },
                  }
                : entry,
            ),
          },
        ],
      },
    },
  },
});

test('normalizes native references without allowing ambiguous or mixed sources', () => {
  assert.deepEqual(estimatedCostNativeEnvironment(v1()), env());
  assert.deepEqual(estimatedCostNativeEnvironment({ containers: [{ env: env() }] }), env());
  const mixed = v1();
  mixed.spec.template.spec.containers[0].env[3].value = 'synthetic';
  assert.throws(() => estimatedCostNativeEnvironment(mixed));
  assert.throws(() => estimatedCostNativeEnvironment({ containers: [] }));
});

test('future releases cannot silently inherit an obsolete source manifest', () => {
  assert.doesNotThrow(() => requireEstimatedCostReleaseProfile(v1()));
  const raw = {
    containers: [
      {
        env: [
          ...env(),
          ...Object.entries(estimatedCostReleaseEnvironment(base)).map(([name, value]) => ({
            name,
            value,
          })),
        ],
      },
    ],
  };
  assert.throws(() => requireEstimatedCostReleaseProfile(raw));
  assert.doesNotThrow(() => requireEstimatedCostReleaseProfile(raw, base));
});

test('agent argument keeps JSON commas intact and pins only the existing reference', () => {
  const args = estimatedCostAgentArguments(
    v1(),
    enabled(),
    'ASSISTANT_RELEASE_WRITES_PAUSED=true,UNCHANGED=keep',
  );
  assert.equal(args.secretArgument, 'OPENROUTER_API_KEY=existing-openrouter:31');
  assert.ok(args.envArgument.startsWith('^~^'));
  const assignments = args.envArgument.slice(3).split('~');
  assert.equal(assignments.length, 4);
  assert.equal(assignments[0], 'ASSISTANT_RELEASE_WRITES_PAUSED=true');
  assert.equal(assignments[1], 'UNCHANGED=keep');
  assert.deepEqual(
    JSON.parse(assignments[3].slice('ESTIMATED_COST_PROVIDER_SOURCE_JSON='.length)),
    JSON.parse(estimatedCostReleaseEnvironment(enabled()).ESTIMATED_COST_PROVIDER_SOURCE_JSON),
  );
  for (const existing of [
    'KEY=x~OTHER=y',
    'KEY=x\nOTHER=y',
    'KEY=x,KEY=y',
    'ESTIMATED_COST_APPROVAL_ENABLED=false',
    'KEY',
  ])
    assert.throws(() => estimatedCostAgentArguments(v1(), base, existing));
});

test('a profile is accepted only by the exact protected paired main release', () => {
  const invocation = {
    IMAGE_TAG: source,
    GCP_PROJECT: base.projectId,
    RELEASE_COMPONENTS: 'agent,web',
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_SHA: source,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
  };
  assert.doesNotThrow(() =>
    validateEstimatedCostReleaseInvocation(base, invocation, now.getTime()),
  );
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'false',
    GITHUB_SHA: 'f'.repeat(40),
    RELEASE_COMPONENTS: 'web',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_EVENT_NAME: 'pull_request',
  }))
    assert.throws(() =>
      validateEstimatedCostReleaseInvocation(base, { ...invocation, [key]: value }, now.getTime()),
    );
});
