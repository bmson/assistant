import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as input from './owner-archived-runtime-input.js';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  SERVICE_ROOT,
} from './owner-release-current-snapshot.js';
import {
  createImageResolutionReader,
  verifyRevisionImage,
} from './owner-release-image-resolution.js';
import {
  preloadArchivedOriginalForProtectedRelease,
  recheckArchivedRestoreTargets,
  registerReviewedArchivedOriginal,
} from './owner-restore-target-verify.js';
import { protectedWebTagCloud } from './owner-web-tag-cloud.js';

const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const host = 'us-west1-docker.pkg.dev';
const repository = 'bmson-assistant/assistant-release-recovery';
const historicalRepository = 'bmson-assistant/assistant';
const digest = (value: Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function role(role: 'agent' | 'web') {
  const bodies = [Buffer.alloc(256, 1), Buffer.alloc(4096, 2)] as const;
  const blobs = [
    {
      digest: digest(bodies[0]),
      size: bodies[0].length,
      mediaType: 'application/vnd.oci.image.config.v1+json',
    },
    {
      digest: digest(bodies[1]),
      size: bodies[1].length,
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
    },
  ];
  const child = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: manifestType,
      config: blobs[0],
      layers: blobs.slice(1),
    }),
  );
  const parent = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: manifestType,
          digest: digest(child),
          size: child.length,
          platform: { architecture: 'amd64', os: 'linux' },
        },
      ],
      annotations: { testRole: role },
    }),
  );
  const blank = Buffer.from('{}');
  const archive: ArchivedRoleEvidence = {
    parent,
    child,
    receipt: blank,
    signature: blank,
    sbom: blank,
  };
  const target = {
    image: `${host}/${repository}/${role}@${digest(child)}`,
    parent: digest(parent),
    child: digest(child),
  };
  return { archive, target, blobs, bodies };
}

function fixture(
  defect?:
    | 'manifest missing'
    | 'wrong bytes'
    | 'no manifest media type'
    | 'missing layer'
    | 'wrong blob size'
    | 'wrong blob digest'
    | 'corrupt same-size layer'
    | 'redirected layer'
    | 'relative layer'
    | 'redirect chain'
    | 'untrusted same-origin path',
) {
  const agent = role('agent');
  const web = role('web');
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const redirected = url.pathname.startsWith('/artifacts-downloads/');
    const [, version, project, repo, roleName, type, digest] = url.pathname
      .replace(/^\/artifacts-downloads\//, '/v2/bmson-assistant/assistant-release-recovery/')
      .split('/');
    expect(url.hostname).toBe(host);
    expect([version, project, repo]).toEqual([
      'v2',
      'bmson-assistant',
      'assistant-release-recovery',
    ]);
    expect(init).toMatchObject({
      cache: 'no-store',
      redirect: type === 'manifests' ? 'error' : 'manual',
      headers: { Authorization: 'Bearer fixture' },
    });
    const current = roleName === 'agent' ? agent : web;
    if (type === 'manifests') {
      expect(init?.method).toBe('GET');
      expect(digest).toBe(current.target.child);
      if (defect === 'manifest missing') return new Response(null, { status: 404 });
      const body =
        defect === 'wrong bytes'
          ? Buffer.from(current.archive.child).fill(1, 0, 1)
          : current.archive.child;
      return new Response(new Uint8Array(body), {
        headers: {
          'content-type': defect === 'no manifest media type' ? 'application/json' : manifestType,
        },
      });
    }
    expect(type).toBe('blobs');
    expect(init?.method).toBe('GET');
    const index = current.blobs.findIndex((expected) => digest === expected.digest);
    const blob = current.blobs[index];
    if (!blob) throw new Error('Unexpected blob target');
    if (index === 1 && defect === 'missing layer') return new Response(null, { status: 404 });
    if (index === 1 && defect === 'untrusted same-origin path')
      return new Response(null, { status: 302, headers: { location: '/v2/unrelated' } });
    if (index === 1 && defect === 'redirected layer')
      return new Response(null, { status: 302, headers: { location: '//other.invalid/path' } });
    if (
      index === 1 &&
      (defect === 'relative layer' || defect === 'redirect chain') &&
      (!redirected || defect === 'redirect chain')
    )
      return new Response(null, {
        status: 302,
        headers: {
          location: `/artifacts-downloads/${roleName}/blobs/${digest}?opaque=reviewed-fixture`,
        },
      });
    const body = current.bodies[index];
    if (!body) throw new Error('Missing test blob');
    const corrupt = Buffer.from(body);
    if (index === 1 && defect === 'corrupt same-size layer') corrupt.fill(0, 0, 1);
    const bytes = new Uint8Array(corrupt);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 11));
        controller.enqueue(bytes.subarray(11));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'content-length': defect === 'wrong blob size' ? '1' : String(blob.size),
        'docker-content-digest':
          defect === 'wrong blob digest' ? `sha256:${'9'.repeat(64)}` : blob.digest,
      },
    });
  });
  const targets = { agent: agent.target, web: web.target };
  const archives = { agent: agent.archive, web: web.archive };
  const run = () => recheckArchivedRestoreTargets('fixture', targets, archives, request);
  return { targets, archives, request, run };
}

