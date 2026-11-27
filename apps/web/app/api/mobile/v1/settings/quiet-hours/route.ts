import { parseQuietHoursWindow } from '@assistant/application/settings';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { mobileQuietHours } from '@/lib/server';
import {
  authenticateMobileBearer,
  mobileJson,
  mobileUnauthorized,
  resolveMobileOwner,
} from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const principal = await authenticateMobileBearer(request);
  if (!principal) return mobileUnauthorized();
  const owner = await resolveMobileOwner(principal);
  if (!owner.ok) return mobileJson({ error: 'Owner unavailable' }, { status: 503 });
  try {
    return mobileJson(await mobileQuietHours(owner.ownerId));
  } catch {
    return mobileJson({ error: 'Quiet hours unavailable' }, { status: 503 });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const principal = await authenticateMobileBearer(request);
  if (!principal) return mobileUnauthorized();
  const body = await readMobileMutationBody(request, ['quietStartMin', 'quietEndMin']);
  if (!body.ok) return body.response;
  const window = parseQuietHoursWindow(body.value);
  if (!window)
    return mobileJson(
      { error: 'Choose two different times or turn quiet hours off.' },
      { status: 400 },
    );
  const owner = await resolveMobileOwner(principal);
  if (!owner.ok) return mobileJson({ error: 'Owner unavailable' }, { status: 503 });
  try {
    return mobileJson(await mobileQuietHours(owner.ownerId, window));
  } catch {
    return mobileJson({ error: 'Quiet hours save could not be confirmed' }, { status: 503 });
  }
}
