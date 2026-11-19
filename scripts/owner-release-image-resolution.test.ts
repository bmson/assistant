import { describe, expect, it, vi } from 'vitest';
import { bytes, hash, syntheticImage } from './fixtures/owner-image-resolution.synthetic.js';
import {
  createImageResolutionReader,
  registerImageResolution,
  revisionWithRequestedImage,
  verifyRevisionImage,
} from './owner-release-image-resolution.js';

describe('content-addressed Cloud Run image resolution', () => {
  it('keeps legacy exact equality and rejects an unproven different image', () => {
    const f = syntheticImage('web', 'unproven');
    expect(() => verifyRevisionImage({ containers: [{ image: f.image }] }, f.image)).not.toThrow();
    expect(() => verifyRevisionImage(f.revision, f.image)).toThrow();
  });
  it('projects only a verified linux/amd64 child while retaining every original native field', () => {
    const f = syntheticImage();
    const original = structuredClone(f.revision);
    registerImageResolution(f.image, f.parentBytes, f.childBytes);
    const semantic = revisionWithRequestedImage(f.revision, f.image);
    expect(semantic).toEqual({
      ...original,
      containers: [{ ...original.containers[0], image: f.image }],
    });
    expect(f.revision).toEqual(original);
    expect(semantic.containerStatuses).toEqual(original.containerStatuses);
  });
  it('retains direct manifest exactness', () => {
    const f = syntheticImage();
    expect(registerImageResolution(f.childImage, f.childBytes, f.childBytes).resolved).toBe(
      f.childImage,
    );
    expect(() => registerImageResolution(f.childImage, f.childBytes, f.parentBytes)).toThrow();
  });
  it('rejects wrong raw bytes and wrong repository even if JSON content is unchanged', () => {
    const f = syntheticImage();
    for (const parent of [Buffer.concat([f.parentBytes, Buffer.from('\n')]), f.childBytes])
      expect(() => registerImageResolution(f.image, parent, f.childBytes)).toThrow();
    expect(() =>
      registerImageResolution(f.image.replace('/web@', '/other@'), f.parentBytes, f.childBytes),
    ).toThrow();
    expect(() =>
      registerImageResolution(
        f.image,
        f.parentBytes,
        Buffer.concat([f.childBytes, Buffer.from('\n')]),
      ),
    ).toThrow();
  });
  it.each([
    'wrong-platform',
    'duplicate',
    'size',
    'variant',
    'external',
    'embedded',
    'wrong-media',
  ])('rejects index ambiguity or unsupported descriptors: %s', (kind) => {
    const f = syntheticImage();
    const parent = structuredClone(f.parent) as Record<string, unknown>;
    const entries = parent.manifests as Record<string, unknown>[];
    const d = entries[0] as Record<string, unknown>;
    if (kind === 'wrong-platform') d.platform = { os: 'linux', architecture: 'arm64' };
    if (kind === 'duplicate') entries.push({ ...d });
    if (kind === 'size') d.size = 1;
    if (kind === 'variant') d.platform = { os: 'linux', architecture: 'amd64', variant: 'v3' };
    if (kind === 'external') d.urls = ['https://example.invalid/manifest'];
    if (kind === 'embedded') d.data = 'AA==';
    if (kind === 'wrong-media') d.mediaType = 'application/json';
    const raw = bytes(parent);
    expect(() =>
      registerImageResolution(`${f.root}@sha256:${hash(raw)}`, raw, f.childBytes),
    ).toThrow();
  });
  it('rejects duplicate JSON keys, including escaped equivalents', () => {
    const f = syntheticImage();
    const raw = Buffer.from(
      f.parentBytes
        .toString()
        .replace('"schemaVersion":2', '"schemaVersion":1,"schema\\u0056ersion":2'),
    );
    expect(() =>
      registerImageResolution(`${f.root}@sha256:${hash(raw)}`, raw, f.childBytes),
    ).toThrow();
  });
  it.each(['image', 'name', 'status', 'multiple', 'missing'])(
    'rechecks native container/status binding on every use: %s',
    (kind) => {
      const f = syntheticImage();
      registerImageResolution(f.image, f.parentBytes, f.childBytes);
      const container = f.revision.containers[0],
        status = f.revision.containerStatuses[0];
      if (!container || !status) throw new Error('Synthetic binding missing');
      if (kind === 'image') container.image = f.childImage.replace('/web@', '/agent@');
      if (kind === 'name') status.name = 'other';
      if (kind === 'status') status.imageDigest = f.image;
      if (kind === 'multiple') f.revision.containerStatuses.push({ ...status });
      if (kind === 'missing') f.revision.containerStatuses = [];
      expect(() => verifyRevisionImage(f.revision, f.image)).toThrow();
    },
  );
  it('fetches only bounded fixed-repository digest GETs and reuses verified content', async () => {
    const f = syntheticImage('agent', 'transport');
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(f.parentBytes))
      .mockResolvedValueOnce(new Response(f.childBytes));
    const resolve = createImageResolutionReader('test-token', request);
    await resolve(f.image);
    await resolve(f.image);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://us-west1-docker.pkg.dev/v2/bmson-assistant/assistant/agent/manifests/${f.image.split('@')[1]}`,
    );
    for (const [, options] of request.mock.calls)
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(() => verifyRevisionImage(f.revision, f.image)).not.toThrow();
    await expect(resolve('https://example.invalid')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not register failed or oversized content and redacts transport failures', async () => {
    const f = syntheticImage('agent', 'failure');
    for (const result of [
      new Response('private-provider-error', { status: 403 }),
      new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
      new Response(f.childBytes),
    ]) {
      const resolve = createImageResolutionReader(
        'test-token',
        vi.fn<typeof fetch>().mockResolvedValue(result),
      );
      await expect(resolve(f.image)).rejects.toThrow('Image content resolution failed');
      expect(() => verifyRevisionImage(f.revision, f.image)).toThrow();
    }
    const resolve = createImageResolutionReader(
      'test-token',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-token')),
    );
    await expect(resolve(f.image)).rejects.toThrow('Image content resolution failed');
  });
  it('does not wait for a stalled error-body cancellation', async () => {
    const f = syntheticImage('web', 'stalled-cancel');
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => undefined),
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 403 }));
    const resolve = createImageResolutionReader('test-token', request, Date.now() + 50);
    await expect(resolve(f.image)).rejects.toThrow('Image content resolution failed');
    expect(() => verifyRevisionImage(f.revision, f.image)).toThrow();
  }, 500);
});
