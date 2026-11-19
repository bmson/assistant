import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  PERSISTENCE_DRIVER: 'firestore',
  RESTORE_REHEARSAL: false,
  ASSISTANT_RELEASE_WRITES_PAUSED: false,
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => config }));

import { proxy } from './proxy.js';

const status = (path: string, method: string) =>
  proxy(new NextRequest(`https://example.invalid${path}`, { method })).status;
describe('Calendar OAuth ingress', () => {
  beforeEach(() => {
    config.RESTORE_REHEARSAL = false;
    config.ASSISTANT_RELEASE_WRITES_PAUSED = false;
  });
  it('admits only the exact public callback and supported owner endpoint methods', () => {
    const base = '/api/mobile/v1/connections/google-calendar';
    expect(status('/api/oauth/google-calendar/callback', 'GET')).toBe(200);
    expect(status('/api/oauth/google-calendar/callback', 'POST')).toBe(503);
    expect(status('/api/oauth/google-calendar/callback/extra', 'GET')).toBe(503);
    for (const method of ['GET', 'DELETE']) expect(status(base, method)).toBe(200);
    expect(status(base, 'POST')).toBe(503);
    expect(status(`${base}/connect`, 'POST')).toBe(200);
    expect(status(`${base}/connect`, 'GET')).toBe(503);
    for (const method of ['GET', 'DELETE']) expect(status(`${base}/flow`, method)).toBe(200);
    expect(status(`${base}/flow`, 'POST')).toBe(503);
    expect(status(`${base}/extra`, 'GET')).toBe(503);
  });
  it('preserves release pause and restore fences around the callback', () => {
    config.RESTORE_REHEARSAL = true;
    expect(status('/api/oauth/google-calendar/callback', 'GET')).toBe(503);
    config.RESTORE_REHEARSAL = false;
    config.ASSISTANT_RELEASE_WRITES_PAUSED = true;
    expect(status('/api/oauth/google-calendar/callback', 'GET')).toBe(503);
  });
});
