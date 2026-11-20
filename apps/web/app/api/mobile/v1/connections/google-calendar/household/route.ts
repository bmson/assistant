import {
  HouseholdCalendarConflict,
  householdCalendarPreview,
  householdCalendarSave,
} from '@assistant/application/google-household-calendar';
import { readBoundedJson } from '@assistant/application/http-body';
import { getGoogleHouseholdCalendarService } from '@/lib/google-calendar-connection-runtime';
import { authenticateMobileOwner, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

function unavailable(error: unknown) {
  if (error instanceof HouseholdCalendarConflict)
    return mobileJson({ state: 'changed' }, { status: 409 });
  return mobileJson({ state: 'unavailable' }, { status: 503 });
}

export async function GET(request: Request): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  const query = new URL(request.url).searchParams;
  try {
    const service = getGoogleHouseholdCalendarService();
    if (!query.has('timeMin') && !query.has('timeMax'))
      return mobileJson(await service.setup(owner.ownerId));
    const preview = householdCalendarPreview.safeParse({
      timeMin: query.get('timeMin'),
      timeMax: query.get('timeMax'),
      connectionId: query.get('connectionId'),
      revision: query.get('revision'),
    });
    if (!preview.success) return mobileJson({ error: 'Invalid preview window' }, { status: 400 });
    return mobileJson(await service.preview(owner.ownerId, preview.data));
  } catch (error) {
    return unavailable(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  const body = await readBoundedJson(request);
  if (!body.ok) return mobileJson({ error: body.error }, { status: body.status });
  const input = householdCalendarSave.safeParse(body.value);
  if (!input.success) return mobileJson({ error: 'Invalid classifications' }, { status: 400 });
  try {
    return mobileJson(await getGoogleHouseholdCalendarService().save(owner.ownerId, input.data));
  } catch (error) {
    return unavailable(error);
  }
}
