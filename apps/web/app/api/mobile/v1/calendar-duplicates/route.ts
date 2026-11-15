import {
  assessCalendarDuplicates,
  calendarDuplicateRequest,
} from '@assistant/application/calendar-duplicates';
import { getCalendarDuplicateRouter } from '@/lib/server';
import { authenticateMobileOwner, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 24_000)
      return mobileJson({ error: 'Request too large' }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return mobileJson({ error: 'Invalid request' }, { status: 400 });
  }
  const parsed = calendarDuplicateRequest.safeParse(body);
  if (!parsed.success) return mobileJson({ error: 'Invalid calendar entries' }, { status: 400 });
  try {
    const result = await assessCalendarDuplicates({
      ownerId: owner.ownerId,
      events: parsed.data.events,
      router: getCalendarDuplicateRouter(),
    });
    return mobileJson(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return mobileJson(
      { error: 'Calendar comparison unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
