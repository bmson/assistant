'use server';

import { updateSavedPlace } from '@assistant/application/saved-places';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { savedPlacesSettingsPorts } from '@/lib/server';

export async function savePlace(input: unknown) {
  await requireOwner();
  try {
    const { agentId, repository } = await savedPlacesSettingsPorts();
    const result = await updateSavedPlace(repository, agentId, input);
    if ('snapshot' in result) revalidatePath('/settings');
    return result;
  } catch {
    return {
      error: 'The change could not be confirmed. Reopen Settings to check your saved places.',
    };
  }
}