describe('uncached deployed restore-target readback', () => {
  it('reads each role manifest and every referenced blob separately on every call', async () => {
    const { run, request } = fixture();
    await expect(run()).resolves.toBeUndefined();
    await expect(run()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(12);
    expect(request.mock.calls.filter(([, options]) => options?.method === 'GET')).toHaveLength(12);
    expect(new Set(request.mock.calls.map(([url]) => url))).toHaveLength(6);
  });

  it.each([
    'manifest missing',
    'wrong bytes',
    'no manifest media type',
    'missing layer',
    'wrong blob size',
    'wrong blob digest',
    'corrupt same-size layer',
    'redirected layer',
    'redirect chain',
    'untrusted same-origin path',
  ] as const)('rejects %s', async (defect) => {
    await expect(fixture(defect).run()).rejects.toThrow('Archived restore target is unavailable');
  });

  it('verifies a same-origin relative blob redirect without skipping the checksum', async () => {
    const { request, run } = fixture('relative layer');
    await expect(run()).resolves.toBeUndefined();
    expect(request.mock.calls.filter(([url]) => String(url).includes('?opaque='))).toHaveLength(2);
    expect(request.mock.calls.every(([url]) => new URL(String(url)).hostname === host)).toBe(true);
  });

  it('does not follow a foreign blob redirect even with matching headers', async () => {
    const { request, run } = fixture('redirected layer');
    await expect(run()).rejects.toThrow('Archived restore target is unavailable');
    expect(request.mock.calls.every(([url]) => new URL(String(url)).hostname === host)).toBe(true);
  });

  it('validates the full pair before making a request', async () => {
    const { targets, request, run } = fixture();
    targets.agent.image = targets.agent.image.replace('/agent@', '/web@');
    await expect(run()).rejects.toThrow('Archived restore target is unavailable');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not make a request after deadline', async () => {
    const { targets, archives, request } = fixture();
    await expect(
      recheckArchivedRestoreTargets('fixture', targets, archives, request, Date.now() - 1),
    ).rejects.toThrow('Archived restore target is unavailable');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('explicit protected archive preload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('only the protected admission caller processes an explicitly malformed opt-in', async () => {
    const load = vi.spyOn(input, 'loadReviewedArchivedRuntimePack');
    await expect(preloadArchivedOriginalForProtectedRelease({})).resolves.toBeUndefined();
    vi.stubEnv('OWNER_RELEASE_RESTORE_TARGET_PROOF', '');
    vi.stubEnv('GITHUB_ACTIONS', 'false');
    await expect(protectedWebTagCloud()).rejects.not.toThrow(
      'Archived restore target is unavailable',
    );
    await expect(protectedWebTagCloud(undefined, 'tagged', true)).rejects.toThrow(
      'Archived restore target is unavailable',
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('validates the complete bootstrap binding before registering either archive and leaves other role digests live-only', async () => {
    const { archives, targets } = fixture();
    const basename = 'assistant-archived';
    const bindings = {} as BootstrapReceipt['services'];
    const baseline: Record<string, unknown> = {};
    for (const name of ['agent', 'web'] as const) {
      const target = targets[name];
      const uid = `fixture-${name}-uid`;
      const image = target.image
        .replace(repository, historicalRepository)
        .replace(target.child, target.parent);
      const revision = `${basename}-${name}`;
      bindings[name] = {
        uid,
        image,
        revision,
        service: SERVICE_ROOT + name,
        serviceSha256: 'c'.repeat(64),
        revisionSha256: 'd'.repeat(64),
        proof: {
          image,
          paused: false,
          source: '1c2ea3907bf17b14368846708002f9d4633f2092',
          manifest: '9ca6dcbb6a1c4b6e25ca6ea857c86ae1c3103a75d9a8e4e26af801f7b1c32647',
          runId: '44263661117',
          attempt: '1',
          uid:
            name === 'agent'
              ? '48e24460ff97eb87801e9a876bbdc5690194c65eb0a780a98e97fe828ab94d67'
              : '4ef1ecfce5e4eb4f54a7fd40c5f9b67cff9714705c355f511e98727d08ae84c9',
          templateSha256:
            name === 'agent'
              ? '53a47b948298498e031cc6a8f7acd65a53250f42266b0595d02dc7532c9c0f9a'
              : '938c1530e8b97793f94eaaa31909d9c03075fadbce2ccfca0fff9811f4fa4b5f',
        },
      };
      baseline[name] = {
        revision,
        serviceUidSha256: bootstrapDigest(uid),
        revisionUidSha256: '8'.repeat(64),
      };
    }
    const current: BootstrapReceipt = {
      format: 1,
      kind: 'disabled-bootstrap',
      source: '5'.repeat(40),
      closureReceiptSha256: '1'.repeat(64),
      drainReceiptSha256: '2'.repeat(64),
      recoveryReceiptSha256: '3'.repeat(64),
      services: bindings,
    };
    const pack = { roles: archives, nativeBinding: { format: 1, roles: baseline } };
    const rawAgentHash = '8ed6937de80a52651b1e80d3f464bb5c61149dd433c70cc0064dc3f541a01932';
    const stale = structuredClone(current);
    stale.services.agent.proof.templateSha256 = rawAgentHash;
    expect(() => registerReviewedArchivedOriginal(stale, pack)).toThrow(
      'Archived restore target is unavailable',
    );
    const drift = structuredClone(current);
    drift.services.web.uid = 'other-service-uid';
    expect(() => registerReviewedArchivedOriginal(drift, pack)).toThrow(
      'Archived restore target is unavailable',
    );

    const wrongRevision = structuredClone(current);
    wrongRevision.services.web.proof.uid = 'a'.repeat(64);
    expect(() => registerReviewedArchivedOriginal(wrongRevision, pack)).toThrow();
    const archivedAgentImage = targets.agent.image.replace(repository, historicalRepository);
    const agentStatus = { name: 'agent-1', imageDigest: archivedAgentImage };
    const agent = {
      containers: [{ name: 'agent-1', image: archivedAgentImage }],
      containerStatuses: [agentStatus],
    };
    expect(() => verifyRevisionImage(agent, bindings.agent.image)).toThrow();
    registerReviewedArchivedOriginal(current, pack);
    expect(() => verifyRevisionImage(agent, bindings.agent.image)).not.toThrow();

    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const resolve = createImageResolutionReader('fixture', request);
    await expect(resolve(bindings.agent.image)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    await expect(
      resolve(`us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'7'.repeat(64)}`),
    ).rejects.toThrow('Image content resolution failed');
    expect(request).toHaveBeenCalledOnce();
  });
});
