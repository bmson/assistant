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
