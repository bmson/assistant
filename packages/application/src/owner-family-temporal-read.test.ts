import type { KnowledgeMapEdgeRecord } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  assembleKnowledgeMapSnapshot,
  knowledgeMapFilters,
} from './knowledge-workspace-queries.js';
import {
  type PersonGraphEdgeInput,
  presentPersonGraphRelation,
  projectPersonGraph,
} from './people-graph-projection.js';
import { presentKnowledgeGraphRelation } from './relationship-presentation.js';

const subjectId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
const civilStart = '2001-05-06';
const civilEnd = '2011-07-08';

function personEdge(patch: Partial<PersonGraphEdgeInput> = {}): PersonGraphEdgeInput {
  return {
    id: 'family-edge',
    predicate: 'parent_of',
    outbound: true,
    reviewStatus: 'confirmed',
    validFrom: civilStart,
    validUntil: civilEnd,
    assertionTiming: 'past',
    other: {
      id: objectId,
      label: 'Björk',
      kind: 'person',
      canonicalKey: `contact:${objectId}`,
    },
    ...patch,
  };
}

function mapEdge(
  id: string,
  assertionTiming?: 'unspecified' | 'present' | 'past' | null,
  predicate = 'parent_of',
): KnowledgeMapEdgeRecord {
  return {
    id,
    subjectId,
    subjectLabel: 'Anna',
    subjectKind: 'person',
    subjectContactId: subjectId,
    objectId,
    objectLabel: 'Björk',
    objectKind: 'person',
    objectContactId: objectId,
    predicate,
    reviewStatus: 'confirmed',
    sourceMemoryId: `source-${id}`,
    sourceContent: 'Anna recorded the family relationship.',
    evidenceQuote: "Anna is Björk's parent.",
    validFrom: civilStart,
    validUntil: civilEnd,
    assertionTiming,
  };
}

describe('stored family assertion timing in People and map projections', () => {
  it('preserves past, unspecified, and present timing without deriving it from dates', () => {
    const past = projectPersonGraph('Anna', [personEdge({ assertionTiming: 'past' })]);
    expect(past.relations[0]?.sentence).toContain(
      "Recorded statement: Anna was Björk's parent. Timing recorded: past.",
    );
    expect(past.relations[0]?.sentence).toContain(
      `Recorded dates: From ${civilStart} through ${civilEnd} (inclusive).`,
    );

    const unspecified = projectPersonGraph('Anna', [
      personEdge({ assertionTiming: 'unspecified' }),
    ]);
    expect(unspecified.relations[0]?.sentence).toContain(
      "Recorded statement: The saved relationship identifies Anna as Björk's parent. Timing recorded: not recorded.",
    );
    expect(unspecified.relations[0]?.sentence).toContain(
      `Recorded dates: From ${civilStart} through ${civilEnd} (inclusive).`,
    );

    const present = projectPersonGraph('Anna', [personEdge({ assertionTiming: 'present' })]);
    expect(present.relations[0]?.sentence).toContain(
      "Recorded statement: Anna is Björk's parent. Timing recorded: present.",
    );

    const datedButUnspecified = projectPersonGraph('Anna', [
      personEdge({ assertionTiming: undefined }),
    ]);
    expect(datedButUnspecified.relations[0]?.sentence).toBe("Anna is Björk's parent.");
  });

  it('preserves stored direction and falls back for unsupported legacy grammar or dates', () => {
    const inverse = projectPersonGraph('Anna', [
      personEdge({ outbound: false, assertionTiming: 'past' }),
    ]);
    expect(inverse.relations[0]?.sentence).toContain(
      "Recorded statement: Björk was Anna's parent. Timing recorded: past.",
    );

    const partialDate = presentPersonGraphRelation({
      subjectLabel: 'Anna',
      predicate: 'parent_of',
      objectLabel: 'Björk',
      otherIsPerson: true,
      validFrom: '2001',
      validUntil: null,
      assertionTiming: 'past',
    });
    expect(partialDate.sentence).toBe("Anna is Björk's parent.");

    const nonFamily = presentPersonGraphRelation({
      subjectLabel: 'Anna',
      predicate: 'lives_in',
      objectLabel: 'Oslo',
      otherIsPerson: false,
      validFrom: null,
      validUntil: null,
      assertionTiming: 'past',
    });
    expect(nonFamily.sentence).toBe('Anna lives in Oslo.');

    const formerFallback = presentKnowledgeGraphRelation({
      subjectLabel: 'Anna',
      predicate: 'former_spouse_of',
      objectLabel: 'Björk',
    });
    for (const timing of ['present', 'unspecified'] as const) {
      const former = projectPersonGraph('Anna', [
        personEdge({ predicate: 'former_spouse_of', assertionTiming: timing }),
      ]);
      expect(former.relations[0]?.sentence).toBe(formerFallback.sentence);
    }
  });

  it('uses the same stored timing wording for full map snapshots', async () => {
    const map = await assembleKnowledgeMapSnapshot({
      rows: [
        mapEdge('past-map', 'past'),
        mapEdge('unspecified-map', 'unspecified'),
        mapEdge('legacy-map'),
      ],
      totalEdges: 3,
      filters: knowledgeMapFilters({}),
    });
    expect(map.edges.find((edge) => edge.id === 'past-map')?.presentation.sentence).toContain(
      "Recorded statement: Anna was Björk's parent. Timing recorded: past.",
    );
    expect(
      map.edges.find((edge) => edge.id === 'unspecified-map')?.presentation.sentence,
    ).toContain('Timing recorded: not recorded.');
    expect(map.edges.find((edge) => edge.id === 'legacy-map')?.presentation.sentence).toBe(
      "Anna is Björk's parent.",
    );

    const formerMap = await assembleKnowledgeMapSnapshot({
      rows: [
        mapEdge('former-present', 'present', 'former_spouse_of'),
        mapEdge('former-unspecified', 'unspecified', 'former_spouse_of'),
      ],
      totalEdges: 2,
      filters: knowledgeMapFilters({}),
    });
    const formerSentence = presentKnowledgeGraphRelation({
      subjectLabel: 'Anna',
      predicate: 'former_spouse_of',
      objectLabel: 'Björk',
    }).sentence;
    expect(formerMap.edges.map((edge) => edge.presentation.sentence)).toEqual([
      formerSentence,
      formerSentence,
    ]);
  });
});
