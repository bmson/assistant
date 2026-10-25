import type { KnowledgeMapSnapshot } from '@assistant/application';
import { presentKnowledgeGraphRelation } from '@assistant/application/relationship-presentation';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// An admitted browse tree must not even import Server Action dependencies.
vi.mock('./actions', () => {
  throw new Error('Browse imported POST actions');
});

import { KnowledgeMap } from './knowledge-map';
import { knowledgeConnections } from './knowledge-map-model';

const snapshot: KnowledgeMapSnapshot = {
  nodes: [
    { id: 'a', label: 'Alex Full Name', kind: 'person', degree: 1, component: 0 },
    { id: 'b', label: 'Sam Full Name', kind: 'person', degree: 1, component: 0 },
  ],
  edges: [
    {
      id: 'edge',
      subjectId: 'a',
      objectId: 'b',
      predicate: 'parent_of',
      reviewStatus: 'unreviewed',
      sourceMemoryId: 'source',
      sourceContent: 'A saved note about Alex and Sam.',
      evidenceQuote: 'Alex is Sam’s parent.',
      presentation: {
        sentence: 'Alex is Sam’s parent.',
        label: 'Parent',
        accessibleLabel: 'Alex is Sam’s parent.',
      },
      validFrom: '2020',
      validUntil: null,
    },
  ],
  components: [{ id: 0, nodes: 2, edges: 1, label: 'Family' }],
  totalEdges: 4,
  truncated: true,
  filters: {
    query: '',
    kind: 'person',
    predicates: ['parent_of'],
    review: 'all',
    sourceMemoryId: 'source',
  },
};
describe('Knowledge map browse presentation', () => {
  it('renders loaded relationship sentence, status and local source note without action controls', () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap
        snapshot={snapshot}
        initialSelectedId="a"
        contextHref="/profile/knowledge?view=map&memory=source&family=family"
      />,
    );
    expect(html).toContain('Alex Full Name');
    expect(html).toContain('Alex is Sam’s parent.');
    expect(html).toContain('Unreviewed connection');
    expect(html).toContain('A saved note about Alex and Sam.');
    expect(html).toContain('Saved source notes');
    expect(html).toContain('memory=source');
    expect(html).not.toMatch(/Review or edit|Remove connection|Forget|method="post"/);
  });
  // SSR proves initial composition only. Real Map → List → select → back
  // remains a required assertion in the next reviewed mounted-browser harness.
  it('keeps navigation free of inspector/list content and renders one body inspector', () => {
    const html = renderToStaticMarkup(<KnowledgeMap snapshot={snapshot} initialSelectedId="a" />);
    const toolbar = /<nav aria-label="Knowledge map navigation"[\s\S]*?<\/nav>/.exec(html)?.[0];
    expect(toolbar).toBeDefined();
    expect(toolbar).toContain('Starting points');
    expect(toolbar).toContain('aria-label="Connection view"');
    expect(toolbar).not.toMatch(/<aside|<article|Items in this loaded view|Saved source notes/);
    expect([...html.matchAll(/aria-label="Selected knowledge item"/g)]).toHaveLength(1);
    expect([...html.matchAll(/<nav aria-label="Knowledge map navigation"/g)]).toHaveLength(1);
  });
  it('keeps an empty map honest and offers only supported GET navigation', () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap
        snapshot={{ ...snapshot, nodes: [], edges: [], components: [], totalEdges: 0 }}
      />,
    );
    expect(html).toContain('No connected items in this loaded view');
    expect(html).toContain('href="/profile/knowledge?view=map"');
    expect(html).toContain('href="/profile/knowledge?view=library"');
    expect(html).not.toMatch(/Add or organize|method="post"/);
  });
  it('does not invent missing source content or contact pages', () => {
    const missing = {
      ...snapshot,
      edges: snapshot.edges.map((edge) => ({ ...edge, evidenceQuote: null, sourceContent: '' })),
    };
    const html = renderToStaticMarkup(<KnowledgeMap snapshot={missing} initialSelectedId="a" />);
    expect(html).toContain('Source preview unavailable in this view.');
    expect(html).not.toContain('href="/people/');
  });
  it('keeps absent neighbor endpoint as a bounded GET link rather than fetching on mount', () => {
    const absent = { ...snapshot, nodes: snapshot.nodes.filter((node) => node.id === 'a') };
    const html = renderToStaticMarkup(<KnowledgeMap snapshot={absent} initialSelectedId="a" />);
    expect(html).toContain('Open item outside this loaded view');
    expect(html).toContain('entity=b');
    expect(html).not.toContain('Loading connections');
    expect(html).not.toContain('href="/people/');
  });
});

