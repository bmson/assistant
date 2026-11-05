import {
  createOwnerMemoryWriteWitness,
  type OwnerMemoryWriteWitness,
} from '@assistant/persistence';

/**
 * Starts a generic Firestore memory write from its existing content hash.
 * Missing or malformed hashes remain unknown; this helper never derives one.
 */
export function createFirestoreGenericMemoryWriteWitness(
  contentHash: unknown,
): OwnerMemoryWriteWitness | null {
  if (typeof contentHash !== 'string') return null;

  try {
    return createOwnerMemoryWriteWitness({ contentHash });
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === 'Invalid owner-memory write witness contentHash'
    )
      return null;
    throw error;
  }
}
