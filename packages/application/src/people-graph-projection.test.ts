import { describe, expect, it } from 'vitest';
import { personDossierFromStoredParts } from './people.js';
import { type PersonGraphEdgeInput, projectPersonGraph } from './people-graph-projection.js';
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
});
