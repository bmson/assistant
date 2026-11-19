import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';
import { verifyArchivedRuntimeProvenance } from './owner-archived-runtime-provenance.js';

const { makeTemp, runVerifier } = vi.hoisted(() => ({
  makeTemp: vi.fn(),
  runVerifier: vi.fn(),
}));

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdtemp: makeTemp,
}));

vi.mock('node:child_process', () => ({ execFile: runVerifier }));

const source = '1c2ea3907bf17b14368846708002f9d4633f2092';
const parents = {
  agent: 'sha256:1298263587c4021246c7a4832e174ea95bb5a5a2ffef8359b989ba60d694690b',
  web: 'sha256:34d027a7e04daf667428d615f60fb537b5090caf785a3c4f65db0a714b42eb0a',
};

function roleEvidence(
  role: keyof typeof parents,
  overrides: Record<string, unknown> = {},
): ArchivedRoleEvidence {
  const unrelated = Buffer.from('{}');
  return {
    parent: unrelated,
    child: unrelated,
    signature: unrelated,
    sbom: unrelated,
    receipt: Buffer.from(
      JSON.stringify({
        format: 1,
        source,
        workflowSha: source,
        workflowRef: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
        image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}`,
        registryManifestDigest: parents[role],
        runId: '44263661117',
        runAttempt: '1',
        ...overrides,
      }),
    ),
  };
}

async function rejectsWithoutEffects(
  roles: Record<'agent' | 'web', ArchivedRoleEvidence>,
  reason: string,
) {
  await expect(verifyArchivedRuntimeProvenance(roles, Buffer.from('{}'))).rejects.toThrow(reason);
  expect(makeTemp).not.toHaveBeenCalled();
  expect(runVerifier).not.toHaveBeenCalled();
}

describe('archived original runtime provenance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an unpinned replacement trust root before using the local verifier', async () => {
    await rejectsWithoutEffects(
      { agent: roleEvidence('agent'), web: roleEvidence('web') },
      'trust root digest mismatch',
    );
  });

  it('rejects a valid-looking receipt moved from the other component', async () => {
    await rejectsWithoutEffects(
      { agent: roleEvidence('web'), web: roleEvidence('web') },
      'agent build receipt identity mismatch',
    );
  });

  it.each([
    { source: 'a'.repeat(40) },
    { workflowSha: 'b'.repeat(40) },
    { workflowRef: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/other' },
    { runId: '44263661118' },
    { runAttempt: '2' },
    { registryManifestDigest: parents.agent },
  ])('rejects replacement identity data before any side effects (%j)', async (override) => {
    await rejectsWithoutEffects(
      { agent: roleEvidence('agent'), web: roleEvidence('web', override) },
      'web build receipt identity mismatch',
    );
  });
});
