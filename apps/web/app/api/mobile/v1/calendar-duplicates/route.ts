import {
  assessCalendarDuplicates,
  calendarDuplicateRequest,
} from '@assistant/application/calendar-duplicates';
import { readBoundedJson } from '@assistant/application/http-body';
import { getCalendarDuplicateRouter } from '@/lib/server';
import { authenticateMobileOwner, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  const body = await readBoundedJson(request, 24_000, 10_000);
  if (!body.ok) return mobileJson({ error: body.error }, { status: body.status });
  const parsed = calendarDuplicateRequest.safeParse(body.value);
  if (!parsed.success) return mobileJson({ error: 'Invalid calendar entries' }, { status: 400 });
  try {
    const result = await assessCalendarDuplicates({
      ownerId: owner.ownerId,
      ...parsed.data,
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
