import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectionsFilters } from './connections-filters';

const initial = {
  query: 'Alex & family',
  kind: 'person',
  family: 'family',
  review: 'unreviewed',
  families: ['family', 'work'],
  retained: {
    q: 'Alex & family',
    kind: 'person',
    family: 'family',
    review: 'unreviewed',
    state: 'review',
    filter: 'verified',
    subject: 'subject-id',
    domain: 'home',
    source: 'saved source',
    age: 90,
    connectivity: 'connected',
    memory: 'memory-id',
    entity: 'entity-id',
  },
};
function decode(value: string) {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'");
}
// Model successful native GET controls from actual rendered markup, including
// closed-details controls. This is URL contract evidence, not browser submission proof.
function submitted(html: string) {
  const params = new URLSearchParams();
  for (const tag of html.matchAll(/<input\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(tag[0])?.[1];
    const value = /value="([^"]*)"/.exec(tag[0])?.[1] ?? '';
    if (name) params.append(decode(name), decode(value));
  }
  for (const select of html.matchAll(/<select\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const selected =
      /<option\b(?=[^>]*selected="")[^>]*value="([^"]*)"/.exec(select[2]) ??
      /<option\b[^>]*value="([^"]*)"/.exec(select[2]);
    if (!selected) throw new Error('Missing selected option');
    params.append(select[1], decode(selected[1]));
  }
  return params;
}
describe('compact native Connections filters', () => {
  it('keeps search and Add outside a closed, counted secondary disclosure', () => {
    const html = renderToStaticMarkup(<ConnectionsFilters {...initial} />);
    const form = /<form[^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/profile/knowledge"');
    const before = html.slice(0, html.indexOf('<details'));
    expect(before).toContain('Search connections');
    expect(before).toContain('Add connection');
    expect(html).toContain('Filters (3 active)');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
    expect(html).toContain('Apply filters');
    expect(html).not.toMatch(/onchange|onsubmit|method="post"|<script/i);
  });
  it('retains every selected GET value exactly once even while details is closed', () => {
    const html = renderToStaticMarkup(<ConnectionsFilters {...initial} />);
    const query = submitted(html);
    expect(query.get('view')).toBe('connections');
    for (const [key, value] of Object.entries(initial.retained)) {
      expect(query.getAll(key)).toEqual([String(value)]);
    }
    expect([...query.keys()].sort()).toEqual(['view', ...Object.keys(initial.retained)].sort());
  });
  it('counts only nondefault secondary filters and offers a view-only clear URL', () => {
    const html = renderToStaticMarkup(
      <ConnectionsFilters
        {...initial}
        query="Alex"
        kind=""
        family=""
        review="all"
        retained={{ q: 'Alex' }}
      />,
    );
    expect(html).toContain('Filters (0 active)');
    expect(html).toContain('href="/profile/knowledge?view=connections"');
    expect(Object.fromEntries(submitted(html))).toEqual({
      view: 'connections',
      q: 'Alex',
      kind: '',
      family: '',
      review: 'all',
    });
  });
  it('provides native labels and at least 44px targets without font shrinking', () => {
    const html = renderToStaticMarkup(<ConnectionsFilters {...initial} />);
    const summary = /<summary[^>]*>/.exec(html)?.[0] ?? '';
    expect(summary).toContain('min-h-11');
    expect(summary).toContain('focus-visible:');
    for (const tag of html.matchAll(/<(?:button|select|a)\b[^>]*>/g))
      expect(tag[0]).toContain('min-h-11');
    expect(html).toContain('Item type');
    expect(html).toContain('Relationship');
    expect(html).toContain('Review status');
    expect(html).not.toMatch(/text-xs|text-\[/);
  });
});
