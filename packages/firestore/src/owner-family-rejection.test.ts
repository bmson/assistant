import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionSemanticKey,
  type OwnerEditorApply,
  type OwnerEditorClaim,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
  type Records,
} from '@assistant/persistence';
import { presentOwnerFamilyFact } from '@assistant/persistence/owner-family-presentation';
import { parseInactiveOwnerFamilyRemovalOperationRecord } from '@assistant/persistence/owner-family-rejection-storage';
import { describe, expect, it } from 'vitest';
import { ownerEditorTestStore } from './owner-editor-test-store.js';
import {
  readOwnerFamilyRejectionReview,
  rejectOwnerFamilyClaimInFirestore,
} from './owner-family-rejection.js';

const ids = {
  owner: '11111111-1111-4111-8111-111111111111',
  relation: '22222222-2222-4222-8222-222222222222',
  memory: '33333333-3333-4333-8333-333333333333',
  assertion: '44444444-4444-4444-8444-444444444444',
  evidence: '55555555-5555-4555-8555-555555555555',
  subjectEntity: '66666666-6666-4666-8666-666666666666',
  objectEntity: '77777777-7777-4777-8777-777777777777',
  subjectContact: '88888888-8888-4888-8888-888888888888',
  objectContact: '99999999-9999-4999-8999-999999999999',
};

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function applyHash(request: OwnerEditorApply) {
  return hash(`owner-editor-apply-v1\n${stableJson(request)}`);
}

