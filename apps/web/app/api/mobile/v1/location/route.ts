import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { recordOwnerLocation } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The owner's iPhone posting its current whereabouts (and device time zone)
 * for the ambient prompt line. Transient by design: rows age out with
 * LOCATION_RETENTION_DAYS and never enter memory.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'lat',
    'lng',
    'label',
    'accuracyM',
    'capturedAt',
    'source',
    'timeZone',
    'arrivalOptIn',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value;
  const result = await recordOwnerLocation(body);
  if (!result.ok) return mobileJson({ error: result.error }, { status: result.status });
  return mobileJson({ ok: true });
}
