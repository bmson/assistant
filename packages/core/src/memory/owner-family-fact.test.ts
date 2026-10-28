import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionSemanticKey,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { prepareOwnerKnowledgeGraphFactWithRepository } from './knowledge-graph.js';
import {
  eligibleOwnerFamilyCorrection,
  type OwnerFamilyScopeRows,
  presentOwnerFamilyFact,
  validOwnerFamilyMeaning,
} from './owner-family-fact.js';
import { PREDICATE_VOCABULARY } from './predicate-vocabulary.js';
import { statedPeriodEnd, statedPeriodStart } from './validity.js';

const meaning = {
  timing: 'unspecified' as const,
  validity: { validFrom: '2024-02-29', validUntil: '2024-02-29' },
};
function scope(): OwnerFamilyScopeRows {
  const relation = {
    id: 'relation',
    agentId: 'owner',
    subjectEntityId: 'alex',
    objectEntityId: 'sam',
    predicate: 'parent_of',
    assertion: { tense: 'unspecified', polarity: 'positive', modality: 'asserted' },
    assertionId: 'assertion',
    sourceMemoryId: 'source',
    reviewStatus: 'confirmed',
    evidenceQuote: 'Owner source',
    correctedByRelationId: null,
    ...meaning.validity,
  };
  const semantic = canonicalizeKnowledgeAssertionDirection(relation as never);
  const assertion = {
    id: 'assertion',
    agentId: 'owner',
    semanticKey: knowledgeAssertionSemanticKey('owner', semantic),
    semanticRevision: 1,
    evidenceRevision: 1,
    lifecycle: 'current',
    reviewStatus: 'confirmed',
    ownerAuthored: true,
    reviewedRevision: 1,
  };
  return {
    ownerId: 'owner',
    relation,
    source: {
      id: 'source',
      agentId: 'owner',
      source: 'knowledge-graph-owner',
      originTrust: 'owner',
      ownerConfirmed: true,
      quarantined: false,
      expiresAt: null,
      supersededById: null,
      content: 'Owner source',
      contentHash: 'hash',
      validFrom: statedPeriodStart(meaning.validity.validFrom),
      validUntil: statedPeriodEnd(meaning.validity.validUntil),
    },
    assertion: { ...assertion, reviewedPayloadHash: assertion.semanticKey },
    evidence: [
      {
        id: 'proof',
        agentId: 'owner',
        assertionId: 'assertion',
        sourceMemoryId: 'source',
        sourceContentHash: 'hash',
        sourceAuthor: 'owner',
        sourceTrust: 'owner',
        evidenceQuote: 'Owner source',
      },
    ],
    sourceRelations: [relation],
    canonicalRelations: [relation],
    sourcePrecisionLossless: true,
    native: { exact: '2024-02-29 00:00:00.000001+00' },
  } as unknown as OwnerFamilyScopeRows;
}

