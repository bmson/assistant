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
