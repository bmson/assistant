import { createHash, randomUUID } from 'node:crypto';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorApply,
  type OwnerEditorScope,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { eligibleOwnerFamilyCorrection } from '@assistant/persistence/owner-family-scope';
import { describe, expect, it, vi } from 'vitest';
import { applyOwnerEditorCommand } from '../../application/src/owner-editor.js';
import { createOwnerEditorDomain } from '../../application/src/owner-editor-domain.js';
import { ownerEditorRequestHash } from '../../application/src/owner-editor-hash.js';
import {
  ownerEditorPath,
  parseOwnerEditorRequest,
} from '../../application/src/owner-editor-wire.js';
import { createFirestoreOwnerEditorDomainStorage } from './owner-editor-domain.js';
import {
  firestoreOwnerEditorViewSnapshot,
  readFirestoreOwnerEditorContact,
  readFirestoreOwnerEditorGraphScope,
} from './owner-editor-graph.js';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';
import { decodeRecord } from './store.js';

function familyFields(request: Extract<OwnerEditorApply, { command: 'add_family_relationship' }>) {
  const {
    version: _version,
    intent: _intent,
    command: _command,
    operationId: _operationId,
    ...fields
  } = request;
  return fields;
}
function fixture() {
  const f = ownerEditorTestStore(),
    ownerId = randomUUID(),
    epoch = randomUUID(),
    left = randomUUID(),
    right = randomUUID();
  const now = new Date();
  f.seed('agents', ownerId, { id: ownerId, timezone: 'Pacific/Auckland', locale: 'en' });
  f.seed('maintenanceCursors', `owner-editor-epoch:${ownerId}`, {
    name: `owner-editor-epoch:${ownerId}`,
    cursor: JSON.stringify({
      ownerId,
      epoch,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      ready: true,
    }),
  });
  for (const [id, name] of [
    [left, 'Alex'],
    [right, 'Sam'],
  ])
    f.seed('contacts', id!, {
      id,
      agentId: ownerId,
      name,
      aliases: [],
      relationship: '',
      trust: 'unknown',
      emails: [],
      phones: [],
      notes: '',
      createdAt: now,
      updatedAt: now,
    });
  const space = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
  const domain = createOwnerEditorDomain({
    storage: createFirestoreOwnerEditorDomainStorage(f.store, ownerId, space),
    router: { embeddingSpace: async () => space, embed },
  });
  const operations = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
  const scope = (request: OwnerEditorApply): OwnerEditorScope => {
    return {
      ownerId,
      epoch,
      privacyGeneration: null,
      command: request.command,
      operationId: request.operationId,
      targetId:
        request.command === 'create_person'
          ? null
          : request.command === 'correct_owner_memory'
            ? request.memoryId
            : request.command === 'update_person_identity'
              ? request.contactId
              : request.command === 'remove_person'
                ? request.contactId
                : request.command === 'correct_owner_family_relationship'
                  ? request.targetRelationId
                  : request.command === 'remove_owner_family_relationship'
                    ? request.targetRelationId
                    : request.subjectContactId,
      sessionDigest: 'a'.repeat(64),
      nonce: randomUUID(),
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 600000,
    };
  };
  const run = (request: OwnerEditorApply, issued = scope(request)) => {
    const parsed = parseOwnerEditorRequest(request, ownerEditorPath(request.command));
    if (!parsed.ok || parsed.request.intent !== 'apply')
      throw new Error(`Invalid editor fixture: ${JSON.stringify(parsed)}`);
    return applyOwnerEditorCommand({ request: parsed.request, scope: issued, domain, operations });
  };
  async function family(): Promise<
    Extract<OwnerEditorApply, { command: 'add_family_relationship' }>
  > {
    const a = await readFirestoreOwnerEditorContact(f.store, ownerId, left),
      b = await readFirestoreOwnerEditorContact(f.store, ownerId, right);
    return {
      version: 1,
      intent: 'apply',
      command: 'add_family_relationship',
      operationId: randomUUID(),
      subjectContactId: left,
      objectContactId: right,
      expectedSubjectRevision: a!.revision,
      expectedObjectRevision: b!.revision,
      predicate: 'parent_of',
      timing: 'unspecified',
      validity: { validFrom: '2024-02-29', validUntil: '2024-02-29' },
      note: 'Recorded by owner',
      expectedCanonicalState: { kind: 'absent' },
    };
  }
  return { ...f, ownerId, left, right, embed, run, scope, family, domain, operations };
}

