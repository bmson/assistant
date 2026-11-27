import { z } from 'zod';

export const savedPlaceCategories = ['school', 'work', 'venue'] as const;

export const savedPlaceDetails = z
  .object({
    category: z.enum(savedPlaceCategories),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    address: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  })
  .strict();

export const savedPlaceRecord = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    revision: z.string().uuid(),
    details: savedPlaceDetails.nullable(),
  })
  .strict();

export type SavedPlaceDetails = z.infer<typeof savedPlaceDetails>;
export type SavedPlaceRecord = z.infer<typeof savedPlaceRecord>;
export type ActiveSavedPlace = Omit<SavedPlaceRecord, 'agentId' | 'details'> & {
  details: SavedPlaceDetails;
};

export interface SavedPlacesSnapshot {
  generation: string | null;
  places: ActiveSavedPlace[];
}

export interface SavedPlaceWrite {
  id: string;
  expectedRevision: string | null;
  revision: string;
  details: SavedPlaceDetails | null;
  generation: string | null;
}

/** Null details retain only the record identity needed to reject stale replay after removal. */
export interface SavedPlacesRepository {
  list(agentId: string): Promise<SavedPlacesSnapshot>;
  change(agentId: string, input: SavedPlaceWrite): Promise<boolean>;
  read(agentId: string, id: string, generation: string | null): Promise<SavedPlaceRecord | null>;
}
