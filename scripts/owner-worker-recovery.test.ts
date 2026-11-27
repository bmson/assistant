import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  nativeWorkers,
  preflightWorkers,
  transitionWorker,
  verifyWorkerGraph,
  WorkerAdvanceRejected,
  WorkerObservationRequired,
} from './owner-worker-recovery.js';

const roles = ['browser', 'code', 'processor'] as const;
type Role = (typeof roles)[number];
const root = 'projects/bmson-assistant/locations/us-west1/jobs/assistant-';
const images = {
  browser: { originalImage: 'old-browser', recoveryImage: 'recovery-browser' },
  code: { originalImage: 'old-code', recoveryImage: 'recovery-code' },
  processor: { originalImage: 'old-processor', recoveryImage: 'recovery-processor' },
};

function job(role: Role) {
  return {
    name: root + role,
    uid: `uid-${role}`,
    etag: 'etag-before',
    generation: '10',
    observedGeneration: '10',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    launchStage: 'GA',
    client: 'synthetic-cli' as string | undefined,
    clientVersion: '1' as string | undefined,
    labels: { preserved: 'yes' },
    template: {
      taskCount: 1,
      template: {
        serviceAccount: `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`,
        containers: [{ image: images[role].originalImage, args: ['preserved'] }],
      },
    },
  };
}

function fixture() {
  const state = { browser: job('browser'), code: job('code'), processor: job('processor') };
  const read = vi.fn(async (role: Role) => structuredClone(state[role]));
  const patch = vi.fn(async (role: Role, body: unknown): Promise<number> => {
    const next = body as ReturnType<typeof job>;
    if (next.etag !== state[role].etag) return 412;
    const generation = String(Number(state[role].generation) + 1);
    state[role] = {
      ...state[role],
      ...next,
      generation,
      observedGeneration: generation,
      etag: `etag-${generation}`,
      client: undefined,
      clientVersion: undefined,
    };
    return 200;
  });
  return { native: { read, patch }, state, pullable: vi.fn(async (_role: Role) => {}) };
}

const wait = async () => {};

