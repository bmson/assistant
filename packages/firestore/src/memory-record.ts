import type { Records } from '@assistant/persistence';
import { decodeRecord } from './store.js';

const SPACE_KEY = /^[a-f0-9]{64}$/;

/**
 * Decode a Firestore memory projection into the shared persistence shape.
 * Firestore stores the durable vector identity as `embeddingSpace`; PostgreSQL
 * calls the same value `embeddingSpaceKey`.
 */
export function decodeMemoryRecord(value: unknown): Records['memories'] {
  const decoded = decodeRecord<unknown>(value);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new Error('Malformed memory record');
  const row = decoded as Record<string, unknown>;
  const explicit = row.embeddingSpaceKey;
  const alias = row.embeddingSpace;
  const explicitValid = typeof explicit === 'string' && SPACE_KEY.test(explicit);
  const aliasValid = typeof alias === 'string' && SPACE_KEY.test(alias);
  const explicitPresent = explicit !== undefined && explicit !== null;
  const aliasPresent = alias !== undefined && alias !== null;
  const agrees = !explicitValid || !aliasValid || explicit === alias;
  const identityIsValid =
    (!explicitPresent || explicitValid) && (!aliasPresent || aliasValid) && agrees;
  if (!identityIsValid)
    throw new Error('Memory embedding space identity is malformed or inconsistent');
  const { embeddingSpace: _legacyAlias, ...record } = row;

  return {
    ...record,
    embeddingSpaceKey: explicitValid ? explicit : aliasValid ? alias : null,
  } as Records['memories'];
}
