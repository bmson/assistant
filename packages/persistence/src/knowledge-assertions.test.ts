import { describe, expect, it } from 'vitest';
import {
  type CanonicalKnowledgeAssertion,
  canonicalizeKnowledgeAssertionDirection,
  deriveSharedParentViews,
  knowledgeAssertionEndpointView,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
} from './knowledge-assertions.js';

const assertion = (
  overrides: Partial<CanonicalKnowledgeAssertion> = {},
): CanonicalKnowledgeAssertion => ({
  id: 'a',
  agentId: 'owner',
  semanticKey: 'key',
  subjectEntityId: 'parent',
  predicate: 'parent_of',
  objectEntityId: 'child-one',
  assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
  qualifiers: {},
  validFrom: null,
  validUntil: null,
  semanticRevision: 1,
  evidenceRevision: 1,
  lifecycle: 'current',
  reviewStatus: 'confirmed',
  reviewedRevision: 1,
  reviewedPayloadHash: 'hash',
  ownerAuthored: false,
  supersededById: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

describe('canonical knowledge assertions', () => {
  it('uses full semantic qualifiers as identity while allowing evidence to vary', () => {
    const meaning = assertion();
    const key = knowledgeAssertionSemanticKey('owner', meaning);
    const withDifferentEvidence = { ...meaning, evidenceRevision: 9 };
    expect(knowledgeAssertionSemanticKey('owner', withDifferentEvidence)).toBe(key);
    expect(
      knowledgeAssertionSemanticKey('owner', {
        ...meaning,
        assertion: { ...meaning.assertion, tense: 'past' },
      }),
    ).not.toBe(key);
    expect(
      knowledgeAssertionSemanticKey('owner', { ...meaning, validFrom: '2020-01-01' }),
    ).not.toBe(key);
    expect(knowledgeAssertionId('owner', key)).toBe(knowledgeAssertionId('owner', key));
    expect(knowledgeAssertionId('another-owner', key)).not.toBe(knowledgeAssertionId('owner', key));
  });

  it('normalizes inverse and symmetric spellings without fabricating source evidence', () => {
    const childFacing = canonicalizeKnowledgeAssertionDirection({
      subjectEntityId: 'child',
      predicate: 'daughter_of',
      objectEntityId: 'parent',
      assertion: assertion().assertion,
      validFrom: null,
      validUntil: null,
    });
    expect(childFacing).toMatchObject({
      subjectEntityId: 'parent',
      predicate: 'parent_of',
      objectEntityId: 'child',
      qualifiers: { relationshipSubtype: 'daughter' },
    });
    const spouse = canonicalizeKnowledgeAssertionDirection({
      subjectEntityId: 'z',
      predicate: 'spouse_of',
      objectEntityId: 'a',
      assertion: assertion().assertion,
      validFrom: null,
      validUntil: null,
    });
    expect(spouse).toMatchObject({ subjectEntityId: 'a', objectEntityId: 'z' });
  });

  it('uses quoted wording when the inverse is not safe to assert', () => {
    expect(
      knowledgeAssertionEndpointView({
        assertionId: 'a',
        semanticRevision: 1,
        subjectEntityId: 'uncle',
        subjectLabel: 'Ari',
        predicate: 'uncle_of',
        objectEntityId: 'child',
        objectLabel: 'Bo',
        inversePredicate: 'nephew_of',
        evidenceQuote: 'Ari is Bo’s uncle.',
        evidenceCount: 1,
        reviewStatus: 'confirmed',
        focusEntityId: 'child',
      })?.text,
    ).toBe('Ari is Bo’s uncle.');
  });

  it('derives a shared-parent view with premise revisions and removes it when a premise is retracted', () => {
    const rows = [assertion(), assertion({ id: 'b', objectEntityId: 'child-two' })];
    const entities = new Map([
      ['child-one', 'Ari'],
      ['child-two', 'Bo'],
      ['parent', 'Casey'],
    ]);
    const [view] = deriveSharedParentViews(rows, entities);
    expect(view).toMatchObject({
      kind: 'derived',
      predicate: 'shares_recorded_parent_with',
      premiseAssertionIds: ['a', 'b'],
      premiseRevisions: [1, 1],
      ruleId: 'shared-parent',
    });
    expect(view?.explanation).toContain('not a directly stated sibling claim');
    expect(
      deriveSharedParentViews(
        [
          rows[0] as CanonicalKnowledgeAssertion,
          { ...(rows[1] as CanonicalKnowledgeAssertion), lifecycle: 'retracted' },
        ],
        entities,
      ),
    ).toEqual([]);
  });
});
