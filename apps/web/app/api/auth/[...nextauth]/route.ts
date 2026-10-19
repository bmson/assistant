import { authMode, handlers } from '@/auth';

// Passkey installations have no Google OAuth client; keep Auth.js endpoints closed.
const closed = () => Response.json({ error: 'not_found' }, { status: 404 });

export const GET = authMode === 'passkey' ? closed : handlers.GET;
export const POST = authMode === 'passkey' ? closed : handlers.POST;
