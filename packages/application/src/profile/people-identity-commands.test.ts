import type { Db } from '@assistant/db';
import type { ProfilePeopleCommandRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';

const postgres = vi.hoisted(() => ({ updateIdentity: vi.fn(), compileOwnerCard: vi.fn() }));
vi.mock('@assistant/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/db')>()),
  updateContactIdentity: postgres.updateIdentity,
}));
vi.mock('@assistant/core/memory/consolidation', () => ({
  compileOwnerCard: postgres.compileOwnerCard,
}));

import { updatePersonIdentity } from './commands.js';

const contactId = '11111111-1111-4111-8111-111111111111';
const displayedRevision = 'a'.repeat(64);

function fixture(status: 'updated' | 'conflict' | 'review_required' | 'not_found' = 'updated') {
  const updateIdentity = vi.fn(async () =>
    status === 'updated'
      ? { status: 'updated' as const, name: 'Mira Edited', aliases: ['Mira'] }
      : { status },
  );
  const repository: ProfilePeopleCommandRepository = {
    kind: 'profile-people-command-repository',
    create: vi.fn(async () => contactId),
    updateRelationship: vi.fn(async () => {}),
    updateIdentity,
  };
  return { repository, updateIdentity };
}

describe('legacy person identity command review binding', () => {
  it('reports an acknowledged PostgreSQL save when only its derived card refresh fails', async () => {
    postgres.updateIdentity.mockResolvedValueOnce({
      status: 'updated',
      name: 'Mira Edited',
      aliases: ['Mira'],
    });
    postgres.compileOwnerCard.mockRejectedValueOnce(new Error('fixture refresh failure'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {} as Db;
    try {
      expect(
        await updatePersonIdentity(
          db,
          contactId,
          'Mira Edited',
          'Mira',
          displayedRevision,
          'friend',
        ),
      ).toEqual({ refreshPending: true });
      expect(postgres.updateIdentity).toHaveBeenCalledExactlyOnceWith(db, {
        contactId,
        name: 'Mira Edited',
        aliases: ['Mira'],
        expectedContactRevision: displayedRevision,
        relationship: 'friend',
      });
      expect(postgres.compileOwnerCard).toHaveBeenCalledExactlyOnceWith(db);
    } finally {
      log.mockRestore();
    }
  });
  it.each([undefined, '', 'latest', 'A'.repeat(64)])(
    'rejects absent or malformed displayed revision without calling persistence: %s',
    async (revision) => {
      const f = fixture();
      const result = await updatePersonIdentity(
        f.repository,
        contactId,
        'Mira Edited',
        'Mira',
        revision,
      );
      expect(result.code).toBe('review_required');
      expect(result.error).toContain('review');
      expect(f.updateIdentity).not.toHaveBeenCalled();
    },
  );

  it('passes the original displayed revision unchanged to the native mutation', async () => {
    const f = fixture();
    expect(
      await updatePersonIdentity(f.repository, contactId, 'Mira Edited', 'Mira', displayedRevision),
    ).toEqual({});
    expect(f.updateIdentity).toHaveBeenCalledExactlyOnceWith(
      contactId,
      'Mira Edited',
      ['Mira'],
      displayedRevision,
      undefined,
    );
  });

  it('normalizes all compound fields before one revision-bound persistence call', async () => {
    const f = fixture();
    expect(
      await updatePersonIdentity(
        f.repository,
        contactId,
        'Mira Edited',
        'Mira',
        displayedRevision,
        '  friend  ',
      ),
    ).toEqual({});
    expect(f.updateIdentity).toHaveBeenCalledExactlyOnceWith(
      contactId,
      'Mira Edited',
      ['Mira'],
      displayedRevision,
      'friend',
    );
    expect(f.repository.updateRelationship).not.toHaveBeenCalled();
  });

  it.each(['conflict', 'review_required', 'not_found'] as const)(
    'preserves a native %s as an honest non-success without retrying',
    async (status) => {
      const f = fixture(status);
      const result = await updatePersonIdentity(
        f.repository,
        contactId,
        'Mira Edited',
        'Mira',
        displayedRevision,
      );
      expect(result.code).toBe(status);
      expect(result.error).toBeTruthy();
      expect(f.updateIdentity).toHaveBeenCalledTimes(1);
    },
  );
});
