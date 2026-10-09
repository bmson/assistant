/** Owner-scoped writes and lifecycle mutations of learned skills. */
export interface OwnerSkillInput {
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
}

export interface SkillMutationRepository {
  readonly kind: 'skill-mutation-repository';
  assertOwnerWritable(agentId: string): Promise<void>;
  assertOwnerCanEdit(agentId: string, skillId: string): Promise<void>;
  saveOwner(agentId: string, input: OwnerSkillInput, embedding: number[]): Promise<void>;
  editOwner(
    agentId: string,
    skillId: string,
    input: OwnerSkillInput,
    embedding: number[],
  ): Promise<void>;
  setDeprecated(agentId: string, skillId: string, deprecated: boolean): Promise<void>;
  delete(agentId: string, skillId: string): Promise<void>;
}
