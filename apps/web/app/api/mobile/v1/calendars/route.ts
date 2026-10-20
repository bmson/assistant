import { phoneCalendarSnapshotSchema, savePhoneCalendars } from '@assistant/persistence';
import { getPhoneCalendarPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = await request.text();
  if (Buffer.byteLength(body) > 800_000)
    return mobileJson({ error: 'Calendar snapshot too large' }, { status: 413 });
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return mobileJson({ error: 'Invalid calendar snapshot' }, { status: 400 });
  }
  const parsed = phoneCalendarSnapshotSchema.safeParse(input);
  if (!parsed.success) return mobileJson({ error: 'Invalid calendar snapshot' }, { status: 400 });
  const { cache, agentId } = await getPhoneCalendarPorts();
  await savePhoneCalendars(cache, agentId, parsed.data);
  return mobileJson({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { cache, agentId } = await getPhoneCalendarPorts();
  await savePhoneCalendars(cache, agentId, null);
  return mobileJson({ ok: true });
}
