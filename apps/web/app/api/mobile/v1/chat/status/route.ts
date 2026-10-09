import { projectMobileCardCapabilities } from '@/lib/mobile-card-capabilities';
import { getChatApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * A held poll occupies this handler for as long as the caller asked for, so
 * the platform's own ceiling has to clear the application's 25s cap with room
 * to spare. This matters most here: holding one connection is what lets the
 * phone stop waking its radio on a timer.
 */
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const MAX_REFRESH_IDS = 10;

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const url = new URL(request.url);
  const conversationId = url.searchParams.get('conversationId') ?? '';
  const taskId = url.searchParams.get('taskId');
  const cursor = url.searchParams.get('cursor');
  const refresh = url.searchParams.get('refresh');

  if (!UUID_RE.test(conversationId)) {
    return mobileJson({ error: 'conversationId required' }, { status: 400 });
  }
  if (taskId !== null && !UUID_RE.test(taskId)) {
    return mobileJson({ error: 'invalid taskId' }, { status: 400 });
  }
  const refreshIds = refresh ? refresh.split(',').slice(0, MAX_REFRESH_IDS) : [];
  if (refreshIds.some((id) => !UUID_RE.test(id))) {
    return mobileJson({ error: 'invalid refresh id' }, { status: 400 });
  }

  const waitMs = Number(url.searchParams.get('wait') ?? 0);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    return mobileJson({ error: 'invalid wait' }, { status: 400 });
  }

  const application = getChatApplication();
  if (cursor && !application.isValidChatCursor(cursor)) {
    return mobileJson({ error: 'invalid cursor' }, { status: 400 });
  }
  const status = await application.getChatUpdates({
    conversationId,
    ...(taskId ? { taskId } : {}),
    ...(cursor ? { cursor } : {}),
    ...(refreshIds.length > 0 ? { refreshIds } : {}),
    pageSize: PAGE_SIZE,
    waitMs,
    // A phone that locks, backgrounds or loses signal drops the connection;
    // the hold must end with it rather than run to its deadline.
    signal: request.signal,
  });
  return status
    ? mobileJson(projectMobileCardCapabilities(status, request))
    : mobileJson({ error: 'conversation not found' }, { status: 404 });
}
