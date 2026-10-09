/** A finished task the nightly reflection may distil into a skill. */
export interface ReflectionTask {
  id: string;
  agentId: string;
  trust: string;
  trigger: unknown;
  state: unknown;
  plan: unknown;
  progress: string | null;
}

/** One recorded step of a reflected task, in step order. */
export interface ReflectionToolCall {
  toolName: string;
  status: string;
  error: string | null;
  args: unknown;
}

/** A skill drafted by reflection, before it is embedded. */
export interface ReflectedSkill {
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
  sourceTaskId: string;
  originTrust: 'owner' | 'assistant';
}

export interface SkillReflectionCommit {
  agentId: string;
  taskId: string;
  /** Opaque owner-library generation captured before model/embedding work. */
  expectedLibraryRevision: string;
  /** Omit when the model concluded that this task did not teach a reusable skill. */
  skill?: ReflectedSkill;
  embedding?: number[];
  embeddingSpaceKey?: string;
}

export type SkillReflectionCommitResult =
  | { status: 'created'; skillId: string }
  | { status: 'revised'; skillId: string }
  | { status: 'no_skill' }
  | { status: 'superseded' }
  | { status: 'owner_authored' }
  | { status: 'capacity' }
  | { status: 'already_processed' }
  | { status: 'ineligible' };

/** The `skill.reflect` job's reads and its one write. Drafting stays in core. */
export interface SkillReflectionRepository {
  readonly kind: 'skill-reflection-repository';
  /** Done owner- or assistant-trust tasks created since `since`, newest first. */
  candidates(since: Date, limit: number): Promise<ReflectionTask[]>;
  /** The subset of `taskIds` that already taught a skill. */
  sourcedTaskIds(taskIds: string[]): Promise<string[]>;
  /** Opaque per-owner revision token, captured before model and embedding work. */
  libraryRevision(agentId: string): Promise<string>;
  toolCalls(taskId: string): Promise<ReflectionToolCall[]>;
  /**
   * Atomically verifies the task and owner-library revision, writes any skill,
   * and checkpoints the task receipt without changing original skill provenance.
   */
  commitReflection(input: SkillReflectionCommit): Promise<SkillReflectionCommitResult>;
}
