import type { Records } from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { matchSubjectContact, stageNewContact } from './contact-lookup.js';
import type { InstallationStore } from './store.js';

const contact = (id: string, name: string, trust = 'known', aliases: string[] = []) =>
  ({ id, name, trust, aliases }) as Records['contacts'];
describe('source subject identity', () => {
  it('labels only a newly staged inference contact without promoting its trust', () => {
    const create = vi.fn();
    const tx = { create } as unknown as Transaction;
    const store = {
      doc: (collection: string, id: string) => `${collection}/${id}`,
    } as unknown as InstallationStore;
    const now = new Date('2026-10-26T12:00:00Z');
    expect(stageNewContact(tx, store, { id: 'new', name: '  Rae  ', now })).toBe('new');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual([
      'contacts/new',
      expect.objectContaining({
        id: 'new',
        name: 'Rae',
        trust: 'unknown',
        identityAuthority: 'inferred',
        aliases: [],
      }),
    ]);
  });

  it('matches protected imported, legacy and owner names without enriching their identity', () => {
    for (const row of [
      { ...contact('imported', 'Rae'), identityAuthority: null },
      contact('legacy', 'Rae'),
      { ...contact('reviewed', 'Rae'), identityAuthority: 'owner' as const },
      { ...contact('owner', 'Rae', 'owner'), identityAuthority: 'owner' as const },
    ]) {
      const before = structuredClone(row);
      expect(matchSubjectContact([row], 'Rae Extended')).toEqual({ contactId: row.id });
      expect(row).toEqual(before);
    }
  });

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
