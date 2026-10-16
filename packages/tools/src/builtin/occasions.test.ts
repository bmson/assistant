import type { OccasionToolRow } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerPortableBirthdayOccasionTool } from './occasions.js';

const base: OccasionToolRow = {
  id: 'occasion-a',
  contactId: 'contact-a',
  contactName: 'Alex',
  kind: 'birthday',
  label: '',
  month: 3,
  day: 4,
  year: null,
  recurrence: 'annual',
  leadDays: 7,
  notes: 'private gift note',
  originTrust: 'owner',
  quarantined: false,
  ownerConfirmed: true,
};

describe('occasions.list_birthdays', () => {
  it('returns only confirmed annual birthdays for the exact supplied identities', async () => {
    const listBirthdays = vi.fn(async () => ({
      rows: [
        base,
        { ...base, id: 'anniversary', kind: 'anniversary' },
        { ...base, id: 'once', recurrence: 'once' },
        { ...base, id: 'unconfirmed', ownerConfirmed: false },
        { ...base, id: 'quarantined', quarantined: true },
        { ...base, id: 'invalid-date', month: 2, day: 30 },
      ],
      overflow: false,
    }));
    const registry = registerPortableBirthdayOccasionTool(new ToolRegistry(), { listBirthdays });
    const tool = registry.get('occasions.list_birthdays')?.tool;
    expect(registry.get('occasions.list_birthdays')?.flags.confidentialRead).toBe(true);
    const result = await tool?.execute({ contactIds: ['contact-a'] }, {
      agentId: 'owner-a',
    } as ToolContext);
    expect(listBirthdays).toHaveBeenCalledWith({
      agentId: 'owner-a',
      contactIds: ['contact-a'],
      limit: 40,
    });
    expect(result).toEqual({
      birthdays: [
        {
          id: 'occasion-a',
          contactId: 'contact-a',
          person: 'Alex',
          kind: 'birthday',
          month: 3,
          day: 4,
          year: null,
          recurrence: 'annual',
          originTrust: 'owner',
          ownerConfirmed: true,
          quarantined: false,
        },
      ],
      complete: true,
    });
    expect(JSON.stringify(result)).not.toContain('private gift note');
  });

  it('marks malformed duplicate identity requests incomplete', async () => {
    const registry = registerPortableBirthdayOccasionTool(new ToolRegistry(), {
      listBirthdays: async () => ({ rows: [base], overflow: false }),
    });
    const result = await registry
      .get('occasions.list_birthdays')
      ?.tool.execute({ contactIds: ['contact-a', 'contact-a'] }, {
        agentId: 'owner-a',
      } as ToolContext);
    expect(result).toEqual({ birthdays: [], complete: false });
  });

  it('marks a truncated birthday set incomplete instead of claiming full coverage', async () => {
    const registry = registerPortableBirthdayOccasionTool(new ToolRegistry(), {
      listBirthdays: async () => ({
        rows: Array.from({ length: 40 }, (_, index) => ({ ...base, id: `occasion-${index}` })),
        overflow: true,
      }),
    });
    const result = await registry
      .get('occasions.list_birthdays')
      ?.tool.execute({ contactIds: ['contact-a'] }, { agentId: 'owner-a' } as ToolContext);
    expect(result).toMatchObject({ complete: false, truncated: true });
    expect(result).toHaveProperty('birthdays.length', 40);
  });

  it('returns an empty complete result without repository I/O for no grounded contact IDs', async () => {
    const listBirthdays = vi.fn();
    const registry = registerPortableBirthdayOccasionTool(new ToolRegistry(), { listBirthdays });
    const result = await registry
      .get('occasions.list_birthdays')
      ?.tool.execute({ contactIds: [] }, { agentId: 'owner-a' } as ToolContext);
    expect(result).toEqual({ birthdays: [], complete: true });
    expect(listBirthdays).not.toHaveBeenCalled();
  });
});
