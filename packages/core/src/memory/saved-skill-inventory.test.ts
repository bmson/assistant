import { describe, expect, it } from 'vitest';
import {
  renderRelevantSavedSkills,
  requestedSavedSkillInventory,
  savedSkillInventoryIntent,
} from './saved-skill-inventory.js';

describe('saved skill inventory', () => {
  it('recognizes inventory questions without turning named skill use into an inventory read', () => {
    expect(
      requestedSavedSkillInventory('What saved skills do I have that could help plan a busy day?'),
    ).toBe(true);
    expect(requestedSavedSkillInventory('List my learned skills.')).toBe(true);
    expect(requestedSavedSkillInventory('List my saved skills; do not apply them.')).toBe(true);
    expect(requestedSavedSkillInventory('List my saved skills and apply the matching one.')).toBe(
      false,
    );
    expect(
      requestedSavedSkillInventory(
        'List my saved skills and can you apply the planning skill to tomorrow?',
      ),
    ).toBe(false);
    expect(
      requestedSavedSkillInventory('List my saved skills, then delete the obsolete one.'),
    ).toBe(false);
    expect(requestedSavedSkillInventory('Apply my saved skill named "Calendar review".')).toBe(
      false,
    );
  });

  it('shows all active skills for an unqualified inventory question', () => {
    const result = renderRelevantSavedSkills([
      {
        id: 'skill-1',
        name: 'Daily planning',
        preconditions: 'When there are several tasks and appointments.',
        steps: 'Review every item, then rank the tasks in order.',
        gotchas: '',
        ownerAuthored: true,
        deprecated: false,
        useCount: 3,
        successCount: 2,
        failureCount: 0,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      {
        id: 'skill-2',
        name: 'Old schedule helper',
        preconditions: 'Calendar schedule review.',
        steps: 'Review calendar.',
        gotchas: '',
        ownerAuthored: false,
        deprecated: true,
        useCount: 9,
        successCount: 3,
        failureCount: 0,
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
      },
      {
        id: 'skill-3',
        name: 'Recipe conversion',
        preconditions: 'When adapting a recipe.',
        steps: 'Convert the quantities.',
        gotchas: '',
        ownerAuthored: false,
        deprecated: false,
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        updatedAt: new Date('2026-10-03T00:00:00.000Z'),
      },
    ]);
    expect(result).toContain('Daily planning');
    expect(result).toContain('Recipe conversion');
    expect(result).toContain('When there are several tasks and appointments.');
    expect(result).toContain('planning, task management');
    expect(result).toContain('Saved by you');
    expect(result).toContain('Learned from use');
    expect(result).not.toContain('Review every item');
    expect(result).not.toContain('Old schedule helper');
  });

  it('distinguishes an empty full inventory from an empty relevance search', () => {
    expect(renderRelevantSavedSkills([])).toBe('There are no active saved skills in the library.');
  });

  it('filters by the explicitly requested scope without hiding general skills in an unqualified list', () => {
    const intent = savedSkillInventoryIntent(
      'What saved skills do I have that could help plan a busy day?',
    );
    expect(intent?.kind).toBe('relevant');
    if (intent?.kind !== 'relevant') throw new Error('Expected a relevant-scope intent');
    const result = renderRelevantSavedSkills(
      [
        {
          id: 'planning',
          name: 'Daily planning',
          preconditions: 'When there are several tasks and appointments.',
          steps: 'Review every item, then rank the tasks in order.',
          gotchas: '',
          ownerAuthored: true,
          deprecated: false,
          useCount: 3,
          successCount: 2,
          failureCount: 0,
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          id: 'recipe',
          name: 'Recipe conversion',
          preconditions: 'When adapting a recipe.',
          steps: 'Convert the quantities.',
          gotchas: '',
          ownerAuthored: false,
          deprecated: false,
          useCount: 0,
          successCount: 0,
          failureCount: 0,
          updatedAt: new Date('2026-10-03T00:00:00.000Z'),
        },
      ],
      intent,
    );
    expect(result).toContain('Daily planning');
    expect(result).not.toContain('Recipe conversion');
  });

  it('reports no relevant active result honestly', () => {
    expect(
      renderRelevantSavedSkills(
        [
          {
            id: 'skill-1',
            name: 'Recipe conversion',
            preconditions: 'When adapting a recipe.',
            steps: 'Convert the quantities.',
            gotchas: '',
            ownerAuthored: false,
            deprecated: false,
            useCount: 0,
            successCount: 0,
            failureCount: 0,
            updatedAt: new Date('2026-10-01T00:00:00.000Z'),
          },
        ],
        {
          kind: 'relevant',
          scope: 'filing taxes',
          labels: [],
          terms: ['filing', 'taxes'],
        },
      ),
    ).toContain('I could not find an active saved skill');
  });
});
