export type MemoryProminence = 'always' | 'auto' | 'minor';
export type MemoryForgetReason = 'owner_forget' | 'quarantine_reject' | 'owner_delete_contact';

export interface ManagedMemory {
  id: string;
  agentId: string;
  contentHash: string;
}

export type MemoryMutation =
  | { status: 'updated'; memory: ManagedMemory }
  | { status: 'duplicate'; memory?: ManagedMemory }
  | { status: 'not-found' | 'stale' | 'tombstoned' };

/**
 * Installation-scoped owner mutations for durable profile facts.
 *
 * `correct` uses `expectedContentHash` as its compare-and-swap token. A new
 * hash that is already live returns `duplicate`; one that has been forgotten
 * returns `tombstoned`. A duplicate create includes `memory` when that existing
 * fact belongs to the configured agent, allowing a failed card rebuild to be
 * retried safely. Implementations invalidate the compiled owner card in the
 * same transaction as every successful mutation.
 */
export interface ProfileMemoryManagementRepository {
  readonly kind: 'profile-memory-management-repository';
  get(memoryId: string): Promise<ManagedMemory | null>;
  confirm(memoryId: string): Promise<MemoryMutation>;
  restore(memoryId: string): Promise<MemoryMutation>;
  correct(input: {
    memoryId: string;
    expectedContentHash: string;
    content: string;
    contentHash: string;
    embedding: number[];
    embeddingSpaceKey?: string;
  }): Promise<MemoryMutation>;
  forget(memoryId: string, reason: MemoryForgetReason): Promise<MemoryMutation>;
  setProminence(memoryId: string, level: MemoryProminence): Promise<MemoryMutation>;
  approveQuarantined(memoryId: string): Promise<MemoryMutation>;
  create(input: {
    content: string;
    contentHash: string;
    embedding: number[];
    embeddingSpaceKey?: string;
    importance: number;
    pinned: boolean;
    subjectContactId: string;
    domain?: string;
  }): Promise<MemoryMutation>;
}

export function isProfileMemoryManagementRepository(
  value: unknown,
): value is ProfileMemoryManagementRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'profile-memory-management-repository'
  );
}
