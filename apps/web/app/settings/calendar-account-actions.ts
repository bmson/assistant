'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getCalendarAccountPorts } from '@/lib/server';

export async function disconnectCalendarAccount(form: FormData): Promise<void> {
  await requireOwner();
  const id = form.get('id');
  if (typeof id !== 'string' || !id || id.length > 255) throw new Error('Invalid calendar account');
  await getCalendarAccountPorts().accounts.remove(id);
  revalidatePath('/settings');
}
