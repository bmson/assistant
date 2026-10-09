'use server';

import { answerCallCheckin, hangUpCall } from '@assistant/application/calls';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getCallsPorts } from '@/lib/server';

export async function answerCheckinAction(input: {
  callId: string;
  checkinId: string;
  revision: number;
  answer: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const result = await answerCallCheckin(await getCallsPorts(), { ...input, via: 'web' });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/calls/${input.callId}`);
  return {};
}

export async function hangUpAction(callId: string): Promise<{ error?: string }> {
  await requireOwner();
  const result = await hangUpCall(await getCallsPorts(), callId);
  if (!result.ok) return { error: result.error };
  revalidatePath(`/calls/${callId}`);
  return {};
}
