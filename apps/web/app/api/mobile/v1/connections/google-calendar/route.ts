import { getGoogleCalendarConnectionService } from '@/lib/google-calendar-connection-runtime';
import { authenticateMobileOwner, mobileJson, mobileUnauthorized } from '@/mobile-auth';
export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  try {
    return mobileJson(await getGoogleCalendarConnectionService().status(owner.ownerId));
  } catch {
    return mobileJson({ error: 'Calendar connection unavailable' }, { status: 503 });
  }
}
export async function DELETE(request: Request): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  try {
    return mobileJson(await getGoogleCalendarConnectionService().disconnect(owner.ownerId));
  } catch {
    return mobileJson({ error: 'Calendar disconnect could not be confirmed' }, { status: 503 });
  }
}