function familySnapshot(): KnowledgeMapSnapshot {
  const labels = new Map([
    ['alex', 'Alex Example'],
    ['sam', 'Sam Example'],
    ['casey', 'Casey Example'],
  ]);
  const claim = (
    id: string,
    subjectId: string,
    predicate: string,
    objectId: string,
    sourceMemoryId: string,
    reviewStatus: 'confirmed' | 'unreviewed',
    validFrom: string,
    validUntil: string | null,
  ): KnowledgeMapSnapshot['edges'][number] => {
    const subjectLabel = labels.get(subjectId);
    const objectLabel = labels.get(objectId);
    if (!subjectLabel || !objectLabel) throw new Error('Missing synthetic endpoint label');
    const presentation = presentKnowledgeGraphRelation({ subjectLabel, predicate, objectLabel });
    return {
      id,
      subjectId,
      objectId,
      predicate,
      reviewStatus,
      sourceMemoryId,
      sourceContent: `SYNTHETIC saved note ${sourceMemoryId}. ${presentation.sentence}`,
      evidenceQuote: presentation.sentence,
      presentation,
      validFrom,
      validUntil,
    };
  };
  const edges = [
    claim('parent-one', 'alex', 'parent_of', 'sam', 'parent-note-one', 'confirmed', '2010', null),
    claim('parent-two', 'alex', 'parent_of', 'sam', 'parent-note-two', 'unreviewed', '2010', null),
    claim(
      'conflicting-parent',
      'sam',
      'parent_of',
      'alex',
      'conflicting-note',
      'unreviewed',
      '2010',
      null,
    ),
    claim(
      'former-partner',
      'alex',
      'partner_of',
      'casey',
      'former-note',
      'confirmed',
      '2010',
      '2020',
    ),
    claim(
      'current-partner',
      'alex',
      'partner_of',
      'casey',
      'current-note',
      'confirmed',
      '2022',
      null,
    ),
  ];
  return {
    nodes: [...labels].map(([id, label]) => ({
      id,
      label,
      kind: 'person',
      component: 0,
      degree: edges.filter((edge) => edge.subjectId === id || edge.objectId === id).length,
    })),
    edges,
    components: [{ id: 0, nodes: 3, edges: edges.length, label: 'Synthetic saved family claims' }],
    totalEdges: edges.length,
    truncated: false,
    filters: { query: '', kind: 'person', predicates: [], review: 'all', sourceMemoryId: '' },
  };
}

function htmlText(value: string) {
  return renderToStaticMarkup(<span>{value}</span>).slice('<span>'.length, -'</span>'.length);
}
function inspector(html: string) {
  const result = /<aside\b[\s\S]*?<\/aside>/.exec(html)?.[0];
  if (!result) throw new Error('Expected selected-item inspector');
  return result;
}

it.each(['alex', 'sam', 'casey'])(
  'renders stored family claims from selected endpoint %s without reversing or merging distinct claims',
  (selected) => {
    const family = familySnapshot();
    const connections = knowledgeConnections(family, selected);
    const html = renderToStaticMarkup(
      <KnowledgeMap snapshot={family} initialSelectedId={selected} />,
    );
    const panel = inspector(html);
    expect([...panel.matchAll(/<article\b/g)]).toHaveLength(connections.length);
    for (const connection of connections) {
      // The application presenter narrates stored direction independently of
      // the selected endpoint; the existing model owns evidence grouping.
      expect(panel).toContain(htmlText(connection.edge.presentation.sentence));
      for (const source of connection.sources)
        expect(panel).toContain(htmlText(source.sourceContent));
    }
    if (selected === 'alex' || selected === 'sam') {
      const parent = connections.find((connection) => connection.edge.id === 'parent-one');
      expect(parent?.sources.map((source) => source.sourceMemoryId)).toEqual([
        'parent-note-one',
        'parent-note-two',
      ]);
      expect(parent?.confirmed).toBe(true);
      const conflict = connections.find(
        (connection) => connection.edge.id === 'conflicting-parent',
      );
      expect(conflict?.confirmed).toBe(false);
      expect(panel).toContain('Unreviewed connection');
      expect(panel).toContain('Source connection not yet reviewed');
      expect(
        connections.filter((connection) => connection.edge.predicate === 'parent_of'),
      ).toHaveLength(2);
    }
    if (selected === 'alex' || selected === 'casey') {
      const partners = connections.filter(
        (connection) => connection.edge.predicate === 'partner_of',
      );
      expect(partners).toHaveLength(2);
      expect(partners.map((connection) => connection.edge.validUntil)).toEqual(
        expect.arrayContaining(['2020', null]),
      );
      expect(panel).toContain('2010 to 2020');
      expect(panel).toContain('2022 to no end recorded');
      expect(partners[0]?.edge.presentation.sentence).toBe(partners[1]?.edge.presentation.sentence);
    }
    expect(panel).not.toMatch(/Remove connection|Review or edit|Forget|method="post"/);
  },
);

it('keeps a named-only item free of inferred family relationships or invented source evidence', () => {
  const family = familySnapshot();
  const namedOnly = { ...family, edges: [], totalEdges: 0, components: [] };
  expect(knowledgeConnections(namedOnly, 'alex')).toEqual([]);
  const panel = inspector(
    renderToStaticMarkup(<KnowledgeMap snapshot={namedOnly} initialSelectedId="alex" />),
  );
  expect(panel).toContain('Alex Example');
  expect(panel).toContain('No connections are loaded for this item in this view.');
  expect(panel).not.toContain('<article');
  expect(panel).not.toContain('Saved source notes');
  expect(panel).not.toContain('parent');
  expect(panel).not.toContain('partners');
});
