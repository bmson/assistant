import type {
  ProfileContactSnapshot,
  ProfileOverviewRepository,
  ProfilePeopleReadRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { getPersonProfile, getProfileOverview } from './queries.js';

describe('getProfileOverview', () => {
  it('uses a portable read and selects compiled-card fact IDs', async () => {
    const now = new Date('2026-09-22T12:00:00Z');
    const fact = (id: string, pinned: boolean, importance: number) => ({
      id,
      content: id,
      kind: 'fact',
      domain: 'work',
      confidence: '1.00',
      importance,
      ownerConfirmed: false,
      pinned,
      lastConsolidatedAt: null,
      originTrust: 'owner',
      sourceTaskId: null,
      createdAt: now,
      validFrom: null,
      validUntil: null,
    });
    const repository: ProfileOverviewRepository = {
      kind: 'profile-overview-repository',
      async load() {
        return {
          people: [],
          ownerFacts: [fact('pinned', true, 1), fact('important', false, 5)],
          quarantined: [],
          card: null,
          voiceStats: { total: 0, auto: 0, uploaded: 0 },
          voiceProfile: { description: '', dos: [], donts: [], signature: '' },
          voiceImports: [],
          memoryHealth: {
            totalUsable: 2,
            notYetOrganized: 2,
            awaitingReview: 0,
            ownerConfirmed: 0,
            lastOrganizedAt: null,
          },
          latestOrganizer: null,
        };
      },
    };
    const result = await getProfileOverview(repository);
    expect(result.cardFactIds).toEqual(['pinned', 'important']);
    expect(result.ownerFacts).toHaveLength(2);
  });
});

describe('getPersonProfile browse-only composition', () => {
  function fixture() {
    const target = {
      id: 'target',
      name: 'Annie',
      aliases: [],
      emails: [],
      phones: [],
      trust: 'known',
      relationship: 'friend',
      identityRevision: 'a'.repeat(64),
      identityAuthority: null,
      notes: '',
      createdAt: new Date('2026-10-26T12:00:00Z'),
      updatedAt: new Date('2026-10-26T12:00:00Z'),
    } satisfies ProfileContactSnapshot;
    const first = { ...target, id: 'first', name: 'Anna', aliases: ['Annie'] };
    const listContacts = vi.fn(async () => [first, target]);
    const getFacts = vi.fn(async () => ({ rows: [], total: 17 }));
    const listOccasions = vi.fn(async () => []);
    const repository: ProfilePeopleReadRepository = {
      kind: 'profile-people-read-repository',
      getContact: async () => target,
      getOwnerContact: async () => null,
      getOwnerCard: async () => null,
      listContacts,
      getFacts,
      listOccasions,
    };
    return { repository, listContacts, getFacts, listOccasions };
  }

  it('does not read the full contact directory when editing suggestions are disabled', async () => {
    const f = fixture();
    f.listContacts.mockRejectedValue(new Error('editor-only directory must not be read'));
    const result = await getPersonProfile(f.repository, 'target', 250, {
      includeEditingSuggestions: false,
    });
    expect(f.listContacts).not.toHaveBeenCalled();
    expect(f.getFacts).toHaveBeenCalledExactlyOnceWith('target', 250);
    expect(f.listOccasions).toHaveBeenCalledExactlyOnceWith('target');
    expect(result).toMatchObject({ contact: { id: 'target' }, totalFacts: 17, mergeOptions: [] });
    expect(result?.contact.identityRevision).toBe('a'.repeat(64));
    expect(result?.duplicate).toBeUndefined();
  });

  it.each([undefined, true])(
    'retains default/editor directory, merge and duplicate behavior (%s)',
    async (includeEditingSuggestions) => {
      const f = fixture();
      const result =
        includeEditingSuggestions === undefined
          ? await getPersonProfile(f.repository, 'target')
          : await getPersonProfile(f.repository, 'target', 250, { includeEditingSuggestions });
      expect(f.listContacts).toHaveBeenCalledTimes(1);
      expect(f.getFacts).toHaveBeenCalledExactlyOnceWith('target', 250);
      expect(f.listOccasions).toHaveBeenCalledExactlyOnceWith('target');
      expect(result?.mergeOptions).toEqual([{ id: 'first', label: 'Anna (friend)' }]);
      expect(result?.duplicate).toEqual({ targetId: 'first', reason: 'matching name or alias' });
    },
  );
});
