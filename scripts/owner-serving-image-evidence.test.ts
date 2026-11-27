import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORDINARY_IDENTITY } from './owner-api3-recovery-pins.js';
import { createImageResolutionReader } from './owner-release-image-resolution.js';
import {
  loadRetainedServingImageEvidence,
  RETAINED_SERVING_IMAGE_FILE,
  RETAINED_SERVING_IMAGE_LIMIT,
} from './owner-serving-image-evidence.js';

describe('retained serving image evidence', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const pins = {
    OWNER_API3_RECOVERY_GENERATION: ORDINARY_IDENTITY.generation,
    OWNER_API3_RECOVERY_SHA256: ORDINARY_IDENTITY.sha256,
  };

  it('ignores a local capsule without explicit opt-in and rejects partial and unreviewed pins', () => {
    directory = mkdtempSync(join(tmpdir(), 'retained-image-test-'));
    writeFileSync(join(directory, RETAINED_SERVING_IMAGE_FILE), '{}', { mode: 0o600 });
    expect(loadRetainedServingImageEvidence({ RUNNER_TEMP: directory })).toBeUndefined();
    for (const env of [
      { OWNER_API3_RECOVERY_GENERATION: ORDINARY_IDENTITY.generation },
      { ...pins, OWNER_API3_RECOVERY_GENERATION: '1' },
      { ...pins, OWNER_API3_RECOVERY_SHA256: '0'.repeat(64) },
    ]) {
      expect(() => loadRetainedServingImageEvidence({ RUNNER_TEMP: directory, ...env })).toThrow(
        'Retained serving image evidence held',
      );
    }
  });

  it('rejects altered bytes, oversized capsules, and symlinks at the fixed local path', () => {
    directory = mkdtempSync(join(tmpdir(), 'retained-image-test-'));
    const env = { ...pins, RUNNER_TEMP: directory };
    const file = join(directory, RETAINED_SERVING_IMAGE_FILE);
    for (const bytes of ['{}', Buffer.alloc(RETAINED_SERVING_IMAGE_LIMIT + 1)]) {
      writeFileSync(file, bytes, { mode: 0o600 });
      expect(() => loadRetainedServingImageEvidence(env)).toThrow(
        'Retained serving image evidence held',
      );
    }
    rmSync(file);
    const target = join(directory, 'other.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, file);
    expect(() => loadRetainedServingImageEvidence(env)).toThrow(
      'Retained serving image evidence held',
    );
  });

  it('keeps the existing live image failure for unrelated images', async () => {
    const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:${'f'.repeat(64)}`;
    const registry = vi.fn(async () => new Response(null, { status: 404 }));
    const retained = { registerServingImage: vi.fn(() => false) };
    const resolveImage = createImageResolutionReader(
      'fixture',
      registry,
      Date.now() + 5000,
      retained,
    );
    await expect(resolveImage(image)).rejects.toThrow('Image content resolution failed');
    expect(retained.registerServingImage).toHaveBeenCalledExactlyOnceWith(image);
    expect(registry).toHaveBeenCalledOnce();
  });
});
