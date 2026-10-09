import type { Records } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { matchSubjectContact } from './contact-lookup.js';

const contact = (id: string, name: string, trust = 'known', aliases: string[] = []) =>
  ({ id, name, trust, aliases }) as Records['contacts'];
describe('source subject identity', () => {
  it('checks exact names before owner or other prefix matches', () => {
    const rows = [
      contact('owner', 'Mira Jones', 'owner'),
      contact('short', 'Mira'),
      contact('other', 'Mira Smith'),
    ];
    expect(matchSubjectContact(rows, 'Mira')).toEqual({ contactId: 'short' });
    expect(matchSubjectContact(rows, 'owner')).toEqual({ contactId: 'owner' });
  });
  it('does not pick an incidental first row for ambiguous prefixes or aliases', () => {
    expect(
      matchSubjectContact([contact('one', 'Alex Jones'), contact('two', 'Alex Smith')], 'Alex'),
    ).toBeNull();
    expect(
      matchSubjectContact(
        [
          contact('one', 'A', ['known'].join(''), ['shared']),
          contact('two', 'B', 'known', ['shared']),
        ],
        'shared',
      ),
    ).toBeNull();
  });
});
