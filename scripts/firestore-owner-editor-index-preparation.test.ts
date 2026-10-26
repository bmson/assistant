import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationIdentity } from '../packages/setup/src/installation-manifest.js';
import type { CommandResult, CommandRunner } from '../packages/setup/src/runner.js';
import {
  assertActiveGcloudPrincipal,
  assertFirestoreIndexPermissions,
  assertKnownArguments,
  assertNoActiveProductionDeployRuns,
  APPROVED_SHA256,
  APPROVED_SOURCE_COMMIT,
  BASELINE_COMMIT,
  BASELINE_SHA256,
  ownerEditorIndexDelta,
  prepareOwnerEditorIndex,
  REQUIRED_FIRESTORE_PERMISSIONS,
  resolveTargetIdentity,
  validateUnconditionalPermissionGrant,
} from './firestore-owner-editor-index-preparation.js';

const identity: InstallationIdentity = {
  installationId: 'index-preparation-fixture',
  projectId: 'bmson-assistant',
  databaseId: 'assistant-production',
  region: 'us-west1',
  release: {
    commitSha: '61c74edd9c67a77814d148565fb82651c0e2091e',
    archiveDigest: 'sha256:5baaca10aa089b2eac771de7c9086317206bd937d09a89ea6e937ac945e03cd1',
  },
};
const baselineBytes = readFileSync(
  new URL('./fixtures/owner-editor-index-preparation/baseline.indexes.json', import.meta.url),
);
const approvedBytes = readFileSync(
  new URL('./fixtures/owner-editor-index-preparation/approved.indexes.json', import.meta.url),
);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type FixtureManifest = {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<Record<string, unknown>>;
  }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string }>;
};
const approved = JSON.parse(approvedBytes.toString('utf8')) as FixtureManifest;
const prefix = `projects/${identity.projectId}/databases/${identity.databaseId}/collectionGroups/`;
const principal = 'deploy@bmson-assistant.iam.gserviceaccount.com';
const databaseResource =
  '//firestore.googleapis.com/projects/bmson-assistant/databases/assistant-production';

function policyResponse(accessTuple: {
  principal: string;
  fullResourceName: string;
  permission: string;
}) {
  const direct = `serviceAccount:${accessTuple.principal}`;
  return {
    accessTuple,
    overallAccessState: 'CAN_ACCESS',
    allowPolicyExplanation: {
      allowAccessState: 'ALLOW_ACCESS_STATE_GRANTED',
      explainedPolicies: [
        {
          fullResourceName: accessTuple.fullResourceName,
          policy: { bindings: [{ role: 'roles/datastore.indexAdmin', members: [direct] }] },
          bindingExplanations: [
            {
              role: 'roles/datastore.indexAdmin',
              allowAccessState: 'ALLOW_ACCESS_STATE_GRANTED',
              rolePermission: 'ROLE_PERMISSION_INCLUDED',
              combinedMembership: { membership: 'MEMBERSHIP_MATCHED' },
              memberships: { [direct]: { membership: 'MEMBERSHIP_MATCHED' } },
            },
          ],
        },
      ],
    },
    denyPolicyExplanation: { denyAccessState: 'DENY_ACCESS_STATE_NOT_DENIED' },
  };
}

function firstPolicy(response: ReturnType<typeof policyResponse>) {
  const policy = response.allowPolicyExplanation.explainedPolicies.at(0);
  if (!policy) throw new Error('Fixture policy is missing');
  return policy;
}

function firstBinding(response: ReturnType<typeof policyResponse>) {
  const binding = firstPolicy(response).policy.bindings.at(0);
  if (!binding) throw new Error('Fixture binding is missing');
  return binding as Record<string, unknown>;
}

function firstBindingExplanation(response: ReturnType<typeof policyResponse>) {
  const explanation = firstPolicy(response).bindingExplanations.at(0);
  if (!explanation) throw new Error('Fixture binding explanation is missing');
  return explanation;
}

