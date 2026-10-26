import { randomUUID } from 'node:crypto';
import type {
  OwnerEditorApply,
  OwnerEditorClaim,
  OwnerEditorFamilyFields,
  OwnerEditorScope,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { createOwnerEditorDomain, type OwnerEditorDomainStorage } from './owner-editor-domain.js';

function fixture() {
  const left = {
    id: randomUUID(),
    name: 'Alex',
    aliases: [],
    trust: 'unknown',
    revision: 'a'.repeat(64),
  };
  const right = { ...left, id: randomUUID(), name: 'Sam', revision: 'b'.repeat(64) };
  const fields: OwnerEditorFamilyFields = {
    subjectContactId: left.id,
    objectContactId: right.id,
    expectedSubjectRevision: left.revision,
    expectedObjectRevision: right.revision,
    predicate: 'parent_of',
    timing: 'unspecified',
    validity: { validFrom: null, validUntil: '2024-02-29' },
    note: '',
    expectedCanonicalState: { kind: 'absent' },
  };
  const request: OwnerEditorApply = {
    version: 1,
    intent: 'apply',
    command: 'add_family_relationship',
    operationId: randomUUID(),
    ...fields,
  };
  const scope: OwnerEditorScope = {
    ownerId: randomUUID(),
    command: request.command,
    operationId: request.operationId,
    targetId: left.id,
    epoch: randomUUID(),
    privacyGeneration: null,
    sessionDigest: 'c'.repeat(64),
    nonce: randomUUID(),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
  };
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
  const graphApply = vi.fn(async () => {
    throw new Error('Preparation cannot write source');
  });
  const family = vi.fn(async () => ({
    subject: left,
    object: right,
    canonicalRevision: null as string | null,
    canonicalIds: undefined as
      | { assertionId: string; relationId: string; memoryId: string }
      | undefined,
  }));
  let insideCommit = false;
  const commitPerson = vi.fn<OwnerEditorDomainStorage['commitPerson']>(async () => {
    throw new Error('Unexpected person commit');
  });
  const commitFamily = vi.fn<OwnerEditorDomainStorage['commitFamily']>(async (_claim, prepared) => {
    insideCommit = true;
    expect(prepared.editor?.claim).toBe(_claim);
    expect(embed).toHaveBeenCalledTimes(1);
    return {
      version: 1,
      authority: 'operation_receipt',
      command: scope.command,
      operationId: scope.operationId,
      requestHash: _claim.requestHash,
      statusVersion: 2,
      outcome: 'saved',
      ids: { relationId: 'durable-relation' },
      revision: 'd'.repeat(64),
    };
  });
  const commitUnchangedFamily = vi.fn<OwnerEditorDomainStorage['commitUnchangedFamily']>(
    async (_claim) => ({
      version: 1,
      authority: 'operation_receipt',
      command: scope.command,
      operationId: scope.operationId,
      requestHash: _claim.requestHash,
      statusVersion: 2,
      outcome: 'unchanged',
      ids: { assertionId: 'existing-assertion' },
      revision: 'e'.repeat(64),
    }),
  );
  const storage: OwnerEditorDomainStorage = {
    contact: async (_owner, id) => (id === left.id ? left : right),
    family,
    context: async (ownerId) => ({ agentId: ownerId, timeZone: 'Pacific/Auckland', locale: 'en' }),
    graph: {
      kind: 'owner-knowledge-graph-fact-repository',
      context: async () => {
        throw new Error('Unbounded graph context forbidden');
      },
      entity: async () => null,
      correctionTarget: async () => null,
      createAtomic: graphApply,
    },
    commitPerson,
    commitFamily,
    commitUnchangedFamily,
  };
  const domain = createOwnerEditorDomain({
    storage,
    router: {
      embeddingSpace: async () => ({
        provider: 'test',
        model: 'unit',
        dimensions: 3,
        revision: '1',
      }),
      embed: async (texts) => {
        expect(insideCommit).toBe(false);
        return embed(texts);
      },
    },
  });
  const claim: OwnerEditorClaim = {
    scope,
    requestHash: 'f'.repeat(64),
    claimToken: randomUUID(),
    claimExpiresAt: new Date(Date.now() + 60000),
    statusVersion: 1,
  };
  return {
    domain,
    storage,
    request,
    scope,
    claim,
    embed,
    graphApply,
    family,
    left,
    right,
    commitFamily,
    commitPerson,
    commitUnchangedFamily,
  };
}

describe('actual owner editor domain preparation and transaction handoff', () => {
  it('prepares exact named pins/source dates once outside commit and hands same claim/CAS expectations to writer', async () => {
    const f = fixture();
    const result = await f.domain.prepare(f.request, f.scope);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Unexpected rejection');
    expect(result.prepared.kind).toBe('family');
    if (result.prepared.kind !== 'family') throw new Error('Wrong prepared command');
    expect(result.prepared.atomic.subject.canonicalKey).toBe(`contact:${f.left.id}`);
    expect(result.prepared.atomic.object.canonicalKey).toBe(`contact:${f.right.id}`);
    expect(result.prepared.atomic.content).toContain(
      'Recorded dates: Start not recorded; through 2024-02-29 (inclusive).',
    );
    expect(result.prepared.atomic.content).toContain('Timing recorded: not recorded.');
    expect(f.graphApply).not.toHaveBeenCalled();
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(await f.domain.commit(f.claim, result.prepared, new Date())).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
    });
    expect(f.commitFamily).toHaveBeenCalledTimes(1);
    expect(f.embed).toHaveBeenCalledTimes(1);
  });
  it.each(['endpoint', 'canonical', 'target', 'issuance'] as const)(
    'rejects changed %s before embedding or writer',
    async (change) => {
      const f = fixture();
      let request: OwnerEditorApply = f.request;
      if (change === 'endpoint') f.left.revision = '0'.repeat(64);
      if (change === 'canonical')
        f.family.mockResolvedValue({
          subject: f.left,
          object: f.right,
          canonicalRevision: '0'.repeat(64),
          canonicalIds: undefined,
        });
      if (change === 'target')
        request = {
          version: 1,
          intent: 'apply',
          operationId: f.request.operationId,
          command: 'correct_owner_family_relationship',
          targetRelationId: randomUUID(),
          expectedTargetRevision: '1'.repeat(64),
          replacement: f.request,
        };
      const scope =
        change === 'target'
          ? {
              ...f.scope,
              command: request.command,
              targetId:
                request.command === 'correct_owner_family_relationship'
                  ? request.targetRelationId
                  : null,
            }
          : change === 'issuance'
            ? { ...f.scope, targetId: randomUUID() }
            : f.scope;
      expect((await f.domain.prepare(request, scope)).ok).toBe(false);
      expect(f.embed).not.toHaveBeenCalled();
      expect(f.commitFamily).not.toHaveBeenCalled();
      expect(f.graphApply).not.toHaveBeenCalled();
    },
  );
  it('returns unchanged through a receipt-only transaction without embedding existing canonical meaning again', async () => {
    const f = fixture();
    f.family.mockResolvedValue({
      subject: f.left,
      object: f.right,
      canonicalRevision: '1'.repeat(64),
      canonicalIds: { assertionId: 'a', relationId: 'r', memoryId: 'm' },
    });
    const request = {
      ...f.request,
      expectedCanonicalState: { kind: 'revision' as const, revision: '1'.repeat(64) },
    };
    const prepared = await f.domain.prepare(request, f.scope);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Unexpected rejection');
    expect(await f.domain.commit(f.claim, prepared.prepared, new Date())).toMatchObject({
      outcome: 'unchanged',
    });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.commitFamily).not.toHaveBeenCalled();
    expect(f.commitUnchangedFamily).toHaveBeenCalledTimes(1);
  });
  it('retains old-name alias on identity edit without a relationship/trust command or model call', async () => {
    const f = fixture();
    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'update_person_identity',
      operationId: f.request.operationId,
      contactId: f.left.id,
      expectedContactRevision: f.left.revision,
      name: 'Alex New',
      aliases: ['Al'],
    };
    const prepared = await f.domain.prepare(request, { ...f.scope, command: request.command });
    expect(prepared).toMatchObject({
      ok: true,
      prepared: { kind: 'person', name: 'Alex New', aliases: ['Al', 'Alex'] },
    });
    expect(f.left.trust).toBe('unknown');
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.family).not.toHaveBeenCalled();
  });
});
