import {
  beginCalendarConnection,
  CALENDAR_CONNECTION_TTL,
  calendarCallbackURL,
} from '@assistant/application/calendar-accounts';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { isAuthed } from '@/auth';
import { getCalendarAccountPorts } from '@/lib/server';

export async function GET(request: Request) {
  const owner = await isAuthed();
  if (!owner) return new Response('Sign in before connecting a calendar.', { status: 401 });
  const ports = getCalendarAccountPorts();
  let origin: string;
  try {
    origin = new URL(calendarCallbackURL(ports.config.AUTH_URL)).origin;
  } catch {
    return new Response('Calendar connections are not configured.', { status: 503 });
  }
  // A navigation (rather than a redirected form POST) allows employer-specific Okta origins.
  // The callback is independently bound to this browser login and a random, sealed state.
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    return new Response('Start from Settings', { status: 403 });
  try {
    const connection = await beginCalendarConnection(ports, owner.formSessionScope ?? '');
    (await cookies()).set('assistant-calendar-connect', connection.cookie, {
      httpOnly: true,
      secure: origin.startsWith('https:'),
      sameSite: 'lax',
      path: '/api',
      maxAge: CALENDAR_CONNECTION_TTL,
    });
    return NextResponse.redirect(connection.url, {
      status: 303,
      headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch {
    return NextResponse.redirect(new URL('/settings?calendarConnection=setup', origin), 303);
  }
}
