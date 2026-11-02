import { createHash, randomUUID } from 'node:crypto';
import type {
  OwnerEditorApply,
  OwnerEditorScope,
  OwnerMemoryCreationTarget,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { createOwnerEditorDomain, type OwnerEditorDomainStorage } from './owner-editor-domain.js';
import { prepareOwnerMemoryCreation } from './owner-memory-create.js';

const compilation = vi.hoisted(() => ({ compile: vi.fn() }));
vi.mock('@assistant/core/memory/consolidation', () => ({ compileOwnerCard: compilation.compile }));

function fixture() {
  const request: Extract<OwnerEditorApply, { command: 'create_owner_memory' }> = {
    version: 1,
    intent: 'apply',
    command: 'create_owner_memory',
    operationId: randomUUID(),
    subjectContactId: randomUUID(),
    expectedSubjectRevision: 'a'.repeat(64),
    content: '  A note about this person  ',
    domain: 'other',
    importance: 3,
    pinned: false,
  };
  const scope: OwnerEditorScope = {
    ownerId: randomUUID(),
    epoch: randomUUID(),
    command: request.command,
    operationId: request.operationId,
    targetId: request.subjectContactId,
    privacyGeneration: null,
    sessionDigest: 'b'.repeat(64),
    nonce: randomUUID(),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  };
  const target: OwnerMemoryCreationTarget = {
    ownerId: scope.ownerId,
    subjectContactId: request.subjectContactId,
    subjectRevision: request.expectedSubjectRevision,
    subjectTrust: 'known',
    status: 'eligible',
  };
  const read = vi.fn(async (): Promise<OwnerMemoryCreationTarget | null> => target);
  const space = { provider: 'test', model: 'unit', revision: '1', dimensions: 3 };
  const router = {
    embeddingSpace: vi.fn(async () => space),
    embed: vi.fn(async () => [[1, 0, 0]]),
  };
  const run = () => prepareOwnerMemoryCreation(request, scope, read, router);
  return { request, scope, target, read, space, router, run };
}

describe('person-note creation preparation without provider or database calls', () => {
  it('binds two short target observations to trimmed content and freezes the prepared identity', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected preparation');
    expect(result.prepared).toMatchObject({
      subjectContactId: f.request.subjectContactId,
      expectedSubjectRevision: f.request.expectedSubjectRevision,
      content: 'A note about this person',
      contentHash: createHash('sha256').update('A note about this person').digest('hex'),
      domain: 'other',
      importance: 3,
      pinned: false,
      embedding: [1, 0, 0],
    });
    expect(result.prepared.memoryId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.prepared.retrievalRevision).not.toBe(result.prepared.memoryId);
    expect(Object.isFrozen(result.prepared)).toBe(true);
    expect(Object.isFrozen(result.prepared.embedding)).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.read).toHaveBeenCalledWith(
      f.scope.ownerId,
      f.request.subjectContactId,
      result.prepared.contentHash,
      f.scope,
    );
    expect(f.router.embed).toHaveBeenCalledExactlyOnceWith(['A note about this person'], {
      expectedSpace: f.space,
    });
  });

  it.each(['duplicate', 'tombstoned'] as const)(
    'rejects %s before model preparation',
    async (status) => {
      const f = fixture();
      f.read.mockResolvedValue({ ...f.target, status });
      expect(await f.run()).toMatchObject({
        ok: false,
        result: { outcome: 'conflict', reason: `memory_${status}` },
      });
      expect(f.router.embeddingSpace).not.toHaveBeenCalled();
      expect(f.router.embed).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'subject', 'revision', 'missing'])(
    'refuses a changed %s before embedding',
    async (change) => {
      const f = fixture();
      f.read.mockResolvedValue(
        change === 'missing'
          ? null
          : {
              ...f.target,
              ...(change === 'owner' ? { ownerId: randomUUID() } : {}),
              ...(change === 'subject' ? { subjectContactId: randomUUID() } : {}),
              ...(change === 'revision' ? { subjectRevision: 'c'.repeat(64) } : {}),
            },
      );
      expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'conflict' } });
      expect(f.router.embed).not.toHaveBeenCalled();
    },
  );

  it('rechecks eligibility after asynchronous space discovery before dispatch', async () => {
    const f = fixture();
    f.router.embeddingSpace.mockImplementation(async () => {
      f.read.mockResolvedValue(null);
      return f.space;
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      result: { reason: 'memory_subject_changed' },
    });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.router.embed).not.toHaveBeenCalled();
  });

  it('refuses owner trust and self identity in preparation even under an eligible port result', async () => {
    const f = fixture();
    f.read.mockResolvedValue({ ...f.target, subjectTrust: 'owner' });
    expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'conflict' } });
    expect(f.router.embeddingSpace).not.toHaveBeenCalled();
    f.request.subjectContactId = f.scope.ownerId;
    f.scope.targetId = f.scope.ownerId;
    f.read.mockClear();
    expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'conflict' } });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.router.embed).not.toHaveBeenCalled();
  });

  it('rejects foreign scope or malformed explicit subject without a target read', async () => {
    const f = fixture();
    f.scope.targetId = randomUUID();
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.read).not.toHaveBeenCalled();
    f.scope.targetId = f.request.subjectContactId;
    f.request.subjectContactId = '';
    expect(await f.run()).toMatchObject({ ok: false, result: { outcome: 'invalid' } });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.router.embed).not.toHaveBeenCalled();
  });

  it('rejects nonunique or malformed vectors before returning a prepared write', async () => {
    const f = fixture();
    f.router.embed.mockResolvedValue([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    await expect(f.run()).rejects.toThrow('no unique vector');
    f.router.embed.mockResolvedValue([[Number.NaN, 0, 0]]);
    await expect(f.run()).rejects.toThrow();
  });

  it('preserves the exact saved receipt when post-commit summary refresh fails and dispatches no graph work', async () => {
    const f = fixture();
    const prepared = await f.run();
    if (!prepared.ok) throw new Error('Expected preparation');
    const saved = {
      version: 1 as const,
      authority: 'operation_receipt' as const,
      command: f.scope.command,
      operationId: f.scope.operationId,
      requestHash: 'b'.repeat(64),
      statusVersion: 2,
      outcome: 'saved' as const,
      ids: { memoryId: prepared.prepared.memoryId },
      revision: 'c'.repeat(64),
      refreshPending: true,
    };
    const commit = vi.fn(async () => saved);
    const graphSync = vi.fn();
    const ownerCards = {};
    const storage = {
      commitCreateMemory: commit,
      memoryFollowup: { ownerCards, maintenance: { queueGraphSync: graphSync } },
    } as unknown as OwnerEditorDomainStorage;
    const domain = createOwnerEditorDomain({ storage, router: f.router });
    compilation.compile.mockRejectedValueOnce(new Error('Synthetic summary refresh failure'));
    const claim = {
      scope: f.scope,
      requestHash: 'b'.repeat(64),
      claimToken: randomUUID(),
      statusVersion: 1,
      claimExpiresAt: new Date(Date.now() + 60_000),
    };
    expect(
      await domain.commit(claim, { kind: 'memory-create', memory: prepared.prepared }, new Date()),
    ).toBe(saved);
    expect(commit).toHaveBeenCalledOnce();
    expect(compilation.compile).toHaveBeenCalledWith(ownerCards, f.scope.ownerId);
    expect(graphSync).not.toHaveBeenCalled();
  });
});
