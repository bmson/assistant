import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProductVisualData } from '../../product-visual-data';
import { MemoryNavigation } from '../memory-navigation';
import { ConnectionsList } from './connections-list';

describe('bounded connections list navigation', () => {
  it('keeps directional source sentences and preserves filtered context on real person/source links', () => {
    const snapshot = createProductVisualData(false).map;
    const context = '/profile/knowledge?view=connections&q=Alex&family=family';
    const html = renderToStaticMarkup(
      <ConnectionsList snapshot={snapshot} contextHref={context} />,
    );
    for (const edge of snapshot.edges) expect(html).toContain(edge.presentation.sentence);
    expect(html).toContain('Browse Alex');
    expect(html).toContain(`returnTo=${encodeURIComponent(context)}`);
    expect(html).toContain('Open saved source note');
    expect(html).not.toContain('method="post"');
    expect(html).not.toContain('Remove connection');
    expect(html).not.toContain('check available changes');
    expect(html).not.toContain('Manage connection');
  });
  it('links each parallel person claim to its own exact dossier row and preserves the return context', () => {
    const snapshot = createProductVisualData(false).map;
    const firstId = '33333333-3333-4333-8333-333333333333';
    const secondId = '44444444-4444-4444-8444-444444444444';
    const source = snapshot.edges[0];
    if (!source) throw Error('Expected a synthetic graph edge');
    const html = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{
          ...snapshot,
          edges: [
            { ...source, id: firstId },
            { ...source, id: secondId },
          ],
        }}
        contextHref="/profile/knowledge?view=connections&q=Alex"
      />,
    );
    expect(html).toContain('to review this connection');
    for (const id of [firstId, secondId]) {
      expect(html).toContain(`connectionId=${id}#person-connection-${id}`);
      expect(html).toContain('returnTo=%2Fprofile%2Fknowledge%3Fview%3Dconnections%26q%3DAlex');
    }
  });
  it('keeps the generic person route when a graph edge id is not a UUID', () => {
    const snapshot = createProductVisualData(false).map;
    const source = snapshot.edges[0];
    if (!source) throw Error('Expected a synthetic graph edge');
    const html = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{ ...snapshot, edges: [{ ...source, id: 'untrusted-edge-id' }] }}
        contextHref="/profile/knowledge?view=connections"
      />,
    );
    expect(html).toContain('href="/people/00000000-0000-4000-8000-000000000001?returnTo=');
    expect(html).not.toContain('connectionId=');
    const personLabels = [...html.matchAll(/<a\b[^>]*href="\/people\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => (match[1] ?? '').replace(/<[^>]*>/g, ''))
      .join(' ');
    expect(personLabels).toContain('Browse Alex');
    expect(personLabels).not.toContain('review');
    expect(html).not.toContain('check available changes');
  });
  it.each([
    {
      title: 'person-origin relation',
      edgeIndex: 0,
      predicate: 'met_at',
      validUntil: null,
      exact: true,
      reviewable: true,
    },
    {
      title: 'non-person origin',
      edgeIndex: 1,
      predicate: 'met_at',
      validUntil: null,
      exact: false,
      reviewable: false,
    },
    {
      title: 'open outbound home summary',
      edgeIndex: 1,
      predicate: 'lives_in',
      validUntil: null,
      exact: false,
      reviewable: false,
    },
    {
      title: 'closed home connection',
      edgeIndex: 1,
      predicate: 'lives_in',
      validUntil: '2020',
      exact: true,
      reviewable: false,
    },
    {
      title: 'known non-person connection',
      edgeIndex: 1,
      predicate: 'works_at',
      validUntil: null,
      exact: true,
      reviewable: false,
    },
  ])('$title follows the dossier bucket and action boundary', (fixture) => {
    const snapshot = createProductVisualData(false).map;
    const source = snapshot.edges[fixture.edgeIndex];
    if (!source) throw Error('Expected a synthetic graph edge');
    const id = '55555555-5555-4555-8555-555555555555';
    const html = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{
          ...snapshot,
          edges: [{ ...source, id, predicate: fixture.predicate, validUntil: fixture.validUntil }],
        }}
        contextHref="/profile/knowledge?view=connections"
      />,
    );
    expect(html).toContain(
      fixture.exact ? `connectionId=${id}#person-connection-${id}` : 'Browse Alex',
    );
    if (fixture.reviewable) expect(html).toContain('to review this connection');
    else expect(html).not.toContain('to review this connection');
    if (fixture.exact && !fixture.reviewable) {
      expect(html).toContain('to view this connection');
      expect(html).toContain('This connection is read-only');
      expect(html).not.toContain('check available changes');
    }
    if (!fixture.exact) {
      expect(html).not.toContain('connectionId=');
      expect(html).not.toContain('check available changes');
    }
  });
  it('keeps rejected, unknown, and missing-endpoint edges on generic person navigation', () => {
    const snapshot = createProductVisualData(false).map;
    const personEdge = snapshot.edges[0];
    const homeEdge = snapshot.edges[1];
    if (!personEdge || !homeEdge) throw Error('Expected synthetic graph edges');
    const rejected = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{
          ...snapshot,
          edges: [
            { ...personEdge, id: '66666666-6666-4666-8666-666666666666', reviewStatus: 'rejected' },
          ],
        }}
        contextHref="/profile/knowledge?view=connections"
      />,
    );
    expect(rejected).toContain('Browse Alex');
    expect(rejected).not.toContain('connectionId=');
    expect(rejected).not.toContain('to review this connection');

    const unknownKind = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{
          ...snapshot,
          nodes: snapshot.nodes.map((node) =>
            node.id === homeEdge.objectId ? { ...node, kind: 'unknown' } : node,
          ),
          edges: [
            { ...homeEdge, id: '77777777-7777-4777-8777-777777777777', predicate: 'works_at' },
          ],
        }}
        contextHref="/profile/knowledge?view=connections"
      />,
    );
    expect(unknownKind).toContain('Browse Alex');
    expect(unknownKind).not.toContain('connectionId=');
    expect(unknownKind).not.toContain('to view this connection');

    const missingEndpoint = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{
          ...snapshot,
          nodes: snapshot.nodes.filter((node) => node.id !== personEdge.objectId),
          edges: [{ ...personEdge, id: '88888888-8888-4888-8888-888888888888' }],
        }}
        contextHref="/profile/knowledge?view=connections"
      />,
    );
    expect(missingEndpoint).toContain('Browse Alex');
    expect(missingEndpoint).not.toContain('connectionId=');
    expect(missingEndpoint).not.toContain('to review this connection');
  });
  it('does not invent contact routes for people known only in a saved note', () => {
    const snapshot = createProductVisualData(false).map;
    const html = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{ ...snapshot, nodes: snapshot.nodes.map(({ contactId: _, ...node }) => node) }}
        contextHref="/profile/knowledge?view=connections"
      />,
    );
    expect(html).not.toContain('href="/people/');
    expect(html).toContain('Open saved source note');
    expect(html).toContain('Editing and removal are unavailable from this list');
  });
  it('explains unavailable review when neither real contact nor source links exist', () => {
    const snapshot = createProductVisualData(false).map;
    const html = renderToStaticMarkup(
      <ConnectionsList
        snapshot={{
          ...snapshot,
          nodes: snapshot.nodes.map(({ contactId: _, ...node }) => node),
          edges: snapshot.edges.map((edge) => ({ ...edge, sourceMemoryId: 'unverified-source' })),
        }}
        contextHref="/profile/knowledge?view=connections"
      />,
    );
    expect(html).toContain('No linked person page or saved source note is available for context');
    expect(html).not.toContain('<a');
  });
  it('keeps empty and current navigation states honest', () => {
    const snapshot = createProductVisualData(true).map;
    expect(
      renderToStaticMarkup(
        <ConnectionsList snapshot={snapshot} contextHref="/profile/knowledge?view=connections" />,
      ),
    ).toContain('No matching connections in this loaded view');
    const nav = renderToStaticMarkup(<MemoryNavigation current="connections" />);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav).toContain('Saved notes');
    expect(nav).toContain('/people');
  });
});