describe('qualified ordinary API 3 worker recovery', () => {
  it('checks exact registry manifests and config and requires executable layer availability', async () => {
    const indexType = 'application/vnd.oci.image.index.v1+json';
    const manifestType = 'application/vnd.oci.image.manifest.v1+json';
    const objects = new Map<string, string>();
    const store = (mediaType: string, bytes: string) => {
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      objects.set(digest, bytes);
      return { mediaType, digest, size: Buffer.byteLength(bytes) };
    };
    const platform = { os: 'linux', architecture: 'amd64' };
    const config = store('application/vnd.oci.image.config.v1+json', JSON.stringify(platform));
    const layer = store('application/vnd.oci.image.layer.v1.tar', 'layer bytes');
    const child = store(
      manifestType,
      JSON.stringify({
        schemaVersion: 2,
        mediaType: manifestType,
        config,
        layers: [layer],
      }),
    );
    const parent = store(
      indexType,
      JSON.stringify({
        schemaVersion: 2,
        mediaType: indexType,
        manifests: [{ ...child, platform }],
      }),
    );
    const read = vi.fn(async (_kind: string, method: string, digest: string) => {
      const bytes = objects.get(digest);
      if (bytes === undefined) return new Response(null, { status: 404 });
      return new Response(method === 'HEAD' ? null : bytes, {
        headers: { 'content-length': String(Buffer.byteLength(bytes)) },
      });
    });
    await expect(verifyWorkerGraph('browser', parent.digest, read)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith('blobs', 'HEAD', layer.digest);
    objects.delete(layer.digest);
    await expect(verifyWorkerGraph('browser', parent.digest, read)).rejects.toThrow();
    objects.set(layer.digest, 'layer bytes');
    objects.set(config.digest, JSON.stringify({ os: 'linux', architecture: 'arm64' }));
    await expect(verifyWorkerGraph('browser', parent.digest, read)).rejects.toThrow();
  });

  it('requires native readiness, original image, and pullable recovery for all three jobs', async () => {
    const { native, pullable, state } = fixture();
    await expect(preflightWorkers(native, images, pullable)).resolves.toMatchObject({
      browser: { uid: 'uid-browser', generation: '10' },
      code: { uid: 'uid-code', generation: '10' },
      processor: { uid: 'uid-processor', generation: '10' },
    });
    expect(pullable.mock.calls.flat()).toEqual(roles);
    pullable.mockRejectedValueOnce(new Error('blob missing'));
    await expect(preflightWorkers(native, images, pullable)).rejects.toThrow('blob missing');
    state.processor.observedGeneration = '9';
    await expect(preflightWorkers(native, images, pullable)).rejects.toThrow();
    state.processor.observedGeneration = '10';
    state.processor.launchStage = 'BETA';
    await expect(preflightWorkers(native, images, pullable)).rejects.toThrow();
    expect(native.patch).not.toHaveBeenCalled();
  });

  it('uses a fresh etag, keeps existing settings, and restores only the advanced job', async () => {
    const { native, pullable, state } = fixture();
    const baseline = await preflightWorkers(native, images, pullable);
    state.browser.etag = 'fresh-etag';
    await transitionWorker(
      native,
      'browser',
      baseline.browser,
      'old-browser',
      'candidate',
      false,
      wait,
    );
    expect(state.browser.generation).toBe('11');
    expect(native.patch).toHaveBeenNthCalledWith(
      1,
      'browser',
      {
        name: `${root}browser`,
        etag: 'fresh-etag',
        labels: { preserved: 'yes' },
        template: {
          taskCount: 1,
          template: {
            serviceAccount: 'assistant-browser@bmson-assistant.iam.gserviceaccount.com',
            containers: [{ image: 'candidate', args: ['preserved'] }],
          },
        },
      },
      'uid-browser',
    );
    await transitionWorker(
      native,
      'browser',
      baseline.browser,
      'candidate',
      'recovery-browser',
      true,
      wait,
    );
    expect(state.browser.template.template.containers[0]?.image).toBe('recovery-browser');
    expect(state.browser.generation).toBe('12');
    expect(state.browser.client).toBeUndefined();
    expect(state.code).toEqual(job('code'));
    await expect(
      transitionWorker(native, 'code', baseline.code, 'candidate', 'recovery-code', true, wait),
    ).rejects.toThrow();
    expect(native.patch).toHaveBeenCalledTimes(2);
  });

  it('follows the exact native PATCH operation and then confirms the ready job', async () => {
    const before = job('browser');
    const after = {
      ...before,
      etag: 'etag-next',
      generation: '11',
      observedGeneration: '11',
      client: undefined,
      clientVersion: undefined,
      template: {
        ...before.template,
        template: {
          ...before.template.template,
          containers: [{ image: 'candidate', args: ['preserved'] }],
        },
      },
    };
    const operation = 'projects/bmson-assistant/locations/us-west1/operations/worker-update';
    const metadata = { name: before.name, uid: before.uid };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(before))
      .mockResolvedValueOnce(Response.json({ name: operation, metadata }))
      .mockResolvedValueOnce(
        Response.json({ name: operation, metadata, done: true, response: after }),
      )
      .mockResolvedValueOnce(Response.json(after));
    const native = nativeWorkers('a'.repeat(32), request, wait);
    const { native: fixtures, pullable } = fixture();
    const baseline = await preflightWorkers(fixtures, images, pullable);
    await expect(
      transitionWorker(
        native,
        'browser',
        baseline.browser,
        'old-browser',
        'candidate',
        false,
        wait,
      ),
    ).resolves.toEqual({ beforeGeneration: '10', observedGeneration: '11' });
    expect(request.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`https://run.googleapis.com/v2/${before.name}`, 'GET'],
      [`https://run.googleapis.com/v2/${before.name}`, 'PATCH'],
      [`https://run.googleapis.com/v2/${operation}`, 'GET'],
      [`https://run.googleapis.com/v2/${before.name}`, 'GET'],
    ]);
  });

  it('holds if the exact PATCH operation finishes with an error or another job identity', async () => {
    const before = job('browser');
    const operation = 'projects/bmson-assistant/locations/us-west1/operations/worker-update';
    const { native: fixtures, pullable } = fixture();
    const baseline = await preflightWorkers(fixtures, images, pullable);
    for (const outcome of [{ error: { code: 9 } }, { response: job('code') }]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(before))
        .mockResolvedValueOnce(Response.json({ name: operation }))
        .mockResolvedValueOnce(Response.json({ name: operation, done: true, ...outcome }));
      const native = nativeWorkers('a'.repeat(32), request, wait);
      await expect(
        transitionWorker(
          native,
          'browser',
          baseline.browser,
          'old-browser',
          'candidate',
          false,
          wait,
        ),
      ).rejects.toBeInstanceOf(WorkerObservationRequired);
      expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PATCH', 'GET']);
    }
  });

  it('allows a denial to trigger rollback only after confirming the job still has its prior configuration', async () => {
    const { native, pullable, state } = fixture();
    const baseline = await preflightWorkers(native, images, pullable);
    native.patch.mockResolvedValueOnce(403);
    await expect(
      transitionWorker(
        native,
        'browser',
        baseline.browser,
        'old-browser',
        'candidate',
        false,
        wait,
      ),
    ).rejects.toBeInstanceOf(WorkerAdvanceRejected);
    native.patch.mockImplementationOnce(async () => {
      state.browser.template.taskCount = 2;
      return 403;
    });
    await expect(
      transitionWorker(
        native,
        'browser',
        baseline.browser,
        'old-browser',
        'candidate',
        false,
        wait,
      ),
    ).rejects.toBeInstanceOf(WorkerObservationRequired);
    expect(native.patch).toHaveBeenCalledTimes(2);
  });

  it('holds on concurrent generations, etag conflicts, and uncertain write responses', async () => {
    const { native, pullable, state } = fixture();
    const baseline = await preflightWorkers(native, images, pullable);
    native.patch.mockResolvedValueOnce(412).mockRejectedValueOnce(new Error('connection lost'));
    for (const role of ['browser', 'code'] as const) {
      await expect(
        transitionWorker(
          native,
          role,
          baseline[role],
          images[role].originalImage,
          'candidate',
          false,
          wait,
        ),
      ).rejects.toBeInstanceOf(WorkerObservationRequired);
    }
    state.processor.generation = '11';
    state.processor.observedGeneration = '11';
    await expect(
      transitionWorker(
        native,
        'processor',
        baseline.processor,
        'old-processor',
        'candidate',
        false,
        wait,
      ),
    ).rejects.toThrow();
    expect(native.patch).toHaveBeenCalledTimes(2);
  });

  it('does not treat PATCH acceptance as proof when readback is missing', async () => {
    const { native, pullable } = fixture();
    const baseline = await preflightWorkers(native, images, pullable);
    native.patch.mockImplementationOnce(async () => {
      native.read.mockRejectedValue(new Error('GET failed'));
      return 200;
    });
    await expect(
      transitionWorker(
        native,
        'browser',
        baseline.browser,
        'old-browser',
        'candidate',
        false,
        wait,
      ),
    ).rejects.toBeInstanceOf(WorkerObservationRequired);
    expect(native.patch).toHaveBeenCalledTimes(1);
  });
});
