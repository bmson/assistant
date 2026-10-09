import { fetchPublicWebResponse } from '@assistant/application/public-web';
import { requireOwner } from '@/auth';
import { createCardImageHandler } from './handler.js';

export const runtime = 'nodejs';

export const GET = createCardImageHandler({
  requireOwner,
  fetchPublic: fetchPublicWebResponse,
});