function listedIndexes(indexes: FixtureManifest['indexes']) {
  return indexes.map((index, position) => ({
    name: `${prefix}${index.collectionGroup}/indexes/fixture-${position}`,
    queryScope: index.queryScope,
    state: 'READY',
    fields: (() => {
      if (index.fields.some((field) => field.fieldPath === '__name__')) return index.fields;
      const vectorAt = index.fields.findIndex((field) => field.vectorConfig !== undefined);
      if (vectorAt === index.fields.length - 1 && vectorAt > 0) {
        const prefixFields = index.fields.slice(0, -1);
        return [
          ...prefixFields,
          { fieldPath: '__name__', order: prefixFields.at(-1)?.order ?? 'ASCENDING' },
          index.fields.at(-1),
        ];
      }
      return [
        ...index.fields,
        { fieldPath: '__name__', order: index.fields.at(-1)?.order ?? 'ASCENDING' },
      ];
    })(),
  }));
}

class MockFirestore implements CommandRunner {
  indexes: ReturnType<typeof listedIndexes>;
  overrides: Array<Record<string, unknown>>;
  calls: string[][] = [];
  failCreate = false;
  constructor(spec: FixtureManifest) {
    this.indexes = listedIndexes(spec.indexes);
    this.overrides = spec.fieldOverrides.map((field) => ({
      name: `${prefix}${field.collectionGroup}/fields/${field.fieldPath}`,
      indexConfig: { indexes: [] },
    }));
  }
  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    expect(command).toBe('gcloud');
    this.calls.push([...args]);
    if (
      args[0] === 'firestore' &&
      args[1] === 'indexes' &&
      args[2] === 'composite' &&
      args[3] === 'list'
    )
      return { ok: true, stdout: JSON.stringify(this.indexes), stderr: '' };
    if (
      args[0] === 'firestore' &&
      args[1] === 'indexes' &&
      args[2] === 'fields' &&
      args[3] === 'list'
    )
      return { ok: true, stdout: JSON.stringify(this.overrides), stderr: '' };
    if (
      args[0] === 'firestore' &&
      args[1] === 'indexes' &&
      args[2] === 'composite' &&
      args[3] === 'create'
    ) {
      if (this.failCreate) return { ok: false, stdout: '', stderr: 'create denied' };
      this.indexes = listedIndexes(approved.indexes);
      return { ok: true, stdout: 'created', stderr: '' };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  }
}

function baselineSpec() {
  const spec = JSON.parse(baselineBytes.toString('utf8')) as FixtureManifest;
  return spec;
}

