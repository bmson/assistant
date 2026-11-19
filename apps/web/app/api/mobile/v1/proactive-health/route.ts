import { getMobileNoticingHealth } from '@/lib/server';
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
  const { ownerId } = owner;
  try {
    return mobileJson(await getMobileNoticingHealth(ownerId));
  } catch {
    return mobileJson({ error: 'Noticing status unavailable' }, { status: 503 });
  }
}
