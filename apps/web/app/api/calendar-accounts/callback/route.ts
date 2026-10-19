import {
  calendarCallbackURL,
  completeCalendarConnection,
} from '@assistant/application/calendar-accounts';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { isAuthed } from '@/auth';
import { getCalendarAccountPorts } from '@/lib/server';

export async function GET(request: Request) {
  const owner = await isAuthed();
  if (!owner)
    return new Response('Sign in and restart the calendar connection from Settings.', {
      status: 401,
      headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  const ports = getCalendarAccountPorts();
  const target = new URL('/settings', calendarCallbackURL(ports.config.AUTH_URL));
  const jar = await cookies();
  const cookie = jar.get('assistant-calendar-connect')?.value;
  jar.set('assistant-calendar-connect', '', {
    httpOnly: true,
    secure: target.protocol === 'https:',
    sameSite: 'lax',
    path: '/api',
    maxAge: 0,
  });
  const query = new URL(request.url).searchParams;
  try {
    if (!cookie || query.has('error')) throw new Error('Connection was not authorized');
    await completeCalendarConnection(ports, {
      cookie,
      state: query.get('state') ?? '',
      code: query.get('code') ?? '',
      sessionScope: owner.formSessionScope ?? '',
    });
    target.searchParams.set('calendarConnection', 'connected');
  } catch {
    // Never echo Google's error descriptions, codes, or tokens into a URL or log.
    target.searchParams.set('calendarConnection', 'failed');
  }
  return NextResponse.redirect(target, {
    status: 303,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
