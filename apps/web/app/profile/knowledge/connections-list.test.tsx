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
    expect(html).toContain('Open Alex to review');
    expect(html).toContain(`returnTo=${encodeURIComponent(context)}`);
    expect(html).toContain('Open saved source note');
    expect(html).not.toContain('method="post"');
    expect(html).not.toContain('Remove connection');
    expect(html).toContain('check available changes');
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
    expect(personLabels).toContain('to review');
    expect(personLabels).not.toContain('this connection');
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
    expect(html).toContain('No linked person page or saved source note is available to review');
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
