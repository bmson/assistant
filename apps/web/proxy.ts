import { loadConfig } from '@assistant/config';
import { type NextRequest, NextResponse } from 'next/server';

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function hasLocalChatPreview(request: NextRequest, authUrl: string, enabled: boolean): boolean {
  if (
    process.env.NODE_ENV !== 'development' ||
    !enabled ||
    !isLoopbackHostname(request.nextUrl.hostname)
  )
    return false;
  try {
    const configuredUrl = new URL(authUrl);
    return (
      ['http:', 'https:'].includes(configuredUrl.protocol) &&
      configuredUrl.username === '' &&
      configuredUrl.password === '' &&
      isLoopbackHostname(configuredUrl.hostname)
    );
  } catch {
    return false;
  }
}

/** Firestore preview exposes migrated read surfaces and the supported owner mutations. */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const runtimeConfig = loadConfig();
  if (runtimeConfig.ASSISTANT_RELEASE_WRITES_PAUSED) {
    const probe = ['/api/health', '/api/ready', '/api/release-probe'].includes(path);
    if (probe && ['GET', 'HEAD'].includes(request.method)) return NextResponse.next();
    return Response.json(
      { error: 'Assistant is being updated. Please try again shortly.', code: 'updating' },
      { status: 503, headers: { 'retry-after': '5', 'cache-control': 'no-store' } },
    );
  }
  const chatPage =
    path === '/chat' ||
    path === '/chat/all' ||
    /^\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path);
  const localChatPage =
    hasLocalChatPreview(request, runtimeConfig.AUTH_URL, runtimeConfig.WEB_APP_PREVIEW_ENABLED) &&
    chatPage &&
    ['GET', 'HEAD', 'POST'].includes(request.method);
  if (runtimeConfig.RESTORE_REHEARSAL) {
    const readOnlyRequest = request.method === 'GET' || request.method === 'HEAD';
    const staticAsset =
      path.startsWith('/_next/static/') ||
      [
        '/icon.svg',
        '/apple-icon.png',
        '/favicon.ico',
        '/manifest.webmanifest',
        '/icons/assistant-192.png',
        '/icons/assistant-512.png',
        '/icons/assistant-mark.svg',
        '/icons/assistant-source.svg',
      ].includes(path);
    if (readOnlyRequest && (path === '/api/health' || path === '/api/ready' || staticAsset))
      return NextResponse.next();
    return Response.json(
      {
        error: 'Only health, readiness, and static assets are available during restore rehearsal.',
      },
      { status: 503 },
    );
  }
  // Browser access is an owner administration console. Native APIs retain
  // their existing persistence and authentication boundaries below.
  const adminPage = ['/settings', '/security', '/signin', '/setup'].includes(path);
  const auditApi = /^\/api\/audit\/[0-9a-f-]{36}$/i.test(path);
  if (auditApi)
    return ['GET', 'HEAD'].includes(request.method)
      ? NextResponse.next()
      : Response.json({ error: 'Audit trail is read-only.' }, { status: 405 });
  const auditPage = path === '/audit' || /^\/audit\/[0-9a-f-]{36}$/i.test(path);
  const asset = [
    '/icon.svg',
    '/apple-icon.png',
    '/favicon.ico',
    '/manifest.webmanifest',
    '/icons/assistant-192.png',
    '/icons/assistant-512.png',
    '/icons/assistant-mark.svg',
    '/icons/assistant-source.svg',
  ].includes(path);
  // Public branding assets must reach Next's static-file handler in either
  // persistence mode, including the isolated shipping-image smoke check.
  if (asset && ['GET', 'HEAD'].includes(request.method)) return NextResponse.next();
  if (!path.startsWith('/api/') && !path.startsWith('/_next/') && !asset) {
    if (path === '/' || (!adminPage && !auditPage && !localChatPage)) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return NextResponse.redirect(new URL('/settings', request.url));
      }
      return Response.json({ error: 'Use the mobile app for this action.' }, { status: 410 });
    }
    if (auditPage) {
      return ['GET', 'HEAD'].includes(request.method)
        ? NextResponse.next()
        : Response.json({ error: 'Audit trail is read-only.' }, { status: 405 });
    }
  }
  if (loadConfig().PERSISTENCE_DRIVER !== 'firestore') return NextResponse.next();
  const chatIdPath =
    /^\/api\/mobile\/v1\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const activityIdPath =
    /^\/api\/mobile\/v1\/activity\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const anomalyIdPath =
    /^\/api\/mobile\/v1\/anomalies\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const documentIdPath =
    /^\/api\/mobile\/v1\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const suggestionIdPath =
    /^\/api\/mobile\/v1\/suggestions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const skillIdPath =
    /^\/api\/mobile\/v1\/skills\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const personOccasionsPath =
    /^\/api\/mobile\/v1\/memory\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/occasions$/i;
  const memoryPersonPath =
    /^\/api\/mobile\/v1\/memory\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const memoryOccasionPath =
    /^\/api\/mobile\/v1\/memory\/occasions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const approvalIdPath =
    /^\/api\/mobile\/v1\/approvals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const improvementIdPath =
    /^\/api\/mobile\/v1\/improvements\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const repairIdPath =
    /^\/api\/mobile\/v1\/repairs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const cardIdPath =
    /^\/api\/mobile\/v1\/cards\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const chatMessagePath =
    /^\/api\/mobile\/v1\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    path.startsWith('/api/auth/') ||
    // Passkey owner auth; each route returns 404 unless OWNER_AUTH_MODE=passkey.
    (path.startsWith('/api/owner/') && ['GET', 'POST', 'DELETE'].includes(request.method)) ||
    (['/setup', '/signin', '/security'].includes(path) && request.method === 'GET') ||
    (path === '/api/health' && request.method === 'GET') ||
    // Owner artifact download, gated on the owner's files record.
    (path === '/api/files' && request.method === 'GET') ||
    (path === '/api/ready' && request.method === 'GET') ||
    (path === '/api/release-probe' && request.method === 'GET') ||
    // Persistence-free owner reads: live scores (agent timezone only) and route maps.
    ((path === '/api/live/scoreboard' ||
      path === '/api/mobile/v1/live/scoreboard' ||
      path === '/api/maps/snapshot') &&
      request.method === 'GET') ||
    (path === '/api/mobile/v1/devices' && request.method === 'POST') ||
    // Legacy person links only redirect to /people/<id>.
    (/^\/profile\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'GET') ||
    (path === '/' && request.method === 'GET') ||
    (path === '/profile/memories' && request.method === 'GET') ||
    // The memory hub and its owner-authenticated Server Actions.
    (path === '/profile' && ['GET', 'POST'].includes(request.method)) ||
    // The People directory, one person's page, and their owner-authenticated
    // Server Actions (add, edit, occasions, facts, relations, merge, delete).
    (path === '/people' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path) &&
      ['GET', 'POST'].includes(request.method)) ||
    (path === '/profile/data' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/profile-export' && request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/export' && request.method === 'GET') ||
    (path === '/capabilities' && request.method === 'GET') ||
    // Anomaly and improvement review: owner-authenticated pages and actions.
    ((path === '/anomalies' || path === '/improvements') &&
      ['GET', 'POST'].includes(request.method)) ||
    // The POST is the costs page's Server Action; it performs its own owner
    // authentication and Firestore persistence checks before changing caps.
    (path === '/costs' && ['GET', 'POST'].includes(request.method)) ||
    // Owner document catalog: page, delete action, and the upload form.
    (path === '/documents' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/documents/upload' && request.method === 'POST') ||
    (path === '/profile/voice' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/profile/about' && ['GET', 'POST'].includes(request.method)) ||
    // Knowledge workspace: bounded Firestore reads and owner graph curation actions.
    (path === '/profile/knowledge' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/cards' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/packs' && ['GET', 'POST'].includes(request.method)) ||
    // Settings Server Actions recheck owner auth; Firestore supports the
    // assistant identity and notification preference updates.
    (path === '/settings' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/goals' && ['GET', 'POST'].includes(request.method)) ||
    // Import Server Actions and uploads recheck owner authentication; the
    // uploaded bytes go to the workspace store and the records to Firestore.
    (path === '/import' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/import/upload' && request.method === 'POST') ||
    (path === '/api/mobile/v1/imports' && request.method === 'POST') ||
    (path === '/skills' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/approvals' && ['GET', 'POST'].includes(request.method)) ||
    // Calls pages and their Server Actions recheck owner auth before touching a call.
    (path === '/calls' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/calls\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path) &&
      ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/calls' && request.method === 'GET') ||
    (/^\/api\/mobile\/v1\/calls\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['GET', 'POST'].includes(request.method)) ||
    // Activity pages and their Server Actions enforce owner authentication
    // before reading or changing task records.
    (path === '/tasks' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path) &&
      ['GET', 'POST'].includes(request.method)) ||
    (chatPage && ['GET', 'HEAD', 'POST'].includes(request.method)) ||
    (['/icon.svg', '/apple-icon.png', '/favicon.ico', '/manifest.webmanifest'].includes(path) &&
      request.method === 'GET') ||
    ((path === '/api/chat' || path === '/api/mobile/v1/chat') && request.method === 'POST') ||
    (path === '/api/chat/cancel' && request.method === 'POST') ||
    (path === '/api/mobile/v1/chat/cancel' && request.method === 'POST') ||
    (path === '/api/mobile/v1/chat/forms' && request.method === 'POST') ||
    ((path === '/api/chat/status' || path === '/api/mobile/v1/chat/status') &&
      request.method === 'GET') ||
    (path === '/api/shell/status' && request.method === 'GET') ||
    (path === '/api/mobile/v1/bootstrap' && request.method === 'GET') ||
    (path === '/api/mobile/v1/activity' && request.method === 'GET') ||
    (path === '/api/mobile/v1/activity' && request.method === 'POST') ||
    (path === '/api/mobile/v1/activity/foreground' && request.method === 'POST') ||
    (path === '/api/mobile/v1/location' && request.method === 'POST') ||
    (path === '/api/mobile/v1/goals' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/mcp' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/providers' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/providers/choice' && request.method === 'PUT') ||
    (/^\/api\/mobile\/v1\/providers\/[a-z0-9][a-z0-9_-]{0,39}$/.test(path) &&
      request.method === 'POST') ||
    (/^\/api\/mobile\/v1\/mcp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['POST', 'DELETE'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/goals\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['GET', 'PATCH', 'POST'].includes(request.method)) ||
    (activityIdPath.test(path) && request.method === 'POST') ||
    (anomalyIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/skills' && request.method === 'POST') ||
    (skillIdPath.test(path) && ['POST', 'PATCH', 'DELETE'].includes(request.method)) ||
    (path === '/api/mobile/v1/workspace' && request.method === 'GET') ||
    (path === '/api/mobile/v1/overview' && request.method === 'GET') ||
    (path === '/api/mobile/v1/documents' && ['GET', 'POST'].includes(request.method)) ||
    (documentIdPath.test(path) && ['GET', 'DELETE'].includes(request.method)) ||
    (suggestionIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/costs' && request.method === 'PATCH') ||
    (approvalIdPath.test(path) && request.method === 'POST') ||
    (improvementIdPath.test(path) && request.method === 'POST') ||
    // Repair handlers authenticate the owner and use the portable task repository.
    (path === '/api/mobile/v1/repairs' && ['GET', 'POST'].includes(request.method)) ||
    (repairIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/memory/profile' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/memory/people' && request.method === 'POST') ||
    (memoryPersonPath.test(path) && ['GET', 'PATCH', 'POST', 'DELETE'].includes(request.method)) ||
    // Owner memory commands: create, correct, confirm, forget, and review.
    (path === '/api/mobile/v1/memory' && request.method === 'POST') ||
    (/^\/api\/mobile\/v1\/memory\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['PATCH', 'POST'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/knowledge\/sources\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['GET', 'PATCH', 'DELETE'].includes(request.method)) ||
    (memoryOccasionPath.test(path) && ['POST', 'PATCH', 'DELETE'].includes(request.method)) ||
    (personOccasionsPath.test(path) && request.method === 'POST') ||
    (path === '/api/card-image' && request.method === 'GET') ||
    (path === '/api/mobile/v1/cards' && request.method === 'GET') ||
    (cardIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/packs' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/library' && request.method === 'GET') ||
    (path === '/api/mobile/v1/knowledge' && ['GET', 'POST'].includes(request.method)) ||
    (['/api/mobile/v1/knowledge/workspace', '/api/mobile/v1/knowledge/graph'].includes(path) &&
      request.method === 'GET') ||
    (path === '/api/mobile/v1/knowledge/cleanup' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/knowledge\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['GET', 'PATCH'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/knowledge\/relations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['GET', 'POST', 'DELETE'].includes(request.method)) ||
    (path === '/api/mobile/v1/people' && request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/commitments' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/email-obligations' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/settings' && request.method === 'PATCH') ||
    (/^\/api\/mobile\/v1\/settings\/reminders\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'DELETE') ||
    (/^\/api\/mobile\/v1\/settings\/policies\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['POST', 'DELETE'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/settings\/schedules\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'POST') ||
    (path === '/api/mobile/v1/chats' && request.method === 'POST') ||
    (chatIdPath.test(path) && ['GET', 'POST'].includes(request.method)) ||
    (chatMessagePath.test(path) && request.method === 'POST')
  ) {
    return NextResponse.next();
  }
  return Response.json(
    { error: 'This web surface is unavailable in Firestore mode.', code: 'unavailable' },
    { status: 503 },
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
