'use server';

import { dismissSavedCard, requestSavedCardRefresh } from '@assistant/application/cards';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getAgentIdentity, getCardRefresh, getGeneratedCards } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function dismissCard(formData: FormData): Promise<void> {
  await requireOwner();
  const cardId = String(formData.get('cardId') ?? '');
  const agent = await getAgentIdentity();
  if (!agent.id || !cardId) return;
  await dismissSavedCard(getGeneratedCards(), agent.id, cardId);
  revalidatePath('/cards');
}

/** Refresh a saved object; the task updates its existing card after fresh source reads. */
export async function refreshSavedCardInline(
  cardId: string,
  expectedRevisionId: string,
  operationId: string,
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  await requireOwner();
  const agent = await getAgentIdentity();
  if (
    !agent.id ||
    typeof cardId !== 'string' ||
    !UUID_RE.test(cardId) ||
    typeof expectedRevisionId !== 'string' ||
    !UUID_RE.test(expectedRevisionId) ||
    typeof operationId !== 'string' ||
    !UUID_RE.test(operationId)
  ) {
    return { ok: false, error: 'This saved card is unavailable.' };
  }
  const result = await requestSavedCardRefresh(
    getCardRefresh(),
    agent.id,
    cardId,
    undefined,
    operationId,
    expectedRevisionId,
  );
  revalidatePath('/cards');
  revalidatePath('/chat', 'layout');
  return result.ok ? { ok: true, taskId: result.taskId } : { ok: false, error: result.error };
}
