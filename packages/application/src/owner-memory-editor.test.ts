import { createHash, randomUUID } from 'node:crypto';
import type {
  OwnerEditorApply,
  OwnerEditorScope,
  OwnerMemoryEditorSnapshot,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareOwnerMemoryCorrection,
  refreshOwnerMemoryCorrection,
} from './owner-memory-editor.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const ownerId = randomUUID(),
    memoryId = randomUUID(),
    now = Date.now();
  const snapshot: OwnerMemoryEditorSnapshot = {
    ownerId,
    memoryId,
    content: 'Original saved note',
    contentHash: hash('Original saved note'),
    revision: 'a'.repeat(64),
    ownerCorrection: null,
    sourceLabel: 'Saved manual note',
    eligible: true,
  };
  const request: Extract<OwnerEditorApply, { command: 'correct_owner_memory' }> = {
    version: 1,
    intent: 'apply',
    command: 'correct_owner_memory',
    operationId: randomUUID(),
    memoryId,
    expectedContentHash: snapshot.contentHash,
    expectedMemoryRevision: snapshot.revision,
    content: '  Revised saved note  ',
  };
  const scope: OwnerEditorScope = {
    ownerId,
    epoch: randomUUID(),
    privacyGeneration: null,
    command: request.command,
    targetId: memoryId,
    operationId: request.operationId,
    sessionDigest: 'b'.repeat(64),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 60000,
  };
  const read = vi.fn(async () => snapshot),
    router = {
      embeddingSpace: vi.fn(async () => ({
        provider: 'test',
        model: 'unit',
        dimensions: 3,
        revision: '1',
      })),
      embed: vi.fn(async () => [[1, 0, 0]]),
    };
  return {
    snapshot,
    request,
    scope,
    read,
    router,
    run: () => prepareOwnerMemoryCorrection(request, scope, read, router),
  };
}
describe('actual saved-note preparation boundary', () => {
  it('uses the displayed revision/hash and normalized content, with provider work only after the scoped read', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.prepared).toMatchObject({
      expectedContentHash: f.snapshot.contentHash,
      expectedMemoryRevision: f.snapshot.revision,
      content: 'Revised saved note',
      contentHash: hash('Revised saved note'),
      embedding: [1, 0, 0],
    });
    expect(f.read).toHaveBeenCalledWith(f.scope.ownerId, f.request.memoryId, f.scope);
    expect(f.router.embed).toHaveBeenCalledWith(['Revised saved note'], {
      expectedSpace: { provider: 'test', model: 'unit', dimensions: 3, revision: '1' },
    });
    expect(f.read.mock.invocationCallOrder[0]).toBeLessThan(
      f.router.embed.mock.invocationCallOrder[0]!,
    );
  });
  it.each(['contentHash', 'revision', 'ownerId'] as const)(
    'does not replace displayed %s with a fresh submit-time token',
    async (field) => {
      const f = fixture();
      f.snapshot[field] = 'c'.repeat(64);
      expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'conflict' } });
      expect(f.router.embed).not.toHaveBeenCalled();
    },
  );
  it('same text requires no embedding or fabricated correction marker', async () => {
    const f = fixture();
    f.request.content = f.snapshot.content;
    const result = await f.run();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prepared.embedding).toBeUndefined();
    expect(f.router.embed).not.toHaveBeenCalled();
  });
  it('rejects unsupported proof and maps incomplete raw inventory to unavailable, before model IO', async () => {
    const f = fixture();
    f.snapshot.eligible = false;
    f.snapshot.readOnlyReason = 'unknown_provenance';
    expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'conflict' } });
    f.snapshot.readOnlyReason = 'incomplete_provenance';
    expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'unavailable' } });
    expect(f.router.embed).not.toHaveBeenCalled();
  });
  it.each(['x', 'x'.repeat(4001)])(
    'rejects invalid content length without reads or provider IO',
    async (content) => {
      const f = fixture();
      f.request.content = content;
      expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'invalid' } });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.router.embed).not.toHaveBeenCalled();
    },
  );
  it('rejects an operation or target mismatch before private reads', async () => {
    const f = fixture();
    f.scope.targetId = randomUUID();
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('rejects a malformed provider vector instead of preparing an unscoped embedding', async () => {
    const f = fixture();
    f.router.embed.mockResolvedValue([[Number.NaN, 0, 0]]);
    await expect(f.run()).rejects.toThrow();
  });
  it('derived refresh failure stays a safe post-commit follow-up and never requests another primary save', async () => {
    const queue = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    await expect(
      refreshOwnerMemoryCorrection(
        {
          maintenance: {
            kind: 'profile-memory-maintenance',
            queueGraphSync: queue,
            removeOrphanedGraphEntities: vi.fn(),
            retryBlockedGraphSource: vi.fn(),
          },
          ownerCards: { kind: 'owner-card-compilation-repository', compile: vi.fn() },
        },
        randomUUID(),
        randomUUID(),
      ),
    ).resolves.toBeUndefined();
    expect(queue).toHaveBeenCalledTimes(1);
  });
});
