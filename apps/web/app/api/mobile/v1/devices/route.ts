import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { registerOwnerDeviceToken } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The iOS app registering its APNs device token for proactive pushes. Called
 * on every launch (and whenever APNs rotates the token) — idempotent by token.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, ['token', 'platform', 'environment']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value;
  const result = await registerOwnerDeviceToken(body);
  if (!result.ok) return mobileJson({ error: result.error }, { status: result.status });
  return mobileJson({ ok: true });
}
