import {
  type OwnerSkillInput,
  type SkillLibraryRepository,
  type SkillMutationRepository,
  skillEmbeddingText,
} from '@assistant/persistence';

/** Matches the learned-skill item returned by the mobile workspace API. */
export type MobileWorkspaceSkill = {
  id: string;
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
  ownerAuthored: boolean;
  deprecated: boolean;
  useCount: number;
  successCount: number;
  failureCount: number;
  updatedAt: string;
};

export async function listMobileWorkspaceSkills(
  repository: SkillLibraryRepository,
  agentId: string,
): Promise<MobileWorkspaceSkill[]> {
  const skills = await repository.list(agentId);
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    preconditions: skill.preconditions,
    steps: skill.steps,
    gotchas: skill.gotchas,
    ownerAuthored: skill.ownerAuthored,
    deprecated: skill.deprecated,
    useCount: skill.useCount,
    successCount: skill.successCount,
    failureCount: skill.failureCount,
    updatedAt: skill.updatedAt.toISOString(),
  }));
}

export function setMobileSkillDeprecated(
  repository: SkillMutationRepository,
  agentId: string,
  skillId: string,
  deprecated: boolean,
): Promise<void> {
  return repository.setDeprecated(agentId, skillId, deprecated);
}

export function deleteMobileSkill(
  repository: SkillMutationRepository,
  agentId: string,
  skillId: string,
): Promise<void> {
  return repository.delete(agentId, skillId);
}

/** Re-embed canonical procedure text before each owner-authored write. */
export async function writeMobileSkill(
  repository: SkillMutationRepository,
  embed: (text: string) => Promise<number[]>,
  agentId: string,
  input: OwnerSkillInput,
  skillId?: string,
): Promise<void> {
  const normalized = {
    name: input.name.trim().slice(0, 200),
    steps: input.steps.trim(),
    preconditions: input.preconditions.trim(),
    gotchas: input.gotchas.trim(),
  };
  if (!normalized.name || !normalized.steps) throw new Error('Name and steps are required.');
  if (skillId) await repository.assertOwnerCanEdit(agentId, skillId);
  else await repository.assertOwnerWritable(agentId);
  const vector = await embed(skillEmbeddingText(normalized));
  if (skillId) await repository.editOwner(agentId, skillId, normalized, vector);
  else await repository.saveOwner(agentId, normalized, vector);
}