describe('actual FS domain + actual canonical writer + actual claim/receipt transactions offline', () => {
  it('reads editable options and correction from one bounded native snapshot with identical point CAS', async () => {
    const f = fixture(),
      request = await f.family(),
      saved = await f.run(request);
    if (saved.outcome !== 'saved' || !saved.ids.relationId) throw new Error(JSON.stringify(saved));
    const point = await readFirestoreOwnerEditorGraphScope(
      f.store,
      f.ownerId,
      saved.ids.relationId,
    );
    const before = f.stats.requests;
    const snapshot = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: f.left,
      relationIds: [saved.ids.relationId],
    });
    expect(snapshot.identity).toMatchObject({
      contactId: f.left,
      trust: 'unknown',
      relationship: '',
    });
    expect(snapshot.people).toHaveLength(2);
    expect(snapshot.corrections).toEqual([
      {
        relationId: saved.ids.relationId,
        revision: point!.revision,
        sourceText: point!.source.content,
        original: familyFields(request),
      },
    ]);
    expect(f.stats.requests - before).toBeLessThanOrEqual(20);
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(f.embed).toHaveBeenCalledTimes(1);
    f.seed('knowledgeGraphAssertionEvidence', randomUUID(), {
      ...f.rows('knowledgeGraphAssertionEvidence')[0],
      id: randomUUID(),
    });
    // Physical mismatch is unavailable, never a silently eligible correction.
    await expect(
      firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, { relationIds: [saved.ids.relationId] }),
    ).rejects.toThrow();
  });
  it('accepts the complete 500-row option cap and excludes the owner without changing trust', async () => {
    const f = fixture();
    for (let i = 0; i < 498; i++) {
      const id = randomUUID();
      f.seed('contacts', id, {
        id,
        agentId: f.ownerId,
        name: `Person ${i}`,
        aliases: [],
        relationship: '',
        trust: i === 0 ? 'owner' : 'unknown',
      });
    }
    const snapshot = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId);
    expect(snapshot.people).toHaveLength(499);
    expect(snapshot.people.find((p) => p.contactId === f.left)?.revision).toBe(
      (await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left))?.revision,
    );
    expect(snapshot.corrections).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('rejects raw 501 options including malformed rows before publishing an editor', async () => {
    const f = fixture();
    for (let i = 0; i < 499; i++) {
      const id = randomUUID();
      f.seed('contacts', id, { id });
    }
    await expect(firestoreOwnerEditorViewSnapshot(f.store, f.ownerId)).rejects.toThrow(
      'read limit',
    );
    await expect(
      firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
        relationIds: Array.from({ length: 121 }, () => randomUUID()),
      }),
    ).rejects.toThrow('read limit');
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('saves exact directed family/source/canonical validity atomically, replays receipt, then corrects eligible standalone statement', async () => {
    const f = fixture(),
      request = await f.family(),
      issued = f.scope(request);
    const saved = await f.run(request, issued);
    expect(saved).toMatchObject({ authority: 'operation_receipt', outcome: 'saved' });
    if (saved.outcome !== 'saved') throw new Error(JSON.stringify(saved));
    expect(f.rows('memories')).toHaveLength(1);
    expect(f.rows('knowledgeGraphAssertions')).toHaveLength(1);
    const source = decodeRecord<Record<string, unknown>>(f.rows('memories')[0]);
    expect(source.content).toContain('Timing recorded: not recorded.');
    expect((source.validFrom as Date).toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect((source.validUntil as Date).toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(f.rows('knowledgeGraphRelations')[0]).toMatchObject({
      validFrom: '2024-02-29',
      validUntil: '2024-02-29',
      assertion: { tense: 'unspecified' },
    });
    expect(await f.run(request, issued)).toEqual(saved);
    expect(f.embed).toHaveBeenCalledTimes(1);
    const target = await readFirestoreOwnerEditorGraphScope(
      f.store,
      f.ownerId,
      saved.ids.relationId!,
    );
    expect(target).not.toBeNull();
    expect(eligibleOwnerFamilyCorrection(target!), JSON.stringify(target)).toBe(true);
    const correction: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'correct_owner_family_relationship',
      operationId: randomUUID(),
      targetRelationId: saved.ids.relationId!,
      expectedTargetRevision: target!.revision,
      replacement: {
        ...familyFields(request),
        predicate: 'partner_of',
        timing: 'past',
        validity: { validFrom: null, validUntil: null },
        expectedCanonicalState: { kind: 'absent' },
      },
    };
    const corrected = await f.run(correction);
    expect(corrected, JSON.stringify(corrected)).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      ids: { previousRelationId: saved.ids.relationId },
    });
    expect(f.rows('memories')).toHaveLength(2);
    expect(f.rows('knowledgeGraphRelations')).toHaveLength(2);
    const contacts = f.rows('contacts');
    expect(contacts.every((row) => row.trust === 'unknown')).toBe(true);
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(f.stats.unboundedQueries).toEqual([]);
    expect(f.stats.requests).toBeLessThan(128); // Includes preparation, replay, correction and explicit test reloads.
  });
  it('records stale endpoint conflict after held embedding without any primary source writes', async () => {
    const f = fixture(),
      request = await f.family();
    f.embed.mockImplementationOnce(async () => {
      f.seed('contacts', f.left, { ...f.rows('contacts')[0], id: f.left, name: 'Changed Alex' });
      return [[1, 0, 0]];
    });
    const result = await f.run(request);
    expect(result).toMatchObject({ authority: 'operation_receipt', outcome: 'conflict' });
    expect(f.rows('memories')).toHaveLength(0);
    expect(f.rows('knowledgeGraphRelations')).toHaveLength(0);
    expect(f.stats.readsAfterWrites).toBe(0);
  });
  it('does not revive data after completed erasure changes generation during embedding', async () => {
    const f = fixture(),
      request = await f.family();
    f.embed.mockImplementationOnce(async () => {
      f.seed('privacyErasureJobs', f.ownerId, {
        agentId: f.ownerId,
        status: 'complete',
        generation: randomUUID(),
      });
      return [[1, 0, 0]];
    });
    expect(await f.run(request)).toMatchObject({
      authority: 'scope_retirement',
      outcome: 'voided',
    });
    expect(f.rows('memories')).toHaveLength(0);
    expect(f.rows('knowledgeGraphRelations')).toHaveLength(0);
  });
  it('rejects added canonical evidence before another embedding or correction, with no sibling fanout', async () => {
    const f = fixture(),
      request = await f.family(),
      saved = await f.run(request);
    if (saved.outcome !== 'saved') throw new Error(JSON.stringify(saved));
    const target = await readFirestoreOwnerEditorGraphScope(
      f.store,
      f.ownerId,
      saved.ids.relationId!,
    );
    const proof = f.rows('knowledgeGraphAssertionEvidence')[0]!;
    const id = randomUUID();
    f.seed('knowledgeGraphAssertionEvidence', id, { ...proof, id, sourceMemoryId: randomUUID() });
    const correction: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'correct_owner_family_relationship',
      operationId: randomUUID(),
      targetRelationId: saved.ids.relationId!,
      expectedTargetRevision: target!.revision,
      replacement: {
        ...familyFields(request),
        predicate: 'partner_of',
        expectedCanonicalState: { kind: 'absent' },
      },
    };
    expect(await f.run(correction)).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'conflict',
    });
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.rows('memories')).toHaveLength(1);
    expect(f.rows('knowledgeGraphAssertions')[0]?.reviewStatus).toBe('confirmed');
  });
  it('keeps all primary records absent when the final receipt write fails', async () => {
    const f = fixture(),
      request = await f.family();
    f.embed.mockImplementationOnce(async () => {
      f.stats.failReceipt = true;
      return [[1, 0, 0]];
    });
    expect(await f.run(request)).toMatchObject({
      authority: 'unresolved',
      outcome: 'outcome_unknown',
    });
    for (const table of [
      'memories',
      'knowledgeGraphEntities',
      'knowledgeGraphRelations',
      'knowledgeGraphAssertions',
      'knowledgeGraphAssertionEvidence',
    ])
      expect(f.rows(table)).toHaveLength(0);
    expect(f.stats.readsAfterWrites).toBe(0);
  });
  it('uses actual person writer to create known and rename unknown with exact native CAS and no trust promotion', async () => {
    const f = fixture();
    const created = await f.run({
      version: 1,
      intent: 'apply',
      command: 'create_person',
      operationId: randomUUID(),
      name: 'Taylor',
      aliases: ['Tay'],
    });
    expect(created).toMatchObject({ outcome: 'saved', authority: 'operation_receipt' });
    expect(f.rows('contacts').find((row) => row.name === 'Taylor')).toMatchObject({
      trust: 'known',
      relationship: '',
    });
    const before = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'update_person_identity',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: before!.revision,
      name: 'Alex New',
      aliases: ['Al'],
      relationship: 'sister',
    };
    expect(await f.run(request)).toMatchObject({ outcome: 'saved' });
    expect(f.rows('contacts').find((row) => row.id === f.left)).toMatchObject({
      name: 'Alex New',
      trust: 'unknown',
      aliases: ['Al', 'Alex'],
      relationship: 'sister',
    });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(f.stats.unboundedQueries).toEqual([]);
  });
  it('preserves the saved owner relationship when an older identity request omits it', async () => {
    const f = fixture();
    const original = f.rows('contacts').find((row) => row.id === f.left);
    if (!original) throw new Error('Missing contact');
    f.seed('contacts', f.left, { ...original, relationship: 'daughter' });
    const before = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    const result = await f.run({
      version: 1,
      intent: 'apply',
      command: 'update_person_identity',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: before!.revision,
      name: 'Alex Updated',
      aliases: [],
    });
    expect(result).toMatchObject({ outcome: 'saved', authority: 'operation_receipt' });
    expect(f.rows('contacts').find((row) => row.id === f.left)).toMatchObject({
      name: 'Alex Updated',
      relationship: 'daughter',
    });
  });
  it('saves a relationship-only edit through the same identity receipt', async () => {
    const f = fixture();
    const original = f.rows('contacts').find((row) => row.id === f.left);
    if (!original) throw new Error('Missing contact');
    f.seed('contacts', f.left, { ...original, relationship: 'daughter' });
    const before = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    const result = await f.run({
      version: 1,
      intent: 'apply',
      command: 'update_person_identity',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: before!.revision,
      name: before!.name,
      aliases: before!.aliases,
      relationship: 'sister',
    });
    expect(result).toMatchObject({ outcome: 'saved', authority: 'operation_receipt' });
    expect(f.rows('contacts').find((row) => row.id === f.left)).toMatchObject({
      name: 'Alex',
      relationship: 'sister',
    });
  });
  it('rechecks native person updateTime after preparation and before primary mutation', async () => {
    const f = fixture(),
      before = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'update_person_identity',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: before!.revision,
      name: 'Changed draft',
      aliases: [],
    };
    const scope = f.scope(request),
      reservation = await f.operations.reserve(scope, ownerEditorRequestHash(request), new Date());
    if (reservation.kind !== 'claimed') throw new Error('Claim not granted');
    const prepared = await f.domain.prepare(request, scope);
    if (!prepared.ok) throw new Error('Preparation not granted');
    f.seed('contacts', f.left, {
      ...f.rows('contacts').find((row) => row.id === f.left)!,
      notes: 'changed at native nanos',
    });
    const after = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    expect(after?.revision).not.toBe(before?.revision);
    expect(await f.domain.commit(reservation.claim, prepared.prepared, new Date())).toMatchObject({
      outcome: 'conflict',
      authority: 'operation_receipt',
    });
    expect(f.rows('contacts').find((row) => row.id === f.left)?.name).toBe('Alex');
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('displays missing legacy relationships as empty without backfill and keeps stale native CAS', async () => {
    const f = fixture();
    const legacyTarget = f.rows('contacts').find((row) => row.id === f.left);
    if (!legacyTarget) throw new Error('Missing target contact');
    delete legacyTarget.relationship;
    f.seed('contacts', f.left, legacyTarget);
    const unrelatedId = randomUUID();
    f.seed('contacts', unrelatedId, {
      id: unrelatedId,
      agentId: f.ownerId,
      name: 'Unrelated legacy person',
      trust: 'known',
      aliases: [],
      emails: [],
      phones: [],
      notes: '',
    });

    const before = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    expect(before?.relationship).toBe('');
    const view = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: f.left,
    });
    expect(view.identity).toMatchObject({ contactId: f.left, relationship: '' });
    expect(view.people.map((person) => person.contactId)).toContain(unrelatedId);
    expect(
      Object.hasOwn(f.rows('contacts').find((row) => row.id === f.left)!, 'relationship'),
    ).toBe(false);

    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'update_person_identity',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: before!.revision,
      name: 'Changed legacy draft',
      aliases: [],
      relationship: 'daughter',
    };
    const scope = f.scope(request);
    const reservation = await f.operations.reserve(
      scope,
      ownerEditorRequestHash(request),
      new Date(),
    );
    if (reservation.kind !== 'claimed') throw new Error('Claim not granted');
    const prepared = await f.domain.prepare(request, scope);
    if (!prepared.ok) throw new Error('Preparation not granted');

    const changedTarget = f.rows('contacts').find((row) => row.id === f.left);
    if (!changedTarget) throw new Error('Missing target contact');
    f.seed('contacts', f.left, { ...changedTarget, notes: 'intervening native change' });
    expect(await f.domain.commit(reservation.claim, prepared.prepared, new Date())).toMatchObject({
      outcome: 'conflict',
      authority: 'operation_receipt',
    });
    const after = f.rows('contacts').find((row) => row.id === f.left);
    expect(after?.name).toBe('Alex');
    expect(Object.hasOwn(after ?? {}, 'relationship')).toBe(false);
  });
  it('counts the complete duplicate-contact sentinel before decoding malformed rows', async () => {
    const f = fixture();
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      f.seed('contacts', id, { id, agentId: f.ownerId });
    }
    const result = await f.run({
      version: 1,
      intent: 'apply',
      command: 'create_person',
      operationId: randomUUID(),
      name: 'Extra person',
      aliases: [],
    });
    expect(result).toMatchObject({
      outcome: 'unavailable',
      authority: 'operation_receipt',
      reason: 'contact_read_limit',
    });
    expect(f.rows('contacts')).toHaveLength(502);
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.stats.raw).toBeLessThan(520);
  });
  it('does not acknowledge a changed draft as the already-saved original operation', async () => {
    const f = fixture(),
      request = await f.family(),
      scope = f.scope(request);
    const saved = await f.run(request, scope);
    expect(await f.run({ ...request, note: 'Different draft' }, scope)).toMatchObject({
      outcome: 'conflict',
      authority: 'request_rejection',
      originalOperationTerminal: false,
    });
    expect(await f.run(request, scope)).toEqual(saved);
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.rows('memories')).toHaveLength(1);
  });
  it('treats prospective-absence collision as unchanged without another embedding/evidence write', async () => {
    const f = fixture(),
      request = await f.family();
    const first = await f.run(request);
    expect(first.outcome).toBe('saved');
    const second = await f.run({
      ...request,
      operationId: randomUUID(),
      expectedCanonicalState: { kind: 'absent' },
    });
    expect(second).toMatchObject({ authority: 'operation_receipt', outcome: 'unchanged' });
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.rows('memories')).toHaveLength(1);
    expect(f.rows('knowledgeGraphAssertionEvidence')).toHaveLength(1);
  });
  it.each(['parent_of', 'sibling_of'] as const)(
    'retires the old %s relation on a note-only correction while preserving one confirmed canonical statement (fake Firestore, not PostgreSQL proof)',
    async (predicate) => {
      const f = fixture();
      const original = await f.family();
      const request = {
        ...original,
        predicate,
        validity:
          predicate === 'sibling_of' ? { validFrom: null, validUntil: null } : original.validity,
      };
      const saved = await f.run(request);
      if (saved.outcome !== 'saved') throw new Error(JSON.stringify(saved));
      const originalRelationId = saved.ids.relationId;
      if (!originalRelationId || !saved.ids.memoryId || !saved.ids.assertionId)
        throw new Error('Missing original saved family identities');
      const target = await readFirestoreOwnerEditorGraphScope(
        f.store,
        f.ownerId,
        originalRelationId,
      );
      if (!target) throw new Error('Missing displayed correction target');
      const originalAssertion = f.rows('knowledgeGraphAssertions')[0];
      if (!originalAssertion) throw new Error('Missing original canonical assertion');
      const result = await f.run({
        version: 1,
        intent: 'apply',
        command: 'correct_owner_family_relationship',
        operationId: randomUUID(),
        targetRelationId: originalRelationId,
        expectedTargetRevision: target.revision,
        replacement: {
          ...familyFields(request),
          note: 'Corrected owner note',
          expectedCanonicalState: { kind: 'absent' },
        },
      });
      expect(result).toMatchObject({
        outcome: 'saved',
        ids: { assertionId: saved.ids.assertionId, previousRelationId: saved.ids.relationId },
      });
      if (result.outcome !== 'saved') throw new Error(JSON.stringify(result));
      expect(result.ids.relationId).not.toBe(saved.ids.relationId);
      expect(result.ids.memoryId).not.toBe(saved.ids.memoryId);

      const relations = f.rows('knowledgeGraphRelations');
      expect(relations).toHaveLength(2);
      const oldRelation = relations.find((row) => row.id === saved.ids.relationId);
      const newRelation = relations.find((row) => row.id === result.ids.relationId);
      expect(oldRelation).toMatchObject({
        id: saved.ids.relationId,
        agentId: f.ownerId,
        reviewStatus: 'rejected',
        assertionId: saved.ids.assertionId,
        sourceMemoryId: saved.ids.memoryId,
        correctedByRelationId: result.ids.relationId,
        correctionDisposition: 'whole_fact',
        correctionSourceContentHash: target.source.contentHash,
      });
      expect(newRelation).toMatchObject({
        id: result.ids.relationId,
        agentId: f.ownerId,
        reviewStatus: 'confirmed',
        assertionId: saved.ids.assertionId,
        sourceMemoryId: result.ids.memoryId,
        subjectEntityId: oldRelation?.subjectEntityId,
        objectEntityId: oldRelation?.objectEntityId,
        predicate,
        ...request.validity,
        correctedByRelationId: null,
        correctionDisposition: null,
        correctionSourceContentHash: null,
      });

      const memories = f.rows('memories');
      expect(memories).toHaveLength(2);
      const oldMemory = memories.find((row) => row.id === saved.ids.memoryId);
      const newMemory = memories.find((row) => row.id === result.ids.memoryId);
      expect(oldMemory).toMatchObject({
        agentId: f.ownerId,
        contentHash: target.source.contentHash,
        supersededById: result.ids.memoryId,
      });
      expect(oldMemory?.content).toContain(request.note);
      expect(newMemory).toMatchObject({
        agentId: f.ownerId,
        source: 'knowledge-graph-owner',
        ownerConfirmed: true,
        originTrust: 'owner',
        supersededById: null,
      });
      expect(newMemory?.content).toContain('Corrected owner note');
      expect(newMemory?.content).not.toContain(request.note);

      const assertions = f.rows('knowledgeGraphAssertions');
      expect(assertions).toHaveLength(1);
      const current = assertions[0];
      expect(current).toMatchObject({
        id: saved.ids.assertionId,
        agentId: f.ownerId,
        semanticKey: originalAssertion.semanticKey,
        semanticRevision: originalAssertion.semanticRevision,
        lifecycle: 'current',
        reviewStatus: 'confirmed',
        ownerAuthored: true,
        reviewedRevision: originalAssertion.semanticRevision,
        reviewedPayloadHash: originalAssertion.semanticKey,
        supersededById: null,
      });
      expect(f.embed).toHaveBeenCalledTimes(2);
      expect(f.stats.readsAfterWrites).toBe(0);
    },
  );
  it('touches only the existing epoch at final commit, never reservation or receipt GET, without retiring scopes', async () => {
    const f = fixture(),
      request: OwnerEditorApply = {
        version: 1,
        intent: 'apply',
        command: 'create_person',
        operationId: randomUUID(),
        name: 'Serial contact',
        aliases: [],
      },
      scope = f.scope(request);
    const cursor = f.rows('maintenanceCursors')[0]?.cursor;
    const reserved = await f.operations.reserve(scope, ownerEditorRequestHash(request), new Date());
    if (reserved.kind !== 'claimed') throw new Error(JSON.stringify(reserved));
    await f.operations.lookup(scope, new Date());
    expect(f.stats.writes).toEqual(['ownerEditorOperations']);
    const prepared = await f.domain.prepare(request, scope);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    const saved = await f.domain.commit(reserved.claim, prepared.prepared, new Date());
    expect(saved.outcome).toBe('saved');
    expect(f.stats.writes.filter((table) => table === 'maintenanceCursors')).toHaveLength(1);
    expect(f.rows('maintenanceCursors')).toHaveLength(1);
    expect(f.rows('maintenanceCursors')[0]?.cursor).toBe(cursor);
    const writes = f.stats.writes.length;
    expect((await f.operations.lookup(scope, new Date())).reply).toEqual(saved);
    expect(f.stats.writes).toHaveLength(writes);
    expect(f.stats.readsAfterWrites).toBe(0);
  });
  it('protects an identical legacy identity with a metadata-only owner promotion and an idempotent receipt', async () => {
    const f = fixture(),
      cursor = f.rows('maintenanceCursors')[0]?.cursor,
      before = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    if (!before) throw new Error('Missing originally displayed contact');
    const original = f.rows('contacts').find((row) => row.id === f.left);
    if (!original) throw new Error('Missing legacy contact');
    const request: Extract<OwnerEditorApply, { command: 'update_person_identity' }> = {
      version: 1,
      intent: 'apply',
      command: 'update_person_identity',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: before.revision,
      name: 'Alex',
      aliases: [],
    };
    const scope = f.scope(request);
    const result = await f.run(request, scope);
    expect(result).toMatchObject({ outcome: 'unchanged', authority: 'operation_receipt' });
    expect(f.stats.writes.filter((table) => table !== 'ownerEditorOperations')).toEqual([
      'contacts',
      'maintenanceCursors',
    ]);
    const promoted = f.rows('contacts').find((row) => row.id === f.left);
    if (!promoted) throw new Error('Missing protected contact');
    const {
      identityAuthority: previousAuthority,
      updatedAt: _previousTime,
      ...originalFields
    } = original;
    const { identityAuthority, updatedAt: _promotedTime, ...promotedFields } = promoted;
    expect(previousAuthority ?? null).toBeNull();
    expect(identityAuthority).toBe('owner');
    expect(promotedFields).toEqual(originalFields);
    const writes = f.stats.writes.length;
    expect(await f.run(request, scope)).toEqual(result);
    expect(f.stats.writes).toHaveLength(writes);
    expect(f.rows('maintenanceCursors')[0]?.cursor).toBe(cursor);
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('does not rewrite an already owner-protected identical identity or its graph', async () => {
    const f = fixture();
    const cursor = f.rows('maintenanceCursors')[0]?.cursor;
    const original = f.rows('contacts').find((row) => row.id === f.left);
    if (!original) throw new Error('Missing contact');
    f.seed('contacts', f.left, { ...original, identityAuthority: 'owner' });
    const before = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.left);
    if (!before) throw new Error('Missing originally displayed contact');
    expect(
      await f.run({
        version: 1,
        intent: 'apply',
        command: 'update_person_identity',
        operationId: randomUUID(),
        contactId: f.left,
        expectedContactRevision: before.revision,
        name: 'Alex',
        aliases: [],
      }),
    ).toMatchObject({ outcome: 'unchanged', authority: 'operation_receipt' });
    expect(f.stats.writes.filter((table) => table !== 'ownerEditorOperations')).toEqual([
      'maintenanceCursors',
    ]);
    expect(f.rows('maintenanceCursors')[0]?.cursor).toBe(cursor);
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('removes a person through displayed impact, signed scope, normal claim/receipt, replay, and canonical readback', async () => {
    const f = fixture();
    const now = new Date();
    const factId = randomUUID();
    const factContent = 'Alex prefers a short weekly update.';
    const factHash = createHash('sha256').update(factContent).digest('hex');
    const retainedSourceId = randomUUID();
    const retainedContent = 'Original source note mentioning Alex.';
    const retainedHash = createHash('sha256').update(retainedContent).digest('hex');
    const spaceKey = embeddingSpaceIdentityKey({
      provider: 'test',
      model: 'unit',
      dimensions: 3,
      revision: '1',
    });
    f.seed('memories', factId, {
      id: factId,
      agentId: f.ownerId,
      createdAt: now,
      content: factContent,
      contentHash: factHash,
      category: 'knowledge',
      source: 'manual',
      sourceTaskId: null,
      subjectContactId: f.left,
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      kind: 'fact',
      domain: 'relationships',
      originTrust: 'known',
      ownerConfirmed: false,
      confidence: '0.70',
      importance: 3,
      pinned: false,
      validFrom: null,
      validUntil: null,
      goalId: null,
      embedding: [1, 0, 0],
      embeddingSpaceKey: spaceKey,
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    });
    f.seed('memoryContentHashes', factHash, { memoryId: factId });
    f.seed('memories', retainedSourceId, {
      id: retainedSourceId,
      agentId: f.ownerId,
      createdAt: now,
      content: retainedContent,
      contentHash: retainedHash,
      category: 'knowledge',
      source: 'manual',
      sourceTaskId: null,
      subjectContactId: null,
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      kind: 'fact',
      domain: 'relationships',
      originTrust: 'known',
      ownerConfirmed: false,
      confidence: '0.70',
      importance: 3,
      pinned: false,
      validFrom: null,
      validUntil: null,
      goalId: null,
      embedding: [1, 0, 0],
      embeddingSpaceKey: spaceKey,
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    });
    const entityId = randomUUID();
    f.seed('knowledgeGraphEntities', entityId, {
      id: entityId,
      agentId: f.ownerId,
      kind: 'person',
      canonicalKey: `contact:${f.left}`,
      label: 'Alex',
      preferredLabel: null,
      contactId: f.left,
      createdAt: now,
      updatedAt: now,
    });
    f.seed('knowledgeGraphSources', retainedSourceId, {
      memoryId: retainedSourceId,
      agentId: f.ownerId,
      status: 'ready',
      lastError: null,
      contentHash: retainedHash,
      subjectContactId: f.left,
      extractionVersion: 1,
      nextRetryAt: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    const relationId = randomUUID();
    f.seed('knowledgeGraphRelations', relationId, {
      id: relationId,
      agentId: f.ownerId,
      subjectEntityId: entityId,
      objectEntityId: randomUUID(),
      sourceMemoryId: retainedSourceId,
      assertionId: randomUUID(),
      predicate: 'knows',
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      reviewStatus: 'confirmed',
      sourceFingerprint: 'fixture-source',
      confidence: '0.9',
      validFrom: null,
      validUntil: null,
      evidenceQuote: null,
      ordinal: 0,
      createdAt: now,
    });

    const displayed = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: f.left,
    });
    expect(displayed.identity?.revision).toBeTruthy();
    expect(displayed.personRemoval, displayed.personRemovalUnavailableReason).toMatchObject({
      contactId: f.left,
      facts: 1,
      occasions: 0,
      connections: 1,
      retainedSourceNotes: 1,
      entityLinks: 1,
      sourceLinks: 1,
    });
    const impact = displayed.personRemoval;
    if (!impact || !displayed.identity) throw new Error('Person removal impact was unavailable');
    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'remove_person',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: displayed.identity.revision,
      expectedImpactRevision: impact.revision,
    };
    const scope = f.scope(request);
    const removed = await f.run(request, scope);
    expect(removed).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      command: 'remove_person',
      operationId: request.operationId,
      ids: { contactId: f.left },
    });
    const writesAfterCommit = f.stats.writes.length;
    expect(await f.run(request, scope)).toEqual(removed);
    expect(f.stats.writes).toHaveLength(writesAfterCommit);
    expect(f.rows('contacts').some((row) => row.id === f.left)).toBe(false);
    expect(f.rows('memories').some((row) => row.id === factId)).toBe(false);
    expect(f.rows('memoryTombstones')).toContainEqual(
      expect.objectContaining({ contentHash: factHash }),
    );
    expect(f.rows('memoryContentHashes').some((row) => row.memoryId === factId)).toBe(false);
    expect(f.rows('graphDeletionIntents')).toContainEqual(
      expect.objectContaining({ memoryId: factId }),
    );
    expect(f.rows('memories').some((row) => row.id === retainedSourceId)).toBe(true);
    expect(
      f.rows('knowledgeGraphSources').find((row) => row.memoryId === retainedSourceId)
        ?.subjectContactId,
    ).toBeNull();
    expect(
      f.rows('knowledgeGraphEntities').find((row) => row.id === entityId)?.contactId,
    ).toBeNull();
    expect(f.rows('knowledgeGraphRelations').find((row) => row.id === relationId)).toBeDefined();
    expect(f.rows('ownerCards').find((row) => row.agentId === f.ownerId)?.content).toBe('');
    const readback = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: f.left,
    });
    expect(readback.identity).toBeNull();
    expect(readback.people.some((person) => person.contactId === f.left)).toBe(false);
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(f.stats.unboundedQueries).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('terminally conflicts when removal-impact membership changes after preparation', async () => {
    const f = fixture();
    const displayed = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: f.left,
    });
    if (!displayed.identity || !displayed.personRemoval)
      throw new Error('Expected exact person-removal impact');
    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'remove_person',
      operationId: randomUUID(),
      contactId: f.left,
      expectedContactRevision: displayed.identity.revision,
      expectedImpactRevision: displayed.personRemoval.revision,
    };
    const scope = f.scope(request);
    const reservation = await f.operations.reserve(
      scope,
      ownerEditorRequestHash(request),
      new Date(),
    );
    if (reservation.kind !== 'claimed') throw new Error(JSON.stringify(reservation));
    const prepared = await f.domain.prepare(request, scope);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    const occasionId = randomUUID();
    f.seed('occasions', occasionId, {
      id: occasionId,
      agentId: f.ownerId,
      contactId: f.left,
      kind: 'birthday',
      month: 6,
      day: 2,
      year: null,
    });

    const reply = await f.domain.commit(reservation.claim, prepared.prepared, new Date());
    expect(reply).toMatchObject({ authority: 'operation_receipt', outcome: 'conflict' });
    expect(f.rows('contacts').some((row) => row.id === f.left)).toBe(true);
    expect(f.rows('occasions').some((row) => row.id === occasionId)).toBe(true);
    expect(f.rows('memoryTombstones')).toHaveLength(0);
    expect(f.rows('ownerEditorOperations')[0]).toMatchObject({ status: 'terminal_rejected' });
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(f.stats.unboundedQueries).toEqual([]);
  });
});
