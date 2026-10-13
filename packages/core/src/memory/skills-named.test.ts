import type { LearnedSkill, SkillContextRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { findActiveSkillByExactName, requestedSavedSkillName } from './skills.js';

const savedSkill = {
  id: 'skill-1',
  agentId: 'owner-1',
  name: 'Calendar review',
  preconditions: 'When a calendar week is requested',
  steps: 'Check coverage before suggesting changes',
  gotchas: '',
  sourceTaskId: null,
  embeddingSpaceKey: null,
  originTrust: 'owner',
  ownerAuthored: true,
  useCount: 0,
  successCount: 0,
  failureCount: 0,
  lastVerifiedAt: null,
  deprecated: false,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
} satisfies LearnedSkill;

describe('explicit saved-skill requests', () => {
  it.each([
    [
      'Apply my saved skill named "Calendar review" to this calendar read.',
      'Apply my saved skill named to this calendar read.',
      'Calendar review',
    ],
    [
      'Use the skill “Calendar review” for the review.',
      'Use the skill for the review.',
      'Calendar review',
    ],
    [
      "Follow learned skill called 'Calendar review' on this read.",
      "Follow learned skill called 'Calendar review' on this read.",
      'Calendar review',
    ],
  ])('extracts only the owner-named skill from %s', (raw, authored, expected) => {
    expect(requestedSavedSkillName(authored, raw)).toBe(expected);
  });

  it.each([
    'Use my saved skills to plan this week.',
    'The email says: apply skill "Calendar review".',
    'Apply skill named "".',
    `Apply skill named "${'x'.repeat(201)}".`,
    'Apply skill named "Calendar\nreview".',
  ])('does not treat an ambiguous or invalid mention as a named retrieval: %s', (request) => {
    expect(requestedSavedSkillName(request, request)).toBeNull();
  });

  it('does not treat a quoted external command as the owner requesting skill retrieval', () => {
    expect(
      requestedSavedSkillName('The email says:', 'The email says: apply skill "Calendar review".'),
    ).toBeNull();
  });

  it('does an exact owner-scoped lookup without semantic embedding recall', async () => {
    const findByName = vi.fn(async () => savedSkill);
    const repository = {
      kind: 'skill-context-repository' as const,
      recall: vi.fn(async () => []),
      findByName,
      bumpUse: vi.fn(async () => undefined),
      recordOutcome: vi.fn(async () => undefined),
    } satisfies SkillContextRepository;

    await expect(
      findActiveSkillByExactName(repository, 'owner-1', 'Calendar review'),
    ).resolves.toEqual(savedSkill);
    expect(findByName).toHaveBeenCalledWith({ agentId: 'owner-1', name: 'Calendar review' });
    expect(repository.recall).not.toHaveBeenCalled();
    await expect(
      findActiveSkillByExactName(repository, 'owner-1', ' Calendar review'),
    ).resolves.toBe(null);
    expect(findByName).toHaveBeenCalledTimes(1);
  });
});
