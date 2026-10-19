import { authMode, handlers } from '@/auth';
import { GET as calendarCallback } from '../../calendar-accounts/callback/route';

// Only the separately sealed calendar flow may bypass Auth.js's owner sign-in handler.
// Its callback independently checks the existing owner session, state, and PKCE.
export const GET: typeof handlers.GET = async (request) => {
  const url = new URL(request.url);
  if (
    url.pathname === '/api/auth/callback/google' &&
    url.searchParams.get('state')?.startsWith('calendar.')
  )
    return calendarCallback(request);
  return authMode === 'passkey' ? closed() : handlers.GET(request);
};

// Passkey installations have no Google owner sign-in client.
const closed = () => Response.json({ error: 'not_found' }, { status: 404 });
export const POST: typeof handlers.POST = async (request) =>
  authMode === 'passkey' ? closed() : handlers.POST(request);
