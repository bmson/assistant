import { isDeepStrictEqual } from 'node:util';
import {
  type SavedPlacesRepository,
  type SavedPlacesSnapshot,
  savedPlaceDetails,
} from '@assistant/persistence';
import { z } from 'zod';

const savedPlaceWrite = z
  .object({
    id: z.string().uuid(),
    revision: z.string().uuid(),
    expectedRevision: z.string().uuid().nullable(),
    generation: z.string().max(100).nullable(),
    details: savedPlaceDetails.nullable(),
  })
  .strict()
  .refine(
    (input) =>
      input.revision !== input.expectedRevision &&
      (input.details !== null || input.expectedRevision !== null),
  );

export async function updateSavedPlace(
  repo: SavedPlacesRepository,
  agentId: string,
  value: unknown,
): Promise<{ snapshot: SavedPlacesSnapshot } | { error: string }> {
  const parsed = savedPlaceWrite.safeParse(value);
  if (!parsed.success)
    return { error: 'Enter a name and full address, then review the place again.' };
  const input = parsed.data;
  await repo.change(agentId, input);
  // Also confirms a retried request whose first commit reached the store.
  const saved = await repo.read(agentId, input.id, input.generation);
  if (saved?.revision !== input.revision || !isDeepStrictEqual(saved.details, input.details))
    return { error: 'Saved places changed. Reopen Settings and review the current entry.' };
  const snapshot = await repo.list(agentId);
  const visible = snapshot.places.some(
    ({ id, revision }) => id === input.id && revision === input.revision,
  );
  if (snapshot.generation !== input.generation || visible !== (input.details !== null))
    return { error: 'Saved places changed. Reopen Settings and review the current entry.' };
  return { snapshot };
}
