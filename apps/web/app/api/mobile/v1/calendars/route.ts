import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** The bridge can read consent for safe rollback, but cannot publish or revoke it. */
async function rejectLegacyMutation(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return mobileJson(
    {
      error:
        'This server version does not accept calendar sharing changes. Use a server with publisher-verified calendar sharing.',
      code: 'calendar_sharing_protocol_required',
    },
    { status: 503 },
  );
}

export const PUT = rejectLegacyMutation;
export const DELETE = rejectLegacyMutation;
