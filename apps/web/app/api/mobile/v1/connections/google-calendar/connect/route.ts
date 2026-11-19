import { getGoogleCalendarConnectionService } from '@/lib/google-calendar-connection-runtime';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { authenticateMobileOwner, mobileJson, mobileUnauthorized } from '@/mobile-auth';
export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  const body = await readMobileMutationBody(request, []);
  if (!body.ok) return body.response;
  try {
    return mobileJson(await getGoogleCalendarConnectionService().connect(owner.ownerId));
  } catch {
    return mobileJson(
      { error: 'Calendar connection is not configured or is unavailable' },
      { status: 503 },
    );
  }
}
