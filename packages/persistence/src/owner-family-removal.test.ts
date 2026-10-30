import { describe, expect, it } from 'vitest';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionSemanticKey,
} from './knowledge-assertions.js';
import { statedPeriodEnd, statedPeriodStart } from './knowledge-validity.js';
import { presentOwnerFamilyFact } from './owner-family-presentation.js';
import {
  OWNER_FAMILY_REMOVAL_WRITER_REQUIREMENTS,
  ownerFamilyRemovalRequestSchema,
  planOwnerFamilyRemoval,
} from './owner-family-removal.js';
import type { OwnerFamilyScopeRows } from './owner-family-scope.js';
import type { Records } from './records.js';

const ids = {
  owner: '11111111-1111-4111-8111-111111111111',
  relation: '22222222-2222-4222-8222-222222222222',
  source: '33333333-3333-4333-8333-333333333333',
  assertion: '44444444-4444-4444-8444-444444444444',
  evidence: '55555555-5555-4555-8555-555555555555',
  subjectEntity: '66666666-6666-4666-8666-666666666666',
  objectEntity: '77777777-7777-4777-8777-777777777777',
  subjectContact: '88888888-8888-4888-8888-888888888888',
  objectContact: '99999999-9999-4999-8999-999999999999',
};
const revision = 'a'.repeat(64);
const sourceHash = 'b'.repeat(64);
const nativeScopeHash = 'c'.repeat(64);
const now = new Date('2026-10-29T12:00:00Z');

function fixture() {
  const baseRelation = {
    id: ids.relation,
    agentId: ids.owner,
    sourceFingerprint: 'family-source-one',
    confidence: '1.00',
    subjectEntityId: ids.subjectEntity,
    predicate: 'parent_of',
    assertion: { tense: 'unspecified', polarity: 'positive', modality: 'asserted' },
    assertionId: ids.assertion,
    objectEntityId: ids.objectEntity,
    sourceMemoryId: ids.source,
    evidenceQuote: 'Alex is Sam’s parent.',
    ordinal: 0,
    reviewStatus: 'confirmed',
    reviewedAt: now,
    correctedByRelationId: null,
    correctionSourceContentHash: null,
    correctionDisposition: null,
    validFrom: '2020-01-01',
    validUntil: '2024-12-31',
    createdAt: now,
  };
  const semantic = canonicalizeKnowledgeAssertionDirection(baseRelation as never);
  const semanticKey = knowledgeAssertionSemanticKey(ids.owner, semantic);
  const sourceText = `${presentOwnerFamilyFact({
    subjectLabel: 'Alex',
    predicate: 'parent_of',
    objectLabel: 'Sam',
    timing: 'unspecified',
    validity: { validFrom: '2020-01-01', validUntil: '2024-12-31' },
  })} Owner note: I recorded this wording after we discussed it.`;
  baseRelation.evidenceQuote = sourceText;
  const relation = baseRelation as unknown as Records['knowledgeGraphRelations'];
  const source = {
    id: ids.source,
    agentId: ids.owner,
    source: 'knowledge-graph-owner',
    originTrust: 'owner',
    ownerConfirmed: true,
    quarantined: false,
    expiresAt: null,
    supersededById: null,
    content: sourceText,
    contentHash: sourceHash,
    validFrom: statedPeriodStart('2020-01-01'),
    validUntil: statedPeriodEnd('2024-12-31'),
    createdAt: now,
  } as unknown as Records['memories'];
  const assertion = {
    id: ids.assertion,
    agentId: ids.owner,
    semanticKey,
    subjectEntityId: ids.subjectEntity,
    predicate: 'parent_of',
    objectEntityId: ids.objectEntity,
    assertion: baseRelation.assertion,
    qualifiers: {},
    validFrom: '2020-01-01',
    validUntil: '2024-12-31',
    semanticRevision: 2,
    evidenceRevision: 3,
    lifecycle: 'current',
    reviewStatus: 'confirmed',
    reviewedRevision: 2,
    reviewedPayloadHash: semanticKey,
    ownerAuthored: true,
    supersededById: null,
    createdAt: now,
    updatedAt: now,
  } as unknown as Records['knowledgeGraphAssertions'];
  const evidence = {
    id: ids.evidence,
    agentId: ids.owner,
    assertionId: ids.assertion,
    sourceMemoryId: ids.source,
    sourceFingerprint: 'family-source-one',
    sourceContentHash: sourceHash,
    evidenceQuote: sourceText,
    sourceAuthor: 'owner',
    sourceTrust: 'owner',
    independent: true,
    spanStart: null,
    spanEnd: null,
    extractionVersion: 1,
    evidenceRevision: 3,
    observedAt: now,
    createdAt: now,
  } as unknown as Records['knowledgeGraphAssertionEvidence'];
  const scope = {
    ownerId: ids.owner,
    relation,
    source,
    assertion,
    evidence: [evidence],
    sourceRelations: [relation],
    canonicalRelations: [relation],
    sourcePrecisionLossless: true,
    native: { relation: 'native-row-version-7', evidence: 'native-row-version-4' },
    revision: nativeScopeHash,
  } as OwnerFamilyScopeRows & { revision: string };
  const entities = [
    {
      id: ids.subjectEntity,
      agentId: ids.owner,
      kind: 'person',
      canonicalKey: `contact:${ids.subjectContact}`,
      label: 'Alex',
      preferredLabel: null,
      contactId: ids.subjectContact,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ids.objectEntity,
      agentId: ids.owner,
      kind: 'person',
      canonicalKey: `contact:${ids.objectContact}`,
      label: 'Sam',
      preferredLabel: null,
      contactId: ids.objectContact,
      createdAt: now,
      updatedAt: now,
    },
  ] as Records['knowledgeGraphEntities'][];
  const contacts = [
    {
      id: ids.subjectContact,
      name: 'Alex',
      trust: 'known',
      aliases: [],
      revision,
    },
    {
      id: ids.objectContact,
      name: 'Sam',
      trust: 'known',
      aliases: [],
      revision,
    },
  ] as unknown as (Records['contacts'] & { revision: string })[];
  const request = {
    ownerId: ids.owner,
    relationId: ids.relation,
    expectedNativeScopeHash: nativeScopeHash,
  };
  const plan = (overrides: Partial<Parameters<typeof planOwnerFamilyRemoval>[0]> = {}) =>
    planOwnerFamilyRemoval({ request, scope, entities, contacts, ...overrides });
  return { scope, entities, contacts, request, plan, sourceText, evidence };
}