function fixture(
  endpoints: { subjectEntity: string; objectEntity: string } = {
    subjectEntity: ids.subjectEntity,
    objectEntity: ids.objectEntity,
  },
) {
  const f = ownerEditorTestStore();
  Object.assign(f.store, {
    installationId: 'inactive-writer-test-lineage',
    projectId: 'inactive-writer-test-project',
    databaseId: '(default)',
  });
  const now = f.store.now();
  const epoch = randomUUID();
  const retrievalRevision = randomUUID();
  const sourceText = `${presentOwnerFamilyFact({
    subjectLabel: 'Alex',
    predicate: 'sibling_of',
    objectLabel: 'Sam',
    timing: 'present',
    validity: { validFrom: null, validUntil: null },
  })} Owner note: I recorded this wording after we discussed it.`;
  const contentHash = hash(sourceText);
  const assertionMeaning = canonicalizeKnowledgeAssertionDirection({
    subjectEntityId: endpoints.subjectEntity,
    objectEntityId: endpoints.objectEntity,
    predicate: 'sibling_of',
    assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
    validFrom: null,
    validUntil: null,
    qualifiers: {},
  });
  const semanticKey = knowledgeAssertionSemanticKey(ids.owner, assertionMeaning);
  f.seed('agents', ids.owner, { id: ids.owner, timezone: 'UTC', locale: 'en' });
  f.seed('maintenanceCursors', `owner-editor-epoch:${ids.owner}`, {
    name: `owner-editor-epoch:${ids.owner}`,
    cursor: JSON.stringify({
      ownerId: ids.owner,
      epoch,
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    }),
  });
  f.seed('maintenanceCursors', `owner-source-rejection:${ids.owner}`, {
    name: `owner-source-rejection:${ids.owner}`,
    cursor: JSON.stringify({
      version: 1,
      ownerId: ids.owner,
      installationLineageId: 'inactive-writer-test-lineage',
      revision: randomUUID(),
      protocolVersion: 1,
      state: 'active',
    }),
  });
  const memory: Records['memories'] & { retrievalRevision: string } = {
    id: ids.memory,
    createdAt: now,
    agentId: ids.owner,
    expiresAt: null,
    embedding: [1, 0, 0],
    sourceTaskId: null,
    kind: 'fact',
    confidence: '1.00',
    contentHash,
    goalId: null,
    originTrust: 'owner',
    category: 'knowledge',
    content: sourceText,
    importance: 3,
    quarantined: false,
    subjectContactId: ids.subjectContact,
    domain: 'other',
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: true,
    pinned: false,
    source: 'knowledge-graph-owner',
    embeddingSpaceKey: null,
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    retrievalRevision,
  };
  const relation: Records['knowledgeGraphRelations'] = {
    id: ids.relation,
    createdAt: now,
    agentId: ids.owner,
    sourceFingerprint: 'owner-family-source-one',
    confidence: '1.00',
    validFrom: null,
    validUntil: null,
    subjectEntityId: endpoints.subjectEntity,
    predicate: 'sibling_of',
    assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
    assertionId: ids.assertion,
    objectEntityId: endpoints.objectEntity,
    sourceMemoryId: ids.memory,
    evidenceQuote: sourceText,
    ordinal: 1,
    reviewStatus: 'confirmed',
    reviewedAt: now,
    correctedByRelationId: null,
    correctionSourceContentHash: null,
    correctionDisposition: null,
  };
  const assertion: Records['knowledgeGraphAssertions'] = {
    id: ids.assertion,
    agentId: ids.owner,
    semanticKey,
    subjectEntityId: assertionMeaning.subjectEntityId,
    predicate: assertionMeaning.predicate,
    objectEntityId: assertionMeaning.objectEntityId,
    assertion: assertionMeaning.assertion,
    qualifiers: {},
    validFrom: null,
    validUntil: null,
    semanticRevision: 1,
    evidenceRevision: 1,
    lifecycle: 'current',
    reviewStatus: 'confirmed',
    reviewedRevision: 1,
    reviewedPayloadHash: semanticKey,
    ownerAuthored: true,
    supersededById: null,
    createdAt: now,
    updatedAt: now,
  };
  const evidence: Records['knowledgeGraphAssertionEvidence'] = {
    id: ids.evidence,
    agentId: ids.owner,
    assertionId: ids.assertion,
    sourceMemoryId: ids.memory,
    sourceFingerprint: relation.sourceFingerprint,
    sourceContentHash: contentHash,
    evidenceQuote: sourceText,
    sourceAuthor: 'owner',
    sourceTrust: 'owner',
    independent: false,
    spanStart: 0,
    spanEnd: sourceText.length,
    extractionVersion: 1,
    evidenceRevision: 1,
    observedAt: now,
    createdAt: now,
  };
  const entity = (
    id: string,
    contactId: string,
    label: string,
  ): Records['knowledgeGraphEntities'] => ({
    id,
    createdAt: now,
    updatedAt: now,
    agentId: ids.owner,
    kind: 'person',
    canonicalKey: `contact:${contactId}`,
    label,
    preferredLabel: null,
    contactId,
  });
  const contact = (id: string, name: string): Records['contacts'] => ({
    id,
    name,
    createdAt: now,
    updatedAt: now,
    trust: 'known',
    identityAuthority: 'inferred',
    aliases: [],
    emails: [],
    phones: [],
    relationship: '',
    notes: '',
  });
  f.seed('memories', ids.memory, memory);
  f.seed('memoryContentHashes', contentHash, { memoryId: ids.memory });
  f.seed('knowledgeGraphSources', ids.memory, {
    memoryId: ids.memory,
    agentId: ids.owner,
    contentHash,
    subjectContactId: ids.subjectContact,
    extractionVersion: 1,
    retrievalRevision,
    status: 'ready',
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
    claimToken: null,
    createdAt: now,
    updatedAt: now,
  });
  f.seed('knowledgeGraphRelations', ids.relation, relation);
  f.seed('knowledgeGraphAssertions', ids.assertion, assertion);
  f.seed('knowledgeGraphAssertionEvidence', ids.evidence, evidence);
  f.seed(
    'knowledgeGraphEntities',
    endpoints.subjectEntity,
    entity(endpoints.subjectEntity, ids.subjectContact, 'Alex'),
  );
  f.seed(
    'knowledgeGraphEntities',
    endpoints.objectEntity,
    entity(endpoints.objectEntity, ids.objectContact, 'Sam'),
  );
  f.seed('contacts', ids.subjectContact, contact(ids.subjectContact, 'Alex'));
  f.seed('contacts', ids.objectContact, contact(ids.objectContact, 'Sam'));
  f.seed('ownerCards', ids.owner, {
    agentId: ids.owner,
    content: 'Cached owner family card',
    compiledAt: now,
    invalidatedAt: null,
  });
  return {
    ...f,
    now,
    epoch,
    retrievalRevision,
    sourceText,
    contentHash,
    memory,
    relation,
    assertion,
    evidence,
  };
}