describe('owner editor index preparation', () => {
  it('reads immutable local index fixtures that match the pinned source hashes', () => {
    expect(BASELINE_COMMIT).toBe('236a35a5e05163855c9b708414bf389d90cd15c2');
    expect(APPROVED_SOURCE_COMMIT).toBe('61c74edd9c67a77814d148565fb82651c0e2091e');
    expect(sha256(baselineBytes)).toBe(BASELINE_SHA256);
    expect(sha256(approvedBytes)).toBe(APPROVED_SHA256);
  });

  it('pins project, database, region, active principal, and accepted CLI modes', () => {
    expect(resolveTargetIdentity('bmson-assistant', 'assistant-production')).toMatchObject({
      projectId: 'bmson-assistant',
      databaseId: 'assistant-production',
      region: 'us-west1',
    });
    expect(() => resolveTargetIdentity('other-project', 'assistant-production')).toThrow(
      'pinned production',
    );
    expect(() => resolveTargetIdentity('bmson-assistant', 'other-database')).toThrow(
      'pinned production',
    );
    expect(assertKnownArguments([])).toBe('prepare');
    expect(assertKnownArguments(['--verify-source'])).toBe('--verify-source');
    expect(() => assertKnownArguments(['--verify-source', '--delete'])).toThrow(
      'Unknown command-line',
    );
    expect(() =>
      assertActiveGcloudPrincipal(
        'deployer@example.iam.gserviceaccount.com',
        'deployer@example.iam.gserviceaccount.com',
      ),
    ).not.toThrow();
    expect(() =>
      assertActiveGcloudPrincipal(
        'wrong@example.iam.gserviceaccount.com',
        'deployer@example.iam.gserviceaccount.com',
      ),
    ).toThrow('does not match');
  });

  it('pins exact source bytes and emits a single-index, zero-exemption delta', () => {
    const delta = JSON.parse(
      ownerEditorIndexDelta(baselineBytes, approvedBytes).toString('utf8'),
    ) as typeof approved;
    expect(delta.indexes).toEqual([
      approved.indexes.find((index) => index.collectionGroup === 'ownerEditorOperations'),
    ]);
    expect(delta.fieldOverrides).toEqual([]);
    expect(() =>
      ownerEditorIndexDelta(Buffer.from(`${baselineBytes.toString('utf8')} `), approvedBytes),
    ).toThrow('Pinned baseline manifest hash mismatch');
    expect(() =>
      ownerEditorIndexDelta(baselineBytes, Buffer.from(`${approvedBytes.toString('utf8')} `)),
    ).toThrow('Approved manifest hash mismatch');
  });

  it('creates only one ownerEditorOperations index, applies zero overrides, waits, checks old runs, and verifies full READY inventory', async () => {
    const runner = new MockFirestore(baselineSpec());
    const activeCheck = vi.fn(async () => {});
    const wait = vi.fn(
      async (_runner: CommandRunner, _identity: InstallationIdentity, spec: Buffer) => {
        expect(JSON.parse(spec.toString('utf8'))).toEqual(approved);
      },
    );
    await expect(
      prepareOwnerEditorIndex({
        runner,
        identity,
        baselineBytes,
        approvedBytes,
        assertPermissions: async () => {},
        assertNoActiveDeployRuns: activeCheck,
        wait,
      }),
    ).resolves.toBe('created');
    const creates = runner.calls.filter((args) => args[3] === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('--collection-group=ownerEditorOperations');
    expect(creates[0]).toContain('--query-scope=collection');
    expect(creates[0]).toContain('--field-config=field-path=ownerId,order=ascending');
    expect(creates[0]).toContain('--field-config=field-path=formIssuedAt,order=ascending');
    expect(creates[0]).toContain('--field-config=field-path=id,order=ascending');
    expect(runner.calls.some((args) => args[2] === 'fields' && args[3] === 'update')).toBe(false);
    expect(activeCheck).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('checks permissions before any Firestore inventory or create command', async () => {
    const runner = new MockFirestore(baselineSpec());
    await expect(
      prepareOwnerEditorIndex({
        runner,
        identity,
        baselineBytes,
        approvedBytes,
        assertPermissions: async () => {
          throw new Error('permission denied');
        },
        assertNoActiveDeployRuns: async () => {},
      }),
    ).rejects.toThrow('permission denied');
    expect(runner.calls).toHaveLength(0);
  });

  it('is idempotent for the exact approved union and does not issue a create', async () => {
    const runner = new MockFirestore(approved);
    const activeCheck = vi.fn(async () => {});
    const wait = vi.fn(async () => {});
    await expect(
      prepareOwnerEditorIndex({
        runner,
        identity,
        baselineBytes,
        approvedBytes,
        assertPermissions: async () => {},
        assertNoActiveDeployRuns: activeCheck,
        wait,
      }),
    ).resolves.toBe('already-ready');
    expect(runner.calls.some((args) => args[3] === 'create')).toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(activeCheck).toHaveBeenCalledTimes(1);
  });

  it('refuses inventory drift and never creates against an unexpected index set', async () => {
    const runner = new MockFirestore(baselineSpec());
    runner.indexes.push({
      name: `${prefix}unexpected/indexes/unexpected`,
      queryScope: 'COLLECTION',
      state: 'READY',
      fields: [
        { fieldPath: 'x', order: 'ASCENDING' },
        { fieldPath: '__name__', order: 'ASCENDING' },
      ],
    });
    await expect(
      prepareOwnerEditorIndex({
        runner,
        identity,
        baselineBytes,
        approvedBytes,
        assertPermissions: async () => {},
        assertNoActiveDeployRuns: async () => {},
        wait: async (
          targetRunner: CommandRunner,
          targetIdentity: InstallationIdentity,
          spec: Buffer,
        ) => {
          const { verifyConsumerIndexReadiness } = await import(
            '../packages/setup/src/consumer-index-readiness.js'
          );
          await verifyConsumerIndexReadiness(targetRunner, targetIdentity, spec);
        },
      }),
    ).rejects.toThrow('Firestore composite indexes differ');
    expect(runner.calls.some((args) => args[3] === 'create')).toBe(false);
  });

  it('blocks before create when an older deploy is queued and holds completion when one appears after READY', async () => {
    const preblocked = new MockFirestore(baselineSpec());
    await expect(
      prepareOwnerEditorIndex({
        runner: preblocked,
        identity,
        baselineBytes,
        approvedBytes,
        assertPermissions: async () => {},
        assertNoActiveDeployRuns: async () => {
          throw new Error('older deploy queued');
        },
      }),
    ).rejects.toThrow('older deploy queued');
    expect(preblocked.calls.some((args) => args[3] === 'create')).toBe(false);

    const postblocked = new MockFirestore(baselineSpec());
    const check = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('older deploy running'));
    await expect(
      prepareOwnerEditorIndex({
        runner: postblocked,
        identity,
        baselineBytes,
        approvedBytes,
        assertPermissions: async () => {},
        assertNoActiveDeployRuns: check,
        wait: async () => {},
      }),
    ).rejects.toThrow('older deploy running');
    expect(postblocked.calls.some((args) => args[3] === 'create')).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('fails closed on GitHub API errors, incomplete pagination, and active main deploys', async () => {
    const forbidden = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: forbidden as typeof fetch,
      }),
    ).rejects.toThrow('Deploy run listing failed (403)');
    const incomplete = vi.fn(async () =>
      Response.json({
        total_count: 101,
        workflow_runs: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          status: 'queued',
          head_branch: 'feature',
        })),
      }),
    );
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: incomplete as typeof fetch,
      }),
    ).rejects.toThrow('ended before every page');
    const active = vi.fn(async () =>
      Response.json({
        total_count: 1,
        workflow_runs: [{ id: 1, status: 'waiting', head_branch: 'main' }],
      }),
    );
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: active as typeof fetch,
      }),
    ).rejects.toThrow('Production deploy runs are still queued or running');
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: (async () =>
          Response.json({
            total_count: 1,
            workflow_runs: [{ id: 0, status: 'completed', head_branch: 'feature' }],
          })) as typeof fetch,
      }),
    ).rejects.toThrow('unknown status or identity');
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: (async () =>
          Response.json({
            total_count: 101,
            workflow_runs: Array.from({ length: 101 }, (_, index) => ({
              id: index + 1,
              status: 'completed',
              head_branch: 'feature',
            })),
          })) as typeof fetch,
      }),
    ).rejects.toThrow('page exceeds its count bounds');
  });

  it('paginates full deploy history and blocks waiting, requested, and pending main runs', async () => {
    const paged = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes('page=2'))
        return new Response(
          JSON.stringify({
            total_count: 3,
            workflow_runs: [{ id: 10, status: 'completed', head_branch: 'main' }],
          }),
          {
            headers: {
              link: '<https://api.github.com/repos/example/repo/actions/workflows/deploy.yml/runs?per_page=100&page=2>; rel="next"',
              'content-type': 'application/json',
            },
          },
        );
      return Response.json({
        total_count: 3,
        workflow_runs: [
          { id: 11, status: 'requested', head_branch: 'main' },
          { id: 12, status: 'pending', head_branch: 'main' },
        ],
      });
    });
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: paged as typeof fetch,
      }),
    ).rejects.toThrow('requested:11, pending:12');
    expect(paged).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate run IDs across a page boundary that could hide an unseen active run', async () => {
    const duplicateBoundary = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes('page=2'))
        return new Response(
          JSON.stringify({
            total_count: 2,
            workflow_runs: [{ id: 51, status: 'completed', head_branch: 'main' }],
          }),
          {
            headers: {
              link: '<https://api.github.com/repos/example/repo/actions/workflows/deploy.yml/runs?per_page=100&page=2>; rel="next"',
              'content-type': 'application/json',
            },
          },
        );
      return Response.json({
        total_count: 2,
        workflow_runs: [{ id: 51, status: 'completed', head_branch: 'main' }],
      });
    });
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: duplicateBoundary as typeof fetch,
      }),
    ).rejects.toThrow('duplicate run ID 51');
  });

  it('rejects pagination paths that merely end with the expected workflow route', async () => {
    const unexpectedPath = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            total_count: 2,
            workflow_runs: [{ id: 71, status: 'completed', head_branch: 'main' }],
          }),
          {
            headers: {
              link: '<https://api.github.com/other/repos/example/repo/actions/workflows/deploy.yml/runs?per_page=100&page=2>; rel="next"',
              'content-type': 'application/json',
            },
          },
        ),
    );
    await expect(
      assertNoActiveProductionDeployRuns({
        repository: 'example/repo',
        token: 'fixture',
        currentRunId: '99',
        fetcher: unexpectedPath as typeof fetch,
      }),
    ).rejects.toThrow('unexpected pagination destination');
  });

  it('requires exact direct unconditional Policy Troubleshooter grants for index and field reads', async () => {
    const sent: unknown[] = [];
    const granted = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      const request = JSON.parse(String(init?.body)) as { accessTuple: (typeof sent)[number] };
      sent.push(request.accessTuple);
      return Response.json(
        policyResponse(
          request.accessTuple as {
            principal: string;
            fullResourceName: string;
            permission: string;
          },
        ),
      );
    });
    await expect(
      assertFirestoreIndexPermissions({
        projectId: identity.projectId,
        databaseId: identity.databaseId,
        principal,
        token: 'mock-token',
        fetcher: granted as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual(
      REQUIRED_FIRESTORE_PERMISSIONS.map((permission) => ({
        principal,
        fullResourceName: databaseResource,
        permission,
      })),
    );
    expect(granted).toHaveBeenCalledTimes(3);
  });

  it('uses only documented Firestore index permissions for index and field reads', () => {
    expect(REQUIRED_FIRESTORE_PERMISSIONS).toEqual([
      'datastore.indexes.create',
      'datastore.indexes.get',
      'datastore.indexes.list',
    ]);
    const source = readFileSync('scripts/firestore-owner-editor-index-preparation.ts', 'utf8');
    expect(source).toContain('https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot');
    expect(source).not.toContain('datastore.fields.get');
    expect(source).not.toContain('datastore.fields.list');
  });

  it('rejects conditional, indirect, denied, mismatched, unknown, and incomplete policy evidence', () => {
    const access = {
      principal,
      fullResourceName: databaseResource,
      permission: 'datastore.indexes.create',
    };
    const unconditional = policyResponse(access);
    expect(() => validateUnconditionalPermissionGrant(unconditional, access)).not.toThrow();

    const conditional = structuredClone(unconditional);
    firstBinding(conditional).condition = {
      expression: 'true',
    };
    expect(() => validateUnconditionalPermissionGrant(conditional, access)).toThrow(
      'conditional binding participates',
    );

    const indirect = structuredClone(unconditional);
    firstBinding(indirect).members = ['group:admins@example.com'];
    firstBindingExplanation(indirect).memberships = {
      'group:admins@example.com': { membership: 'MEMBERSHIP_MATCHED' },
    };
    expect(() => validateUnconditionalPermissionGrant(indirect, access)).toThrow(
      'No direct unconditional',
    );

    const denied = structuredClone(unconditional);
    denied.overallAccessState = 'CANNOT_ACCESS';
    expect(() => validateUnconditionalPermissionGrant(denied, access)).toThrow(
      'denied, conditional, unknown',
    );

    const unknown = structuredClone(unconditional);
    unknown.denyPolicyExplanation.denyAccessState = 'DENY_ACCESS_STATE_UNKNOWN_INFO';
    expect(() => validateUnconditionalPermissionGrant(unknown, access)).toThrow(
      'denied, conditional, unknown',
    );

    const unrecognized = structuredClone(unconditional);
    firstBindingExplanation(unrecognized).rolePermission = 'ROLE_PERMISSION_FUTURE_VALUE';
    expect(() => validateUnconditionalPermissionGrant(unrecognized, access)).toThrow(
      'unknown rolePermission value',
    );

    const changedTuple = structuredClone(unconditional);
    changedTuple.accessTuple.permission = 'datastore.indexes.list';
    expect(() => validateUnconditionalPermissionGrant(changedTuple, access)).toThrow(
      'changed the principal/resource/permission tuple',
    );

    const incomplete = structuredClone(unconditional);
    firstPolicy(incomplete).bindingExplanations = [];
    expect(() => validateUnconditionalPermissionGrant(incomplete, access)).toThrow(
      'policy/binding explanations are incomplete',
    );
  });

  it('fails closed when Policy Troubleshooter is unavailable or its principal is not the deploy service account', async () => {
    await expect(
      assertFirestoreIndexPermissions({
        projectId: identity.projectId,
        databaseId: identity.databaseId,
        principal,
        token: 'mock-token',
        fetcher: (async () => new Response('forbidden', { status: 403 })) as typeof fetch,
      }),
    ).rejects.toThrow('Firestore policy preflight failed');
    await expect(
      assertFirestoreIndexPermissions({
        projectId: identity.projectId,
        databaseId: identity.databaseId,
        principal: 'wrong@example.com',
        token: 'mock-token',
        fetcher: vi.fn() as typeof fetch,
      }),
    ).rejects.toThrow('not a service account email');
  });

  it('uses manual trusted-main WIF with narrow repository permissions and no deployment identity fallback', () => {
    const workflow = readFileSync('.github/workflows/prepare-owner-editor-index.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("github.ref == 'refs/heads/main' && github.run_attempt == 1");
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('FIRESTORE_DATABASE_ID: assistant-production');
    expect(workflow).not.toContain('inputs.firestore_database_id');
    expect(workflow).toContain('group: production-deploy');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('GCP_DEPLOY_SERVICE_ACCOUNT');
    expect(workflow).toContain(
      'pnpm exec tsx scripts/firestore-owner-editor-index-preparation.ts --verify-source',
    );
    expect(workflow).toContain('ref: 61c74edd9c67a77814d148565fb82651c0e2091e');
    expect(workflow).toContain('path: .approved-index-source');
    expect(workflow).toContain('APPROVED_SOURCE_DIR: .approved-index-source');
    expect(workflow).not.toContain('GCP_FIRESTORE_INDEX_SERVICE_ACCOUNT');
    expect(workflow).not.toContain('roles/');
    expect(workflow).not.toContain('iam.serviceAccounts');
    expect(
      workflow.indexOf('Verify pinned manifest provenance before cloud authentication'),
    ).toBeLessThan(workflow.indexOf('Authenticate with the existing production identity'));
  });
});
