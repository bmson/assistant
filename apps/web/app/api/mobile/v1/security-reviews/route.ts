import { listOwnerSecurityReviews } from '@assistant/application/security-incidents';
import { getEmailObligationRepository } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    return mobileJson({ error: 'limit must be an integer from 1 to 100' }, { status: 400 });

  const repository = getEmailObligationRepository();
  const { agentId } = await repository.mailbox();
  const items = await listOwnerSecurityReviews(repository, agentId, limit);
  return mobileJson({ items });
}
