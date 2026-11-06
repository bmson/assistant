/** Actual Firestore transaction proof; requires the explicitly allocated local removal emulator. */
import { createHash, randomUUID } from 'node:crypto';
import { applyOwnerEditorCommand } from '@assistant/application/owner-editor';
import { createOwnerEditorDomain } from '@assistant/application/owner-editor-domain';
import {
  ownerEditorCanonicalApply,
  ownerEditorPath,
  parseOwnerEditorRequest,
} from '@assistant/application/owner-editor-wire';
import {
  createFirestoreOwnerEditorDomainStorage,
  createFirestoreOwnerEditorOperationRepository,
  firestoreOwnerEditorViewSnapshot,
  InstallationStore,
  readOwnerFamilyRejectionReview,
} from '@assistant/firestore';
import {
  canonicalizeKnowledgeAssertionDirection,
  embeddingSpaceIdentityKey,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
  type OwnerEditorApply,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { presentOwnerFamilyFact } from '@assistant/persistence/owner-family-presentation';
import { type DocumentReference, Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it } from 'vitest';
import { bindSelectedFamilyRemoval } from './owner-editor-removal-view.js';
import { issueOwnerEditorFormGrant, verifyOwnerEditorHandle } from './owner-editor-scope.js';
import { buildOwnerEditorView } from './owner-editor-view.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const enabled = !!host && /^(127\.0\.0\.1|localhost):\d+$/.test(host);
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Local Firestore emulator required');

const space = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Fixture = {
  store: InstallationStore;
  ownerId: string;
  personId: string;
  epoch: string;
  session: { ownerId: string; formSessionScope: string };
  secret: string;
  cleanup: DocumentReference[];
  domain: ReturnType<typeof createOwnerEditorDomain>;
  operations: ReturnType<typeof createFirestoreOwnerEditorOperationRepository>;
  put(table: string, id: string, row: Record<string, unknown>): Promise<void>;
};

async function fixture(): Promise<Fixture> {
  if (!host || !enabled) throw new Error('Local owner-removal emulator required');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const databaseId = `owner-removal-${nonce}-test`;
  const db = new Firestore({
    projectId: 'demo-assistant-test',
    databaseId,
    host,
    ssl: false,
    universeDomain: 'googleapis.com',
    preferRest: true,
    authClient: new OAuth2Client({
      universeDomain: 'googleapis.com',
      credentials: { access_token: 'owner', expiry_date: Number.MAX_SAFE_INTEGER },
    }),
  } as ConstructorParameters<typeof Firestore>[0]);
  const store = new InstallationStore(
    db,
    `owner-editor-removal-test-${nonce}`,
    undefined,
    'demo-assistant-test',
    databaseId,
  );
  const ownerId = randomUUID();
  const personId = randomUUID();
  const epoch = randomUUID();
  const cleanup: DocumentReference[] = [];
  const put = async (table: string, id: string, row: Record<string, unknown>) => {
    const ref = store.doc(table, id);
    cleanup.push(ref);
    await ref.set(row);
  };
  await put('agents', ownerId, { id: ownerId, timezone: 'UTC', locale: 'en' });
  await put('maintenanceCursors', `owner-editor-epoch:${ownerId}`, {
    name: `owner-editor-epoch:${ownerId}`,
    cursor: JSON.stringify({
      ownerId,
      epoch,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      ready: true,
    }),
  });
  await put('contacts', personId, {
    id: personId,
    agentId: ownerId,
    name: 'Fixture person',
    aliases: [],
    relationship: '',
    trust: 'known',
    emails: [],
    phones: [],
    notes: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const router = {
    embeddingSpace: async () => space,
    embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  };
  const domain = createOwnerEditorDomain({
    storage: createFirestoreOwnerEditorDomainStorage(store, ownerId, space),
    router,
  });
  const operations = createFirestoreOwnerEditorOperationRepository(store, ownerId);
  const session = { ownerId, formSessionScope: `removal-${nonce}-session-scope` };
  const secret = `test-only-${nonce}-owner-editor-secret`;
  return { store, ownerId, personId, epoch, session, secret, cleanup, domain, operations, put };
}

async function requestFromDisplayedImpact(f: Fixture) {
  const displayed = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
    contactId: f.personId,
  });
  if (!displayed.identity || !displayed.personRemoval)
    throw new Error('Bounded person-removal impact was not available');
  const grant = issueOwnerEditorFormGrant({
    context: { ownerId: f.ownerId, epoch: f.epoch, privacyGeneration: null },
    session: f.session,
    command: 'remove_person',
    targetId: f.personId,
    secret: f.secret,
  });
  const verified = verifyOwnerEditorHandle({
    token: grant.issuedOperationHandle,
    session: f.session,
    secret: f.secret,
  });
  if (verified.kind !== 'verified') throw new Error('Signed removal grant did not verify');
  const request: OwnerEditorApply = {
    version: 1,
    intent: 'apply',
    command: 'remove_person',
    operationId: grant.operationId,
    contactId: f.personId,
    expectedContactRevision: displayed.identity.revision,
    expectedImpactRevision: displayed.personRemoval.revision,
  };
  f.cleanup.push(f.store.doc('ownerEditorOperations', ownerEditorOperationId(verified.scope)));
  f.cleanup.push(f.store.doc('ownerCards', f.ownerId));
  return { displayed, request, scope: verified.scope };
}

describe.skipIf(!enabled)('person removal on actual Firestore emulator', () => {
  let active: Fixture | undefined;

  afterEach(async () => {
    if (!active) return;
    try {
      if (active.cleanup.length > 48)
        throw new Error('Person removal emulator cleanup bound exceeded');
      const batch = active.store.db.batch();
      for (const ref of active.cleanup) batch.delete(ref);
      await batch.commit();
    } finally {
      await active.store.db.terminate();
      active = undefined;
    }
  });

  it('deletes only the person-attributed fact, detaches retained source links, and replays the same receipt', async () => {
    const f = await fixture();
    active = f;
    const now = new Date();
    const factId = randomUUID();
    const factContent = 'Fixture person prefers a weekly written update.';
    const factHash = hash(factContent);
    const retainedMemoryId = randomUUID();
    const retainedContent = 'Original source note that remains saved.';
    const retainedHash = hash(retainedContent);
    const spaceKey = embeddingSpaceIdentityKey(space);
    const memory = (
      id: string,
      content: string,
      contentHash: string,
      subjectContactId: string | null,
    ) => ({
      id,
      agentId: f.ownerId,
      createdAt: now,
      content,
      contentHash,
      category: 'knowledge',
      source: 'manual',
      sourceTaskId: null,
      subjectContactId,
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
    await f.put('memories', factId, memory(factId, factContent, factHash, f.personId));
    await f.put('memoryContentHashes', factHash, { memoryId: factId });
    f.cleanup.push(f.store.doc('memoryTombstones', factHash));
    f.cleanup.push(f.store.doc('graphDeletionIntents', factId));
    await f.put(
      'memories',
      retainedMemoryId,
      memory(retainedMemoryId, retainedContent, retainedHash, null),
    );
    const entityId = randomUUID();
    await f.put('knowledgeGraphEntities', entityId, {
      id: entityId,
      agentId: f.ownerId,
      kind: 'person',
      canonicalKey: `contact:${f.personId}`,
      label: 'Fixture person',
      preferredLabel: null,
      contactId: f.personId,
      createdAt: now,
      updatedAt: now,
    });
    await f.put('knowledgeGraphSources', retainedMemoryId, {
      memoryId: retainedMemoryId,
      agentId: f.ownerId,
      status: 'ready',
      lastError: null,
      contentHash: retainedHash,
      subjectContactId: f.personId,
      extractionVersion: 1,
      nextRetryAt: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    const relationId = randomUUID();
    await f.put('knowledgeGraphRelations', relationId, {
      id: relationId,
      agentId: f.ownerId,
      subjectEntityId: entityId,
      objectEntityId: randomUUID(),
      sourceMemoryId: retainedMemoryId,
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

    const { request, scope } = await requestFromDisplayedImpact(f);
    const parsed = parseOwnerEditorRequest(request, ownerEditorPath(request.command));
    if (!parsed.ok || parsed.request.intent !== 'apply')
      throw new Error('Removal request did not parse');
    const reply = await applyOwnerEditorCommand({
      request: parsed.request,
      scope,
      operations: f.operations,
      domain: f.domain,
    });
    expect(reply).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      ids: { contactId: f.personId },
    });
    const replay = await applyOwnerEditorCommand({
      request: parsed.request,
      scope,
      operations: f.operations,
      domain: f.domain,
    });
    expect(replay).toEqual(reply);
    const [
      person,
      deletedFact,
      retainedMemory,
      tombstone,
      hashIndex,
      intent,
      source,
      entity,
      relation,
    ] = await Promise.all([
      f.store.doc('contacts', f.personId).get(),
      f.store.doc('memories', factId).get(),
      f.store.doc('memories', retainedMemoryId).get(),
      f.store.doc('memoryTombstones', factHash).get(),
      f.store.doc('memoryContentHashes', factHash).get(),
      f.store.doc('graphDeletionIntents', factId).get(),
      f.store.doc('knowledgeGraphSources', retainedMemoryId).get(),
      f.store.doc('knowledgeGraphEntities', entityId).get(),
      f.store.doc('knowledgeGraphRelations', relationId).get(),
    ]);
    expect(person.exists).toBe(false);
    expect(deletedFact.exists).toBe(false);
    expect(retainedMemory.exists).toBe(true);
    expect(tombstone.get('contentHash')).toBe(factHash);
    expect(hashIndex.exists).toBe(false);
    expect(intent.get('contentHash')).toBe(factHash);
    expect(source.get('subjectContactId')).toBeNull();
    expect(entity.get('contactId')).toBeNull();
    expect(relation.exists).toBe(true);
    const readback = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: f.personId,
    });
    expect(readback.identity).toBeNull();
    expect(readback.people.some((personOption) => personOption.contactId === f.personId)).toBe(
      false,
    );
  });

  it('commits a terminal conflict when exact impact membership changes after preparation', async () => {
    const f = await fixture();
    active = f;
    const { request, scope } = await requestFromDisplayedImpact(f);
    const reservation = await f.operations.reserve(
      scope,
      createHash('sha256').update(ownerEditorCanonicalApply(request)).digest('hex'),
      new Date(),
    );
    if (reservation.kind !== 'claimed') throw new Error('Expected removal claim');
    const prepared = await f.domain.prepare(request, scope);
    if (!prepared.ok) throw new Error('Expected removal preparation from displayed impact');
    const occasionId = randomUUID();
    await f.put('occasions', occasionId, {
      id: occasionId,
      agentId: f.ownerId,
      contactId: f.personId,
      kind: 'birthday',
      month: 6,
      day: 2,
      year: null,
    });

    const reply = await f.domain.commit(reservation.claim, prepared.prepared, new Date());
    expect(reply).toMatchObject({ authority: 'operation_receipt', outcome: 'conflict' });
    expect((await f.store.doc('contacts', f.personId).get()).exists).toBe(true);
    expect((await f.store.doc('occasions', occasionId).get()).exists).toBe(true);
    expect(
      (
        await f.store
          .doc(
            'ownerEditorOperations',
            (await import('@assistant/persistence')).ownerEditorOperationId(scope),
          )
          .get()
      ).get('status'),
    ).toBe('terminal_rejected');
  });

  it('removes a family source through selected-only bound review, normal claim, first cursor creation, replay, and readback', async () => {
    const f = await fixture();
    active = f;
    const now = new Date();
    const otherId = randomUUID();
    await f.put('contacts', otherId, {
      id: otherId,
      agentId: f.ownerId,
      name: 'Fixture sibling',
      aliases: [],
      relationship: '',
      trust: 'known',
      emails: [],
      phones: [],
      notes: '',
      createdAt: now,
      updatedAt: now,
    });
    const subjectEntityId = randomUUID();
    const objectEntityId = randomUUID();
    const relationId = randomUUID();
    const memoryId = randomUUID();
    const content = `${presentOwnerFamilyFact({
      subjectLabel: 'Fixture person',
      predicate: 'sibling_of',
      objectLabel: 'Fixture sibling',
      timing: 'present',
      validity: { validFrom: null, validUntil: null },
    })} Owner note: I recorded this after we discussed it.`;
    const contentHash = hash(content);
    const retrievalRevision = randomUUID();
    const meaning = canonicalizeKnowledgeAssertionDirection({
      subjectEntityId,
      objectEntityId,
      predicate: 'sibling_of',
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      validFrom: null,
      validUntil: null,
      qualifiers: {},
    });
    const semanticKey = knowledgeAssertionSemanticKey(f.ownerId, meaning);
    const assertionId = knowledgeAssertionId(f.ownerId, semanticKey);
    const sourceFingerprint = 'emulator-family-source-one';
    const spaceKey = embeddingSpaceIdentityKey(space);
    await f.put('memories', memoryId, {
      id: memoryId,
      agentId: f.ownerId,
      createdAt: now,
      content,
      contentHash,
      category: 'knowledge',
      source: 'knowledge-graph-owner',
      sourceTaskId: null,
      subjectContactId: f.personId,
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      kind: 'fact',
      domain: 'other',
      originTrust: 'owner',
      ownerConfirmed: true,
      confidence: '1.00',
      importance: 3,
      pinned: false,
      validFrom: null,
      validUntil: null,
      goalId: null,
      embedding: [1, 0, 0],
      embeddingSpaceKey: spaceKey,
      lastAccessedAt: null,
      lastConsolidatedAt: null,
      retrievalRevision,
    });
    await f.put('memoryContentHashes', contentHash, { memoryId });
    await f.put('knowledgeGraphSources', memoryId, {
      memoryId,
      agentId: f.ownerId,
      status: 'ready',
      lastError: null,
      contentHash,
      retrievalRevision,
      subjectContactId: f.personId,
      extractionVersion: 1,
      nextRetryAt: null,
      attempts: 0,
      claimToken: null,
      createdAt: now,
      updatedAt: now,
    });
    await f.put('knowledgeGraphEntities', subjectEntityId, {
      id: subjectEntityId,
      agentId: f.ownerId,
      kind: 'person',
      canonicalKey: `contact:${f.personId}`,
      label: 'Fixture person',
      preferredLabel: null,
      contactId: f.personId,
      createdAt: now,
      updatedAt: now,
    });
    await f.put('knowledgeGraphEntities', objectEntityId, {
      id: objectEntityId,
      agentId: f.ownerId,
      kind: 'person',
      canonicalKey: `contact:${otherId}`,
      label: 'Fixture sibling',
      preferredLabel: null,
      contactId: otherId,
      createdAt: now,
      updatedAt: now,
    });
    await f.put('knowledgeGraphAssertions', assertionId, {
      id: assertionId,
      agentId: f.ownerId,
      semanticKey,
      subjectEntityId: meaning.subjectEntityId,
      predicate: meaning.predicate,
      objectEntityId: meaning.objectEntityId,
      assertion: meaning.assertion,
      qualifiers: meaning.qualifiers ?? {},
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
    });
    const evidenceId = randomUUID();
    await f.put('knowledgeGraphAssertionEvidence', evidenceId, {
      id: evidenceId,
      agentId: f.ownerId,
      assertionId,
      sourceMemoryId: memoryId,
      sourceFingerprint,
      sourceContentHash: contentHash,
      evidenceQuote: content,
      sourceAuthor: 'owner',
      sourceTrust: 'owner',
      independent: false,
      spanStart: 0,
      spanEnd: content.length,
      extractionVersion: 1,
      evidenceRevision: 1,
      observedAt: now,
      createdAt: now,
    });
    await f.put('knowledgeGraphRelations', relationId, {
      id: relationId,
      agentId: f.ownerId,
      subjectEntityId,
      objectEntityId,
      sourceMemoryId: memoryId,
      assertionId,
      predicate: 'sibling_of',
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      reviewStatus: 'confirmed',
      sourceFingerprint,
      confidence: '1.00',
      validFrom: null,
      validUntil: null,
      evidenceQuote: content,
      ordinal: 1,
      createdAt: now,
      reviewedAt: now,
      correctedByRelationId: null,
      correctionSourceContentHash: null,
      correctionDisposition: null,
    });

    const cacheRef = f.store.doc('maintenanceCursors', `owner-source-rejection:${f.ownerId}`);
    expect((await cacheRef.get()).exists).toBe(false);
    const snapshot = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: f.personId,
      relationIds: [relationId],
    });
    expect(snapshot.corrections).toHaveLength(1);
    const identity = snapshot.identity;
    if (!identity) throw new Error('Family removal identity not visible');
    const editor = buildOwnerEditorView({
      enabled: true,
      context: { ownerId: f.ownerId, epoch: f.epoch, privacyGeneration: null },
      snapshot,
      formSessionScope: f.session.formSessionScope,
      secret: f.secret,
      displayedContact: {
        id: identity.contactId,
        name: identity.name,
        aliases: identity.aliases,
        trust: identity.trust,
        identityRevision: identity.revision,
      },
      removalEnabled: true,
    });
    let reviewCalls = 0;
    const selected = await bindSelectedFamilyRemoval({
      editor,
      selectedRelationId: relationId,
      secret: f.secret,
      review: (scope, eligibility) => {
        reviewCalls += 1;
        return readOwnerFamilyRejectionReview({
          store: f.store,
          ownerId: f.ownerId,
          relationId: eligibility.relationId,
          scope,
          expectedFamilyScopeRevision: eligibility.revision,
          familyFields: eligibility.original,
        });
      },
    });
    expect(reviewCalls).toBe(1);
    if (!selected) throw new Error('Family editor view was unavailable');
    const bound = selected?.removals?.[0];
    if (!bound) throw new Error('Selected family removal did not receive an exact closure review');
    const verified = verifyOwnerEditorHandle({
      token: bound.grant.issuedOperationHandle,
      session: selected.session,
      secret: f.secret,
    });
    if (verified.kind !== 'verified')
      throw new Error('Selected family removal grant did not verify');
    const request: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'remove_owner_family_relationship',
      operationId: bound.grant.operationId,
      targetRelationId: relationId,
      expectedTargetRevision: bound.eligibility.revision,
    };
    f.cleanup.push(f.store.doc('ownerEditorOperations', ownerEditorOperationId(verified.scope)));
    f.cleanup.push(cacheRef);
    const reply = await applyOwnerEditorCommand({
      request,
      scope: verified.scope,
      operations: f.operations,
      domain: f.domain,
    });
    expect(reply).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      ids: { relationId, memoryId, assertionId },
    });
    expect(
      await applyOwnerEditorCommand({
        request,
        scope: verified.scope,
        operations: f.operations,
        domain: f.domain,
      }),
    ).toEqual(reply);
    const [markerPage, source, relation, assertion, checkpoint, card, cache] = await Promise.all([
      f.store
        .collection('ownerFamilyClaimRejections')
        .where('ownerId', '==', f.ownerId)
        .limit(2)
        .get(),
      f.store.doc('memories', memoryId).get(),
      f.store.doc('knowledgeGraphRelations', relationId).get(),
      f.store.doc('knowledgeGraphAssertions', assertionId).get(),
      f.store.doc('knowledgeGraphSources', memoryId).get(),
      f.store.doc('ownerCards', f.ownerId).get(),
      cacheRef.get(),
    ]);
    expect(markerPage.docs).toHaveLength(1);
    const marker = markerPage.docs[0];
    if (!marker) throw new Error('Family removal marker was not created');
    f.cleanup.push(marker.ref, f.store.doc('ownerCards', f.ownerId));
    expect(source.get('ownerFamilyRejectedContentHash')).toBe(contentHash);
    expect(source.get('retrievalRevision')).not.toBe(retrievalRevision);
    expect(relation.get('reviewStatus')).toBe('rejected');
    expect(assertion.get('lifecycle')).toBe('retracted');
    expect(checkpoint.get('contentHash')).toBe(contentHash);
    expect(card.get('invalidatedAt')).toBeTruthy();
    expect(cache.exists).toBe(true);
    expect(cache.get('name')).toBe(`owner-source-rejection:${f.ownerId}`);
  });
});
