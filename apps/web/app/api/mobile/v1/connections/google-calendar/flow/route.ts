import { getGoogleCalendarConnectionService } from '@/lib/google-calendar-connection-runtime';
import { authenticateMobileOwner, mobileJson, mobileUnauthorized } from '@/mobile-auth';
export const dynamic = 'force-dynamic';
async function handle(request: Request, cancel: boolean): Promise<Response> {
  const owner = await authenticateMobileOwner(request);
  if (!owner) return mobileUnauthorized();
  const id = new URL(request.url).searchParams.get('flowId');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id))
    return mobileJson({ error: 'A valid flowId is required' }, { status: 400 });
  try {
    const result = await getGoogleCalendarConnectionService().flow(owner.ownerId, id, cancel);
    return result ? mobileJson(result) : mobileJson({ error: 'Flow not found' }, { status: 404 });
  } catch {
    return mobileJson({ error: 'Calendar flow status unavailable' }, { status: 503 });
  }
}
export async function GET(request: Request) {
  return handle(request, false);
}
export async function DELETE(request: Request) {
  return handle(request, true);
}