async function prepared(f: ReturnType<typeof fixture>, options: { operationId?: string } = {}) {
  const operationId = options.operationId ?? randomUUID();
  const scope: OwnerEditorScope = {
    ownerId: ids.owner,
    sessionDigest: 'a'.repeat(64),
    epoch: f.epoch,
    privacyGeneration: null,
    command: 'remove_owner_family_relationship',
    operationId,
    targetId: ids.relation,
    nonce: randomUUID(),
    issuedAt: f.now.getTime() - 1_000,
    expiresAt: f.now.getTime() + 600_000,
  };
  const review = await readOwnerFamilyRejectionReview({
    store: f.store,
    ownerId: ids.owner,
    relationId: ids.relation,
    scope,
  });
  if (!review) throw new Error('Expected eligible source review');
  const request: Extract<OwnerEditorApply, { command: 'remove_owner_family_relationship' }> = {
    version: 1,
    intent: 'apply',
    command: 'remove_owner_family_relationship',
    operationId,
    targetRelationId: ids.relation,
    expectedTargetRevision: review.revision,
  };
  const claim: OwnerEditorClaim = {
    scope,
    requestHash: applyHash(request),
    claimToken: randomUUID(),
    claimExpiresAt: new Date(f.now.getTime() + 60_000),
    statusVersion: 1,
  };
  f.seed(
    'ownerEditorOperations',
    ownerEditorOperationId(scope),
    parseInactiveOwnerFamilyRemovalOperationRecord({
      id: ownerEditorOperationId(scope),
      ownerId: ids.owner,
      epoch: scope.epoch,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      operationId,
      requestHash: claim.requestHash,
      scopeDigest: ownerEditorScopeDigest(scope),
      command: 'remove_owner_family_relationship',
      protocolVersion: 1,
      formIssuedAt: new Date(scope.issuedAt),
      formExpiresAt: new Date(scope.expiresAt),
      claimToken: claim.claimToken,
      claimExpiresAt: claim.claimExpiresAt,
      status: 'preparing',
      statusVersion: 1,
      result: null,
      createdAt: f.now,
      updatedAt: f.now,
    }),
  );
  return { claim, request };
}

function apply(f: ReturnType<typeof fixture>, preparedValue: Awaited<ReturnType<typeof prepared>>) {
  return rejectOwnerFamilyClaimInFirestore({
    store: f.store,
    configuredOwnerId: ids.owner,
    claim: preparedValue.claim,
    request: preparedValue.request,
    now: f.now,
  });
}

