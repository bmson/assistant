import type {
  OwnerSkillInput,
  SkillLibraryRepository,
  SkillMutationRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { listMobileWorkspaceSkills, writeMobileSkill } from './workspace-skills.js';

describe('mobile workspace learned-skills projection', () => {
  it('requests the configured owner and returns exactly the mobile contract fields', async () => {
    const list = vi.fn<SkillLibraryRepository['list']>().mockResolvedValue([
      {
        id: 'skill-one',
        name: 'A useful skill',
        preconditions: 'when needed',
        steps: 'do the work',
        gotchas: '',
        ownerAuthored: true,
        deprecated: false,
        useCount: 3,
        successCount: 2,
        failureCount: 1,
        updatedAt: new Date('2026-09-10T12:00:00.000Z'),
      },
    ]);
    const repository: SkillLibraryRepository = {
      kind: 'skill-library-repository',
      list,
    };

    expect(await listMobileWorkspaceSkills(repository, 'owner')).toEqual([
      {
        id: 'skill-one',
        name: 'A useful skill',
        preconditions: 'when needed',
        steps: 'do the work',
        gotchas: '',
        ownerAuthored: true,
        deprecated: false,
        useCount: 3,
        successCount: 2,
        failureCount: 1,
        updatedAt: '2026-09-10T12:00:00.000Z',
      },
    ]);
    expect(list).toHaveBeenCalledExactlyOnceWith('owner');
  });
});

describe('owner mobile skill write preflight', () => {
  const input: OwnerSkillInput = {
    name: 'Trip planning',
    preconditions: 'when a trip is booked',
    steps: 'Compare fares and book the selected flight.',
    gotchas: 'Check baggage fees.',
  };

  it('checks an existing owner target before embedding, then keeps the edit-time recheck', async () => {
    const order: string[] = [];
    const repository: SkillMutationRepository = {
      kind: 'skill-mutation-repository',
      assertOwnerWritable: vi.fn(async () => {
        order.push('owner-writable');
      }),
      assertOwnerCanEdit: vi.fn(async (agentId, skillId) => {
        expect(agentId).toBe('owner');
        expect(skillId).toBe('skill');
        order.push('target-preflight');
      }),
      saveOwner: vi.fn(async () => {
        order.push('save');
      }),
      editOwner: vi.fn(async () => {
        order.push('transactional-edit');
      }),
      setDeprecated: vi.fn(),
      delete: vi.fn(),
    };
    const embed = vi.fn(async () => {
      order.push('embed');
      return [1];
    });

    await writeMobileSkill(repository, embed, 'owner', input, 'skill');

    expect(order).toEqual(['target-preflight', 'embed', 'transactional-edit']);
    expect(repository.assertOwnerCanEdit).toHaveBeenCalledExactlyOnceWith('owner', 'skill');
    expect(repository.editOwner).toHaveBeenCalledExactlyOnceWith('owner', 'skill', input, [1]);
  });

  it('does not embed when target preflight rejects, while new skills still use the owner fence', async () => {
    const repository: SkillMutationRepository = {
      kind: 'skill-mutation-repository',
      assertOwnerWritable: vi.fn(async () => {}),
      assertOwnerCanEdit: vi.fn(async () => {
        throw new Error('Skill not found');
      }),
      saveOwner: vi.fn(async () => {}),
      editOwner: vi.fn(async () => {}),
      setDeprecated: vi.fn(),
      delete: vi.fn(),
    };
    const embed = vi.fn(async () => [1]);

    await expect(
      writeMobileSkill(repository, embed, 'owner', input, 'foreign-or-missing'),
    ).rejects.toThrow('Skill not found');
    expect(embed).not.toHaveBeenCalled();
    expect(repository.editOwner).not.toHaveBeenCalled();

    await writeMobileSkill(repository, embed, 'owner', input);
    expect(repository.assertOwnerWritable).toHaveBeenCalledExactlyOnceWith('owner');
    expect(repository.saveOwner).toHaveBeenCalledExactlyOnceWith('owner', input, [1]);
  });
});
