import { describe, expect, it } from 'vitest';
import { personDossierFromStoredParts } from './people.js';
import {
  canAddressPersonGraphEdge,
  type PersonGraphEdgeInput,
  projectPersonGraph,
} from './people-graph-projection.js';
import type { PersonProfile } from './profile/queries.js';

const contactId = '12345678-1234-4234-8234-123456789abc';
const edge = (patch: Partial<PersonGraphEdgeInput>): PersonGraphEdgeInput => ({
  id: 'edge',
  predicate: 'met_at',
  outbound: true,
  reviewStatus: 'confirmed',
  validFrom: '2019',
  validUntil: null,
  other: {
    id: 'other',
    label: 'Conference',
    kind: 'event',
    canonicalKey: 'event:conference',
  },
  ...patch,
});

describe('person graph projection', () => {
  it('keeps the saved-memory source id when stored non-person edges are composed into a dossier', () => {
    const profile: PersonProfile = {
      contact: {
        id: contactId,
        name: 'Anna',
        aliases: [],
        relationship: 'friend',
        trust: 'known',
      },
      facts: [],
      totalFacts: 0,
      occasions: [],
      occasionSuggestions: [],
      mergeOptions: [],
    };
    const sourceMemoryId = '88888888-8888-4888-8888-888888888888';
    const dossier = personDossierFromStoredParts(
      {
        profile,
        entity: null,
        edges: [
          edge({
            id: 'work-edge',
            sourceMemoryId,
            predicate: 'works_at',
            other: {
              id: 'organization-1',
              label: 'Praça Studio',
              kind: 'organization',
              canonicalKey: 'organization:praça-studio',
            },
          }),
        ],
        events: [],
        occasions: [],
      },
      new Date('2026-09-02T12:00:00.000Z'),
    );
    expect(dossier.connections).toEqual([
      expect.objectContaining({
        id: 'work-edge',
        sentence: 'Anna works at Praça Studio.',
        sourceMemoryId,
      }),
    ]);
  });

  it('preserves stored direction for people and contact links', () => {
    const result = projectPersonGraph('Anna', [
      edge({
        id: 'parent',
        predicate: 'parent_of',
        outbound: false,
        reviewStatus: 'unreviewed',
        other: {
          id: 'parent-entity',
          label: 'Björk',
          kind: 'person',
          canonicalKey: `contact:${contactId}`,
        },
      }),
    ]);
    expect(result.relations).toEqual([
      expect.objectContaining({
        sentence: "Björk is Anna's parent.",
        otherContactId: contactId,
        otherEntityId: 'parent-entity',
        reviewStatus: 'unreviewed',
      }),
    ]);
    expect(result.connections).toEqual([]);
  });

  it.each([
    {
      title: 'person relation in either direction, including an origin predicate',
      patch: {
        id: '10000000-0000-4000-8000-000000000001',
        predicate: 'met_at',
        outbound: false,
        other: {
          id: 'person-entity',
          label: 'Björk',
          kind: 'person',
          canonicalKey: `contact:${contactId}`,
        },
      },
      bucket: 'relations',
      addressable: true,
    },
    {
      title: 'person relation with a non-origin predicate',
      patch: {
        id: '10000000-0000-4000-8000-000000000002',
        predicate: 'parent_of',
        other: {
          id: 'person-entity',
          label: 'Björk',
          kind: 'person',
          canonicalKey: `contact:${contactId}`,
        },
      },
      bucket: 'relations',
      addressable: true,
    },
    {
      title: 'non-person meeting origin',
      patch: {
        id: '10000000-0000-4000-8000-000000000003',
        predicate: 'met',
      },
      bucket: 'origins',
      addressable: false,
    },
    {
      title: 'non-person met-at origin in reverse direction',
      patch: {
        id: '10000000-0000-4000-8000-000000000004',
        predicate: 'met_at',
        outbound: false,
      },
      bucket: 'origins',
      addressable: false,
    },
    {
      title: 'non-person met-during origin',
      patch: {
        id: '10000000-0000-4000-8000-000000000005',
        predicate: 'met_during',
      },
      bucket: 'origins',
      addressable: false,
    },
    {
      title: 'open outbound home is a location label without an edge id in that bucket',
      patch: {
        id: '10000000-0000-4000-8000-000000000006',
        predicate: 'lives_in',
      },
      bucket: 'location',
      addressable: false,
    },
    {
      title: 'open inbound home remains an ordinary connection',
      patch: {
        id: '10000000-0000-4000-8000-000000000007',
        predicate: 'lives_in',
        outbound: false,
      },
      bucket: 'connections',
      addressable: true,
    },
    {
      title: 'closed outbound home remains an ordinary connection',
      patch: {
        id: '10000000-0000-4000-8000-000000000008',
        predicate: 'lives_in',
        validUntil: '2020',
      },
      bucket: 'connections',
      addressable: true,
    },
    {
      title: 'other non-person connection',
      patch: {
        id: '10000000-0000-4000-8000-000000000009',
        predicate: 'works_at',
      },
      bucket: 'connections',
      addressable: true,
    },
    {
      title: 'other non-person connection in reverse direction',
      patch: {
        id: '10000000-0000-4000-8000-000000000010',
        predicate: 'works_at',
        outbound: false,
      },
      bucket: 'connections',
      addressable: true,
    },
    {
      title: 'unknown endpoint kind stays generic',
      patch: {
        id: '10000000-0000-4000-8000-000000000011',
        predicate: 'parent_of',
        other: { id: 'unknown', label: 'Unknown', kind: 'unknown', canonicalKey: 'unknown:x' },
      },
      bucket: 'connections',
      addressable: false,
    },
  ] as const)(
    'selects only exact rows retained in dossier buckets: $title',
    ({ patch, bucket, addressable }) => {
      const projectedEdge = edge(patch);
      const projection = projectPersonGraph('Anna', [projectedEdge]);
      const profile: PersonProfile = {
        contact: {
          id: contactId,
          name: 'Anna',
          aliases: [],
          relationship: 'friend',
          trust: 'known',
        },
        facts: [],
        totalFacts: 0,
        occasions: [],
        occasionSuggestions: [],
        mergeOptions: [],
      };
      const dossier = personDossierFromStoredParts(
        { profile, entity: null, edges: [projectedEdge], events: [], occasions: [] },
        new Date('2026-09-02T12:00:00.000Z'),
      );
      const bucketFor = (graph: typeof projection | typeof dossier) =>
        graph.relations.some((row) => row.id === projectedEdge.id)
          ? 'relations'
          : graph.origins.some((row) => row.id === projectedEdge.id)
            ? 'origins'
            : graph.connections.some((row) => row.id === projectedEdge.id)
              ? 'connections'
              : graph.location !== null
                ? 'location'
                : null;
      expect(bucketFor(projection)).toBe(bucket);
      expect(bucketFor(dossier)).toBe(bucket);
      expect(
        canAddressPersonGraphEdge({
          edgeId: projectedEdge.id,
          predicate: projectedEdge.predicate,
          outbound: projectedEdge.outbound,
          validUntil: projectedEdge.validUntil,
          otherKind: projectedEdge.other.kind,
          reviewStatus: projectedEdge.reviewStatus,
        }),
      ).toBe(addressable);
    },
  );

  it('keeps exact selection distinct from rejected, malformed, or unknown-status rows', () => {
    const base = {
      predicate: 'parent_of',
      outbound: true,
      validUntil: null,
      otherKind: 'person',
    };
    expect(
      canAddressPersonGraphEdge({
        ...base,
        edgeId: '10000000-0000-4000-8000-000000000012',
        reviewStatus: 'rejected',
      }),
    ).toBe(false);
    expect(
      canAddressPersonGraphEdge({ ...base, edgeId: 'bad-id', reviewStatus: 'confirmed' }),
    ).toBe(false);
    expect(
      canAddressPersonGraphEdge({
        ...base,
        edgeId: '10000000-0000-4000-8000-000000000013',
        reviewStatus: 'unknown',
      }),
    ).toBe(false);
  });

  it('uses only the first open outbound home edge as location and separates origins', () => {
    const result = projectPersonGraph('Anna', [
      edge({
        id: 'home',
        predicate: 'lives_in',
        other: { id: 'place', label: 'Reykjavík', kind: 'place', canonicalKey: 'place:reykjavik' },
      }),
      edge({
        id: 'second-home',
        predicate: 'lives_in',
        other: { id: 'place-2', label: 'Oslo', kind: 'place', canonicalKey: 'place:oslo' },
      }),
      edge({
        id: 'past-home',
        predicate: 'lives_in',
        validUntil: '2020',
        other: { id: 'place-3', label: 'Paris', kind: 'place', canonicalKey: 'place:paris' },
      }),
      edge({ id: 'met', predicate: 'met_at' }),
    ]);
    expect(result.location).toBe('Reykjavík');
    expect(result.connections.map((row) => row.id)).toEqual(['second-home', 'past-home']);
    expect(result.origins.map((row) => row.id)).toEqual(['met']);
    expect(result.origins[0]?.sentence).toBe('Anna is related to Conference.');
  });

  it('keeps duplicate open home rows generic even when the later row remains in connections', () => {
    const first = edge({
      id: '10000000-0000-4000-8000-000000000014',
      predicate: 'lives_in',
    });
    const second = edge({
      id: '10000000-0000-4000-8000-000000000015',
      predicate: 'lives_in',
      other: { id: 'second-place', label: 'Oslo', kind: 'place', canonicalKey: 'place:oslo' },
    });
    const projection = projectPersonGraph('Anna', [first, second]);
    expect(projection.location).toBe('Conference');
    expect(projection.connections.map((row) => row.id)).toEqual([second.id]);
    for (const projectedEdge of [first, second])
      expect(
        canAddressPersonGraphEdge({
          edgeId: projectedEdge.id,
          predicate: projectedEdge.predicate,
          outbound: projectedEdge.outbound,
          validUntil: projectedEdge.validUntil,
          otherKind: projectedEdge.other.kind,
          reviewStatus: projectedEdge.reviewStatus,
        }),
      ).toBe(false);
  });
});
