import { describe, expect, it } from 'vitest';
import {
  memoryMapReturnTo,
  memoryPersonConnectionHref,
  memoryPersonEditorHref,
} from './memory-editor-context';

const contactId = '22222222-2222-4222-8222-222222222222';
const relationId = '33333333-3333-4333-8333-333333333333';
const context = '/profile/knowledge?view=connections&q=Alex#knowledge-item';

describe('memory person links from graph claims', () => {
  it('carries an exact validated relation, safe return context and row anchor', () => {
    expect(memoryPersonConnectionHref(contactId, relationId, context)).toBe(
      `/people/${contactId}?returnTo=${encodeURIComponent(context)}&connectionId=${relationId}#person-connection-${relationId}`,
    );
  });

  it('falls back to the generic person link for an invalid relation identifier', () => {
    expect(memoryPersonConnectionHref(contactId, 'not-a-uuid', context)).toBe(
      memoryPersonEditorHref(contactId, context),
    );
  });

  it('creates no person route for an invalid endpoint and never trusts an external return URL', () => {
    expect(memoryPersonConnectionHref('not-a-uuid', relationId, context)).toBeNull();
    expect(
      memoryMapReturnTo('https://example.invalid/profile/knowledge?view=connections'),
    ).toBeNull();
    expect(memoryPersonConnectionHref(contactId, relationId, 'https://example.invalid/')).toBe(
      `/people/${contactId}?connectionId=${relationId}#person-connection-${relationId}`,
    );
  });
});

describe('peer profile navigation context', () => {
  it.each([
    '//evil.invalid/profile/knowledge?view=map',
    '/people/123?returnTo=/profile/knowledge?view=map',
    '/profile/knowledge?view=library',
    '/profile/knowledge/../people?view=map',
    'javascript:alert(1)',
  ])('rejects unsupported return context %s', (returnTo) => {
    const href = memoryPersonConnectionHref(contactId, relationId, returnTo, 'Alex');
    expect(href).toBe(
      `/people/${contactId}?q=Alex&connectionId=${relationId}#person-connection-${relationId}`,
    );
  });

  it('round trips a selected claim across both profiles and back to the map', () => {
    const map = '/profile/knowledge?view=map&entity=alex&family=family#knowledge-item';
    const peer = new URL(
      memoryPersonConnectionHref(contactId, relationId, map, 'Alex & Sam') ?? '',
      'https://internal.invalid',
    );
    const back = new URL(
      memoryPersonConnectionHref(
        '11111111-1111-4111-8111-111111111111',
        peer.searchParams.get('connectionId'),
        peer.searchParams.get('returnTo') ?? '',
        peer.searchParams.get('q') ?? '',
      ) ?? '',
      'https://internal.invalid',
    );
    expect(back.searchParams.get('connectionId')).toBe(relationId);
    expect(back.searchParams.get('q')).toBe('Alex & Sam');
    expect(memoryMapReturnTo(back.searchParams.get('returnTo'))).toBe(map);
    expect(back.hash).toBe(`#person-connection-${relationId}`);
  });
});