describe('owner family removal planning', () => {
  it('plans rejection of only the exact standalone claim and retains both endpoints and source note', () => {
    const f = fixture();
    const plan = f.plan();
    expect(plan).toMatchObject({
      action: 'reject_recorded_claim',
      ownerId: ids.owner,
      expectedNativeScopeHash: nativeScopeHash,
      target: {
        relation: { id: ids.relation, assertionId: ids.assertion, sourceMemoryId: ids.source },
        assertion: { id: ids.assertion, semanticRevision: 2, evidenceRevision: 3 },
        evidence: {
          id: ids.evidence,
          assertionId: ids.assertion,
          sourceMemoryId: ids.source,
          sourceContentHash: sourceHash,
          evidenceRevision: 3,
        },
      },
      retained: {
        subjectContactId: ids.subjectContact,
        objectContactId: ids.objectContact,
        sourceMemoryId: ids.source,
        sourceContentHash: sourceHash,
        sourceText: f.sourceText,
        sourceDisposition: 'retain_saved_source_note',
      },
      writerRequirements: OWNER_FAMILY_REMOVAL_WRITER_REQUIREMENTS,
    });
    expect(plan?.retained.sourceText).toContain("identifies Alex as Sam's parent.");
    expect(plan?.writerRequirements).toContain(
      'Persist a durable exact-evidence fence so the rejected claim cannot be re-extracted from the same evidence.',
    );
  });

  it('binds owner, relation, and expected native scope hash exactly and parses request strictly', () => {
    const f = fixture();
    expect(f.plan({ request: { ...f.request, ownerId: ids.objectContact } })).toBeNull();
    expect(f.plan({ request: { ...f.request, relationId: ids.evidence } })).toBeNull();
    expect(
      f.plan({
        request: { ...f.request, expectedNativeScopeHash: 'd'.repeat(64) },
      }),
    ).toBeNull();
    expect(f.plan({ scope: { ...f.scope, revision: 'd'.repeat(64) } })).toBeNull();
    expect(ownerFamilyRemovalRequestSchema.safeParse({ ...f.request, extra: true }).success).toBe(
      false,
    );
    expect(f.plan({ request: { ...f.request, extra: true } })).toBeNull();
    expect(f.plan({ request: { ...f.request, ownerId: 'owner' } })).toBeNull();
    expect(
      planOwnerFamilyRemoval({
        request: f.request,
        scope: null as unknown as OwnerFamilyScopeRows & { revision: string },
        entities: f.entities,
        contacts: f.contacts,
      }),
    ).toBeNull();
  });

  it('fails closed on missing or shared source, evidence, or canonical relation scope', () => {
    const sourceScope = fixture();
    expect(
      sourceScope.plan({
        scope: { ...sourceScope.scope, sourceRelations: [] },
      }),
    ).toBeNull();
    const sharedEvidence = fixture();
    expect(
      sharedEvidence.plan({
        scope: {
          ...sharedEvidence.scope,
          evidence: [
            sharedEvidence.evidence,
            { ...sharedEvidence.evidence, id: ids.subjectEntity },
          ],
        },
      }),
    ).toBeNull();
    const canonicalSibling = fixture();
    expect(
      canonicalSibling.plan({
        scope: {
          ...canonicalSibling.scope,
          canonicalRelations: [
            ...canonicalSibling.scope.canonicalRelations,
            { ...canonicalSibling.scope.relation, id: ids.objectEntity },
          ],
        },
      }),
    ).toBeNull();
    const sharedSource = fixture();
    expect(
      sharedSource.plan({
        scope: {
          ...sharedSource.scope,
          sourceRelations: [
            ...sharedSource.scope.sourceRelations,
            { ...sharedSource.scope.relation, id: ids.subjectEntity },
          ],
        },
      }),
    ).toBeNull();
  });

  it('rejects foreign, stale, or ineligible source and assertion records', () => {
    const foreignOwner = fixture();
    expect(
      foreignOwner.plan({
        scope: {
          ...foreignOwner.scope,
          source: { ...foreignOwner.scope.source, agentId: ids.objectContact },
        },
      }),
    ).toBeNull();
    const changedQuote = fixture();
    expect(
      changedQuote.plan({
        scope: {
          ...changedQuote.scope,
          evidence: [{ ...changedQuote.evidence, evidenceQuote: 'different source' }],
        },
      }),
    ).toBeNull();
    const lossyDates = fixture();
    expect(
      lossyDates.plan({
        scope: { ...lossyDates.scope, sourcePrecisionLossless: false },
      }),
    ).toBeNull();
    const unsupportedTiming = fixture();
    const relationAssertion = unsupportedTiming.scope.relation.assertion;
    if (!relationAssertion) throw new Error('Invalid fixture relation');
    expect(
      unsupportedTiming.plan({
        scope: {
          ...unsupportedTiming.scope,
          relation: {
            ...unsupportedTiming.scope.relation,
            assertion: {
              ...relationAssertion,
              tense: 'future',
            },
          },
        },
      }),
    ).toBeNull();
    const changedSourceDate = fixture();
    expect(
      changedSourceDate.plan({
        scope: {
          ...changedSourceDate.scope,
          source: {
            ...changedSourceDate.scope.source,
            validFrom: new Date('2020-01-02T00:00:00Z'),
          },
        },
      }),
    ).toBeNull();
    const historical = fixture();
    expect(
      historical.plan({
        scope: {
          ...historical.scope,
          source: { ...historical.scope.source, supersededById: ids.objectEntity },
        },
      }),
    ).toBeNull();
    const reviewedElsewhere = fixture();
    expect(
      reviewedElsewhere.plan({
        scope: {
          ...reviewedElsewhere.scope,
          assertion: { ...reviewedElsewhere.scope.assertion, reviewedPayloadHash: 'e'.repeat(64) },
        },
      }),
    ).toBeNull();
  });

  it('requires exactly one well-bound non-owner contact for each non-owner endpoint', () => {
    const missingEndpoint = fixture();
    const [missingSubject, missingObject] = missingEndpoint.contacts;
    if (!missingSubject || !missingObject) throw new Error('Invalid fixture contacts');
    expect(missingEndpoint.plan({ contacts: [missingSubject] })).toBeNull();
    const ownerEndpoint = fixture();
    const [ownerSubject, ownerObject] = ownerEndpoint.contacts;
    if (!ownerSubject || !ownerObject) throw new Error('Invalid fixture contacts');
    expect(
      ownerEndpoint.plan({
        contacts: [ownerSubject, { ...ownerObject, trust: 'owner' }],
      }),
    ).toBeNull();
    const duplicateEntity = fixture();
    const duplicateEntitySource = duplicateEntity.entities[0];
    if (!duplicateEntitySource) throw new Error('Invalid fixture entities');
    expect(
      duplicateEntity.plan({
        entities: [
          ...duplicateEntity.entities,
          { ...duplicateEntitySource, label: 'ambiguous duplicate' },
        ],
      }),
    ).toBeNull();
    const duplicateContact = fixture();
    const duplicateContactSource = duplicateContact.contacts[0];
    if (!duplicateContactSource) throw new Error('Invalid fixture contacts');
    expect(
      duplicateContact.plan({
        contacts: [...duplicateContact.contacts, { ...duplicateContactSource }],
      }),
    ).toBeNull();
  });
});