describe('inactive exact owner-family source rejection transaction', () => {
  it('retains the note and evidence, rejects only its projection, retracts zero support, advances the cursor and replays the same receipt', async () => {
    const f = fixture();
    const preparedValue = await prepared(f);
    const reply = await apply(f, preparedValue);
    expect(reply).toMatchObject({
      command: 'remove_owner_family_relationship',
      operationId: preparedValue.claim.scope.operationId,
      outcome: 'saved',
      ids: { relationId: ids.relation, memoryId: ids.memory, assertionId: ids.assertion },
    });
    expect(f.rows('ownerFamilyClaimRejections')).toHaveLength(1);
    expect(f.rows('ownerFamilyClaimRejections')[0]).toMatchObject({
      installationLineageId: 'inactive-writer-test-lineage',
      ownerId: ids.owner,
      sourceMemoryId: ids.memory,
      state: 'active',
      original: { relationId: ids.relation, assertionId: ids.assertion, evidenceId: ids.evidence },
      reviewClosureHash: preparedValue.request.expectedTargetRevision,
    });
    expect(f.rows('memories')[0]).toMatchObject({
      id: ids.memory,
      content: f.sourceText,
      contentHash: f.contentHash,
    });
    expect(f.rows('knowledgeGraphAssertionEvidence')).toHaveLength(1);
    expect(f.rows('knowledgeGraphRelations')[0]).toMatchObject({
      id: ids.relation,
      reviewStatus: 'rejected',
    });
    expect(f.rows('knowledgeGraphAssertions')[0]).toMatchObject({
      id: ids.assertion,
      lifecycle: 'retracted',
      reviewStatus: 'unreviewed',
      reviewedRevision: null,
      reviewedPayloadHash: null,
      ownerAuthored: false,
    });
    expect(f.rows('ownerCards')[0]).toMatchObject({ agentId: ids.owner, content: '' });
    expect(f.rows('ownerCards')[0]?.invalidatedAt).toBeDefined();
    const writes = [...f.stats.writes];
    expect(
      await rejectOwnerFamilyClaimInFirestore({
        store: f.store,
        configuredOwnerId: ids.owner,
        claim: preparedValue.claim,
        request: preparedValue.request,
        now: new Date(f.now.getTime() + 120_000),
      }),
    ).toEqual(reply);
    expect(f.stats.writes).toEqual(writes);
  });

  it('keeps contact meaning stable when regenerated graph entity IDs reverse symmetric ordering', async () => {
    const original = fixture();
    const regenerated = fixture({
      subjectEntity: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      objectEntity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(original.assertion.semanticKey).not.toBe(regenerated.assertion.semanticKey);
    for (const current of [original, regenerated])
      expect(await apply(current, await prepared(current))).toMatchObject({ outcome: 'saved' });
    const first = original.rows('ownerFamilyClaimRejections')[0];
    const second = regenerated.rows('ownerFamilyClaimRejections')[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).toMatchObject({
      id: first?.id,
      stableContactMeaningKey: first?.stableContactMeaningKey,
      meaning: first?.meaning,
    });
  });

  it('aborts every staged domain write if the terminal receipt cannot be written', async () => {
    const f = fixture();
    const preparedValue = await prepared(f);
    f.stats.failReceipt = true;
    await expect(apply(f, preparedValue)).rejects.toThrow('Injected receipt write failure');
    expect(f.rows('ownerFamilyClaimRejections')).toHaveLength(0);
    expect(f.rows('knowledgeGraphRelations')[0]).toMatchObject({ reviewStatus: 'confirmed' });
    expect(f.rows('knowledgeGraphAssertions')[0]).toMatchObject({
      lifecycle: 'current',
      ownerAuthored: true,
    });
    expect(f.rows('memories')[0]).toMatchObject({
      content: f.sourceText,
      contentHash: f.contentHash,
    });
    expect(f.rows('knowledgeGraphAssertionEvidence')).toHaveLength(1);
    expect(f.rows('ownerEditorOperations')[0]).toMatchObject({ status: 'preparing', result: null });
    expect(f.rows('ownerCards')[0]).toMatchObject({
      content: 'Cached owner family card',
      invalidatedAt: null,
    });
  });

  it('charges operation and control reads against the bounded full-closure budget', async () => {
    const f = fixture();
    const preparedValue = await prepared(f);
    const extra = (index: number) =>
      `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    for (let index = 0; index < 24; index++) {
      const id = extra(index + 1);
      f.seed('knowledgeGraphAssertionEvidence', id, {
        ...f.evidence,
        id,
        assertionId: extra(index + 1_000),
        sourceMemoryId: ids.memory,
      });
      f.seed('knowledgeGraphRelations', id, {
        ...f.relation,
        id,
        assertionId: extra(index + 2_000),
        sourceMemoryId: ids.memory,
      });
    }
    for (let index = 0; index < 99; index++) {
      const evidenceId = extra(index + 3_000);
      const relationId = extra(index + 4_000);
      const assertionId = extra(index + 5_000);
      f.seed('knowledgeGraphAssertionEvidence', evidenceId, {
        ...f.evidence,
        id: evidenceId,
        assertionId: ids.assertion,
        sourceMemoryId: extra(index + 6_000),
      });
      f.seed('knowledgeGraphRelations', relationId, {
        ...f.relation,
        id: relationId,
        assertionId: ids.assertion,
        sourceMemoryId: extra(index + 7_000),
      });
      f.seed('knowledgeGraphAssertions', assertionId, {
        ...f.assertion,
        id: assertionId,
        semanticKey: f.assertion.semanticKey,
      });
    }

    const readsBeforeApply = f.stats.raw;
    const reply = await apply(f, preparedValue);
    expect(reply).toMatchObject({
      authority: 'unresolved',
      outcome: 'outcome_unknown',
      reason: 'receipt_unavailable',
    });
    expect(f.stats.raw - readsBeforeApply).toBeLessThanOrEqual(256);
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(f.stats.unboundedQueries).toEqual([]);
    expect(f.rows('ownerFamilyClaimRejections')).toHaveLength(0);
    expect(f.rows('ownerEditorOperations')[0]).toMatchObject({ status: 'preparing', result: null });
  });

  it('terminally refuses a reviewed hash when the same source body and evidence changed', async () => {
    const f = fixture();
    const preparedValue = await prepared(f);
    const editedText = `${f.sourceText.slice(0, f.sourceText.indexOf(' Owner note:'))} Owner note: A harmless later note.`;
    const editedHash = hash(editedText);
    f.remove('memoryContentHashes', f.contentHash);
    f.seed('memories', ids.memory, { ...f.memory, content: editedText, contentHash: editedHash });
    f.seed('memoryContentHashes', editedHash, { memoryId: ids.memory });
    f.seed('knowledgeGraphSources', ids.memory, {
      ...f.rows('knowledgeGraphSources')[0],
      contentHash: editedHash,
    });
    f.seed('knowledgeGraphRelations', ids.relation, { ...f.relation, evidenceQuote: editedText });
    f.seed('knowledgeGraphAssertionEvidence', ids.evidence, {
      ...f.evidence,
      evidenceQuote: editedText,
      sourceContentHash: editedHash,
    });
    const reply = await apply(f, preparedValue);
    expect(reply).toMatchObject({ outcome: 'conflict', reason: 'reviewed_closure_changed' });
    expect(f.rows('ownerFamilyClaimRejections')).toHaveLength(0);
    expect(f.rows('knowledgeGraphRelations')[0]).toMatchObject({ reviewStatus: 'confirmed' });
    expect(f.rows('knowledgeGraphAssertions')[0]).toMatchObject({
      lifecycle: 'current',
      ownerAuthored: true,
    });
  });

  it('reads the source-keyed marker before relying on a retained source or contact', async () => {
    const f = fixture();
    const first = await prepared(f);
    await apply(f, first);
    f.remove('memories', ids.memory);
    f.remove('contacts', ids.subjectContact);
    const second = await preparedWithExpectedRevision(f, 'a'.repeat(64));
    const reply = await apply(f, second);
    expect(reply).toMatchObject({ outcome: 'conflict', reason: 'source_already_rejected' });
    expect(f.rows('ownerFamilyClaimRejections')).toHaveLength(1);
    expect(f.rows('ownerFamilyClaimRejections')[0]).toMatchObject({ sourceMemoryId: ids.memory });

    const marker = f.rows('ownerFamilyClaimRejections')[0];
    if (!marker) throw new Error('Expected the committed source rejection marker');
    f.seed('ownerFamilyClaimRejections', String(marker.id), {
      ...marker,
      stableContactMeaningKey: '0'.repeat(64),
    });
    const corruptMarkerAttempt = await preparedWithExpectedRevision(f, 'a'.repeat(64));
    expect(await apply(f, corruptMarkerAttempt)).toMatchObject({
      authority: 'unresolved',
      outcome: 'outcome_unknown',
      reason: 'receipt_unavailable',
    });
    expect(f.rows('ownerFamilyClaimRejections')).toHaveLength(1);
  });

  it('refuses unknown epoch, privacy, lease, and bounded membership states without domain writes', async () => {
    const staleEpoch = fixture();
    const staleEpochClaim = await prepared(staleEpoch);
    staleEpoch.seed('maintenanceCursors', `owner-editor-epoch:${ids.owner}`, {
      name: `owner-editor-epoch:${ids.owner}`,
      cursor: JSON.stringify({
        ownerId: ids.owner,
        epoch: randomUUID(),
        ready: true,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    });
    expect(await apply(staleEpoch, staleEpochClaim)).toMatchObject({ outcome: 'conflict' });
    expect(staleEpoch.rows('ownerFamilyClaimRejections')).toHaveLength(0);

    const privacy = fixture();
    const privacyClaim = await prepared(privacy);
    privacy.seed('privacyErasureJobs', ids.owner, {
      agentId: ids.owner,
      status: 'active',
      generation: randomUUID(),
    });
    expect(await apply(privacy, privacyClaim)).toMatchObject({ outcome: 'conflict' });
    expect(privacy.rows('ownerFamilyClaimRejections')).toHaveLength(0);

    const overflow = fixture();
    const operationId = randomUUID();
    const scope: OwnerEditorScope = {
      ownerId: ids.owner,
      sessionDigest: 'a'.repeat(64),
      epoch: overflow.epoch,
      privacyGeneration: null,
      command: 'remove_owner_family_relationship',
      operationId,
      targetId: ids.relation,
      nonce: randomUUID(),
      issuedAt: overflow.now.getTime() - 1_000,
      expiresAt: overflow.now.getTime() + 600_000,
    };
    const request: Extract<OwnerEditorApply, { command: 'remove_owner_family_relationship' }> = {
      version: 1,
      intent: 'apply',
      command: 'remove_owner_family_relationship',
      operationId,
      targetRelationId: ids.relation,
      expectedTargetRevision: 'a'.repeat(64),
    };
    const claim: OwnerEditorClaim = {
      scope,
      requestHash: applyHash(request),
      claimToken: randomUUID(),
      claimExpiresAt: new Date(overflow.now.getTime() + 60_000),
      statusVersion: 1,
    };
    overflow.seed(
      'ownerEditorOperations',
      ownerEditorOperationId(scope),
      parseInactiveOwnerFamilyRemovalOperationRecord({
        id: ownerEditorOperationId(scope),
        ownerId: ids.owner,
        epoch: scope.epoch,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        operationId,
        requestHash: claim.requestHash,
        scopeDigest: ownerEditorScopeDigest(scope),
        command: 'remove_owner_family_relationship',
        protocolVersion: 1,
        formIssuedAt: new Date(scope.issuedAt),
        formExpiresAt: new Date(scope.expiresAt),
        claimToken: claim.claimToken,
        claimExpiresAt: claim.claimExpiresAt,
        status: 'preparing',
        statusVersion: 1,
        result: null,
        createdAt: overflow.now,
        updatedAt: overflow.now,
      }),
    );
    for (let index = 0; index < 26; index++) {
      const id = randomUUID();
      overflow.seed('knowledgeGraphAssertionEvidence', id, {
        ...overflow.evidence,
        id,
        sourceMemoryId: ids.memory,
      });
    }
    const reply = await rejectOwnerFamilyClaimInFirestore({
      store: overflow.store,
      configuredOwnerId: ids.owner,
      claim,
      request,
      now: overflow.now,
    });
    expect(reply).toMatchObject({
      authority: 'unresolved',
      outcome: 'outcome_unknown',
      reason: 'receipt_unavailable',
    });
    expect(overflow.rows('ownerFamilyClaimRejections')).toHaveLength(0);
  });
});

async function preparedWithExpectedRevision(
  f: ReturnType<typeof fixture>,
  expectedTargetRevision: string,
) {
  const operationId = randomUUID();
  const scope: OwnerEditorScope = {
    ownerId: ids.owner,
    sessionDigest: 'a'.repeat(64),
    epoch: f.epoch,
    privacyGeneration: null,
    command: 'remove_owner_family_relationship',
    operationId,
    targetId: ids.relation,
    nonce: randomUUID(),
    issuedAt: f.now.getTime() - 1_000,
    expiresAt: f.now.getTime() + 600_000,
  };
  const request: Extract<OwnerEditorApply, { command: 'remove_owner_family_relationship' }> = {
    version: 1,
    intent: 'apply',
    command: 'remove_owner_family_relationship',
    operationId,
    targetRelationId: ids.relation,
    expectedTargetRevision,
  };
  const claim: OwnerEditorClaim = {
    scope,
    requestHash: applyHash(request),
    claimToken: randomUUID(),
    claimExpiresAt: new Date(f.now.getTime() + 60_000),
    statusVersion: 1,
  };
  f.seed(
    'ownerEditorOperations',
    ownerEditorOperationId(scope),
    parseInactiveOwnerFamilyRemovalOperationRecord({
      id: ownerEditorOperationId(scope),
      ownerId: ids.owner,
      epoch: scope.epoch,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      operationId,
      requestHash: claim.requestHash,
      scopeDigest: ownerEditorScopeDigest(scope),
      command: 'remove_owner_family_relationship',
      protocolVersion: 1,
      formIssuedAt: new Date(scope.issuedAt),
      formExpiresAt: new Date(scope.expiresAt),
      claimToken: claim.claimToken,
      claimExpiresAt: claim.claimExpiresAt,
      status: 'preparing',
      statusVersion: 1,
      result: null,
      createdAt: f.now,
      updatedAt: f.now,
    }),
  );
  return { claim, request };
}
