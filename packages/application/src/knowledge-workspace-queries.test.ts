import type { KnowledgeMapEdgeRecord } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  assembleKnowledgeMapSnapshot,
  knowledgeMapFilters,
  legacyKnowledgeMapDisplayPolicy,
  MAP_OVERVIEW_EDGE_LIMIT,
} from './knowledge-workspace-queries.js';

function edge(id: string, objectId = 'recent'): KnowledgeMapEdgeRecord {
  return {
    id,
    subjectId: 'owner',
    subjectLabel: 'Owner',
    subjectKind: 'person',
    subjectContactId: null,
    objectId,
    objectLabel: objectId,
    objectKind: 'person',
    objectContactId: null,
    predicate: 'parent_of',
    reviewStatus: 'confirmed',
    sourceMemoryId: id,
    sourceContent: 'Recorded family connection',
    evidenceQuote: 'Recorded family connection',
    validFrom: null,
    validUntil: null,
  };
}

describe('complete graph overview', () => {
  it('projects typed forward and inverse wording only for a matching current assertion', async () => {
    const canonical = edge('canonical', 'child');
    canonical.assertionContext = {
      id: 'assertion-1',
      semanticRevision: 4,
      lifecycle: 'current',
      reviewStatus: 'confirmed',
      subjectEntityId: 'owner',
      predicate: 'parent_of',
      objectEntityId: 'child',
      evidenceCount: 2,
    };
    const legacy = edge('legacy', 'legacy-child');
    const stale = edge('stale', 'stale-child');
    stale.assertionContext = {
      id: 'assertion-stale',
      semanticRevision: 1,
      lifecycle: 'superseded',
      reviewStatus: 'confirmed',
      subjectEntityId: 'owner',
      predicate: 'parent_of',
      objectEntityId: 'stale-child',
      evidenceCount: 1,
    };
    const graph = await assembleKnowledgeMapSnapshot({
      rows: [canonical, legacy, stale],
      totalEdges: 3,
      filters: knowledgeMapFilters({}),
    });

    expect(graph.edges.find((row) => row.id === 'canonical')?.endpointViews).toEqual([
      expect.objectContaining({
        focusEntityId: 'owner',
        direction: 'forward',
        text: 'Owner is the parent of child',
        evidenceCount: 2,
      }),
      expect.objectContaining({
        focusEntityId: 'child',
        direction: 'inverse',
        text: 'child is the child of Owner',
      }),
    ]);
    expect(graph.edges.find((row) => row.id === 'legacy')?.endpointViews).toBeUndefined();
    expect(graph.edges.find((row) => row.id === 'stale')?.endpointViews).toBeUndefined();
  });

  it('keeps older people beyond the former 200-item bound and repeated recent evidence', async () => {
    const rows = [
      ...Array.from({ length: 501 }, (_, i) => edge(`recent-${i}`)),
      ...Array.from({ length: 350 }, (_, i) => edge(`old-${i}`, `person-${i}`)),
    ];
    const graph = await assembleKnowledgeMapSnapshot({
      rows,
      totalEdges: rows.length,
      filters: knowledgeMapFilters({}),
      completeOverview: true,
    });
    expect(graph.nodes).toHaveLength(352);
    expect(graph.edges).toHaveLength(rows.length);
    expect(graph.nodes.some((node) => node.id === 'person-349')).toBe(true);
    expect(graph.truncated).toBe(false);
  });

  it('reserves room for distinct connections before extra evidence and reports actual truncation', async () => {
    const rows = [
      ...Array.from({ length: MAP_OVERVIEW_EDGE_LIMIT }, (_, i) => edge(`recent-${i}`)),
      edge('old', 'grandmother'),
    ];
    const graph = await assembleKnowledgeMapSnapshot({
      rows,
      totalEdges: rows.length,
      filters: knowledgeMapFilters({}),
      completeOverview: true,
    });
    expect(graph.nodes.some((node) => node.id === 'grandmother')).toBe(true);
    expect(graph.edges.some((edge) => edge.id === 'old')).toBe(true);
    expect(graph.edges).toHaveLength(MAP_OVERVIEW_EDGE_LIMIT);
    expect(graph.truncated).toBe(true);
  });
});

describe('legacy map evidence policy', () => {
  const policy = legacyKnowledgeMapDisplayPolicy();
  const claim = {
    sourceContent: 'Anna lives in Oslo.',
    subjectLabel: 'Anna',
    predicate: 'lives_in',
    objectLabel: 'Oslo',
    evidenceQuote: 'Anna lives in Oslo',
  };
  it('accepts a directly quoted positive claim without generating an assertion', () => {
    expect(policy.minimumExtractionVersion).toBe(2);
    expect(policy.isGrounded(claim)).toBe(true);
  });
  it.each([
    ['negation', 'Anna does not live in Oslo.', 'Anna does not live in Oslo'],
    ['uncertainty', 'Anna might live in Oslo.', 'Anna might live in Oslo'],
    ['reported claim', 'Someone said Anna lives in Oslo.', 'Anna lives in Oslo'],
    ['invented quote', 'Anna visits Bergen.', 'Anna lives in Oslo'],
  ])('rejects %s', (_, sourceContent, evidenceQuote) => {
    expect(policy.isGrounded({ ...claim, sourceContent, evidenceQuote })).toBe(false);
  });
  it('does not reverse direction or substitute a preferred label for literal evidence', () => {
    expect(policy.isGrounded({ ...claim, subjectLabel: 'Oslo', objectLabel: 'Anna' })).toBe(false);
    expect(policy.isGrounded({ ...claim, subjectLabel: 'Annabelle' })).toBe(false);
  });
});