describe('owner family exact civil meaning and standalone canonical scope', () => {
  it.each([
    '2023-02-29',
    '2024-02-30',
    '2024-13-01',
    '2024-00-01',
    '0999-01-01',
    '2024-02',
    '2024-02-29T00:00:00Z',
  ])('rejects %s before conversion or source preparation', (day) => {
    expect(
      validOwnerFamilyMeaning({ timing: 'past', validity: { validFrom: day, validUntil: null } }),
    ).toBe(false);
  });
  it('retains leap/equal-day/end-only/null/future civil dates without deriving timing', () => {
    for (const validity of [
      meaning.validity,
      { validFrom: null, validUntil: '2024-02-29' },
      { validFrom: null, validUntil: null },
      { validFrom: '2999-12-31', validUntil: null },
    ])
      expect(validOwnerFamilyMeaning({ timing: 'unspecified', validity })).toBe(true);
    const text = presentOwnerFamilyFact({
      subjectLabel: 'Alex',
      objectLabel: 'Sam',
      predicate: 'parent_of',
      ...meaning,
    });
    expect(text).toContain(
      "Recorded statement: The saved relationship identifies Alex as Sam's parent.",
    );
    expect(text).toContain('Timing recorded: not recorded.');
    expect(text).toContain('Recorded dates: From 2024-02-29 through 2024-02-29 (inclusive).');
    expect(
      presentOwnerFamilyFact({
        subjectLabel: 'Alex',
        objectLabel: 'Sam',
        predicate: 'parent_of',
        timing: 'present',
        validity: { validFrom: null, validUntil: '2024-02-29' },
      }),
    ).toContain('Recorded dates: Start not recorded; through 2024-02-29 (inclusive).');
    expect(
      presentOwnerFamilyFact({
        subjectLabel: 'Alex',
        objectLabel: 'Sam',
        predicate: 'parent_of',
        timing: 'past',
        validity: { validFrom: '2024-02-29', validUntil: null },
      }),
    ).toContain('Recorded dates: From 2024-02-29; end not recorded.');
    expect(
      presentOwnerFamilyFact({
        subjectLabel: 'Alex',
        objectLabel: 'Sam',
        predicate: 'parent_of',
        timing: 'unspecified',
        validity: { validFrom: null, validUntil: null },
      }),
    ).toContain('Recorded dates: Start and end not recorded.');
    expect(statedPeriodEnd('2024-02-29')?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(
      validOwnerFamilyMeaning({
        timing: 'past',
        validity: { validFrom: '2024-03-01', validUntil: '2024-02-29' },
      }),
    ).toBe(false);
  });
  it('preserves direction from either endpoint and symmetric partner meaning', () => {
    expect(
      presentOwnerFamilyFact({
        subjectLabel: 'Alex',
        objectLabel: 'Sam',
        predicate: 'parent_of',
        ...meaning,
        timing: 'past',
      }),
    ).toContain("Recorded statement: Alex was Sam's parent. Timing recorded: past.");
    expect(
      presentOwnerFamilyFact({
        subjectLabel: 'Alex',
        objectLabel: 'Sam',
        predicate: 'partner_of',
        ...meaning,
        timing: 'present',
      }),
    ).toContain('Recorded statement: Alex and Sam are partners. Timing recorded: present.');
    expect(() =>
      presentOwnerFamilyFact({
        subjectLabel: 'Alex',
        objectLabel: 'Sam',
        predicate: 'former_spouse_of',
        ...meaning,
      }),
    ).toThrow('past');
  });
  it('retains the established former-spouse wording and covers registered family predicates', () => {
    const former = presentOwnerFamilyFact({
      subjectLabel: 'Alex',
      objectLabel: 'Sam',
      predicate: 'former_spouse_of',
      ...meaning,
      timing: 'past',
    });
    expect(former).toContain(
      'Recorded statement: Alex and Sam were spouses. Timing recorded: past.',
    );

    for (const spec of PREDICATE_VOCABULARY) {
      if (
        spec.group !== 'family' ||
        !spec.subjectKinds.includes('person') ||
        !spec.objectKinds.includes('person')
      )
        continue;
      const timing = spec.id.startsWith('former_') ? 'past' : 'unspecified';
      const sentence = presentOwnerFamilyFact({
        subjectLabel: 'A_B',
        objectLabel: 'We are Sam',
        predicate: spec.id,
        timing,
        validity: { validFrom: null, validUntil: null },
      });
      expect(sentence).toContain('A_B');
      expect(sentence).toContain('We are Sam');
      expect(sentence).toContain('Recorded statement:');
    }
  });
  it.each([
    ['Sam is Alex', 'We are Sam'],
    ['A_B', 'Sam is Alex'],
  ])('keeps person labels intact for directed and symmetric roles: %s / %s', (subject, object) => {
    for (const timing of ['past', 'present', 'unspecified'] as const) {
      const directed = presentOwnerFamilyFact({
        subjectLabel: subject,
        objectLabel: object,
        predicate: 'parent_of',
        ...meaning,
        timing,
      });
      expect(directed).toContain(subject);
      expect(directed).toContain(object);
      expect(directed).toContain(`${object}'s parent`);
      if (subject.includes('_')) expect(directed).not.toContain(subject.replaceAll('_', ' '));
      if (object.includes('_')) expect(directed).not.toContain(object.replaceAll('_', ' '));

      const symmetric = presentOwnerFamilyFact({
        subjectLabel: subject,
        objectLabel: object,
        predicate: 'partner_of',
        ...meaning,
        timing,
      });
      expect(symmetric).toContain(subject);
      expect(symmetric).toContain(object);
      expect(symmetric).toContain('partners');
      if (subject.includes('_')) expect(symmetric).not.toContain(subject.replaceAll('_', ' '));
      if (object.includes('_')) expect(symmetric).not.toContain(object.replaceAll('_', ' '));
      if (timing === 'past') expect(symmetric).toContain(`${subject} and ${object} were partners`);
      if (timing === 'present')
        expect(symmetric).toContain(`${subject} and ${object} are partners`);
      if (timing === 'unspecified')
        expect(symmetric).toContain(`${subject} and ${object} as partners`);
    }
  });
  it('requires sole raw canonical evidence/projection/source scope, never just source count', () => {
    expect(eligibleOwnerFamilyCorrection(scope())).toBe(true);
    for (const mutate of [
      (s: OwnerFamilyScopeRows) => {
        s.evidence.push({ ...s.evidence[0]!, id: 'another-source' });
      },
      (s: OwnerFamilyScopeRows) => {
        s.canonicalRelations.push({ ...s.relation, id: 'another-projection' });
      },
      (s: OwnerFamilyScopeRows) => {
        s.sourceRelations.push({ ...s.relation, id: 'sibling' });
      },
      (s: OwnerFamilyScopeRows) => {
        s.source.source = 'imported';
      },
      (s: OwnerFamilyScopeRows) => {
        s.assertion.reviewStatus = 'rejected';
      },
      (s: OwnerFamilyScopeRows) => {
        s.assertion.semanticKey = 'changed';
      },
      (s: OwnerFamilyScopeRows) => {
        s.source.validUntil = new Date('2024-02-29T12:00:00Z');
      },
      (s: OwnerFamilyScopeRows) => {
        s.sourcePrecisionLossless = false;
      },
      (s: OwnerFamilyScopeRows) => {
        s.relation.assertion = { ...s.relation.assertion!, tense: 'future' };
      },
    ]) {
      const s = scope();
      mutate(s);
      expect(eligibleOwnerFamilyCorrection(s)).toBe(false);
    }
  });
  it('uses actual preparation without atomic write or all-contact context scan; both exact name pins survive', async () => {
    const createAtomic = vi.fn(async () => ({}));
    const context = vi.fn(async () => {
      throw new Error('unbounded context forbidden');
    });
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const result = await prepareOwnerKnowledgeGraphFactWithRepository(
      {
        repository: {
          kind: 'owner-knowledge-graph-fact-repository',
          context,
          entity: async () => null,
          correctionTarget: async () => null,
          createAtomic,
        },
        router: {
          embeddingSpace: async () => ({
            provider: 'test',
            model: 'unit',
            dimensions: 3,
            revision: '1',
          }),
          embed,
        },
        agentId: 'owner',
        context: {
          agentId: 'owner',
          timeZone: 'Pacific/Auckland',
          locale: 'en',
          contacts: [
            { id: 'a', name: 'Alex', aliases: [] },
            { id: 'b', name: 'Alex', aliases: [] },
          ],
        },
      },
      {
        subject: { kind: 'person', label: 'Alex', contactId: 'a' },
        object: { kind: 'person', label: 'Alex', contactId: 'b' },
        predicate: 'parent_of',
        note: '',
        ...meaning,
      },
    );
    expect('prepared' in result).toBe(true);
    if (!('prepared' in result)) throw new Error(result.error);
    expect(result.prepared.subject.canonicalKey).toBe('contact:a');
    expect(result.prepared.object.canonicalKey).toBe('contact:b');
    expect(result.prepared.subject.matchedContactLabel).toBeUndefined();
    expect(result.prepared.object.matchedContactLabel).toBeUndefined();
    expect(result.prepared.validity).toEqual(meaning.validity);
    expect(result.prepared.content).toBe(embed.mock.calls[0]?.[0]?.[0]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(context).not.toHaveBeenCalled();
    expect(createAtomic).not.toHaveBeenCalled();
  });
});
