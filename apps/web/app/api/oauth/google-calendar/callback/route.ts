import { getGoogleCalendarConnectionService } from '@/lib/google-calendar-connection-runtime';
export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};
export async function GET(request: Request): Promise<Response> {
  try {
    const result = await getGoogleCalendarConnectionService().callback(
      new URL(request.url).searchParams,
    );
    if (result.flowId) {
      const completion = new URL('assistant-oauth://google-calendar/callback');
      completion.searchParams.set('flowId', result.flowId);
      return new Response(null, {
        status: 302,
        headers: { ...headers, Location: completion.href },
      });
    }
    return new Response(
      'This Calendar connection link is invalid or unavailable. Return to Assistant to check its status.',
      { status: 400, headers },
    );
  } catch {
    return new Response(
      'Calendar connection could not be confirmed. Return to Assistant to check its status.',
      { status: 503, headers },
    );
  }
}
