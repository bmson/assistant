import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  PERSISTENCE_DRIVER: 'firestore',
  ASSISTANT_RELEASE_WRITES_PAUSED: true,
  AUTH_URL: '',
  WEB_APP_PREVIEW_ENABLED: false,
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => runtime }));

import { proxy } from './proxy.js';

describe('release maintenance request fence', () => {
  it.each(['firestore', 'postgres'])(
    'blocks workspace handlers and server actions in %s before any request is forwarded',
    async (driver) => {
      runtime.PERSISTENCE_DRIVER = driver;
      runtime.ASSISTANT_RELEASE_WRITES_PAUSED = true;
      for (const [path, method] of [
        ['/api/chat', 'POST'],
        ['/api/mobile/v1/chat', 'POST'],
        ['/api/mobile/v1/bootstrap', 'GET'],
        ['/api/mobile/v1/chat/status', 'GET'],
        ['/api/documents/upload', 'POST'],
        ['/api/mobile/v1/settings', 'PATCH'],
        ['/api/mobile/v1/knowledge/cleanup', 'POST'],
        ['/api/owner/browser-signout', 'POST'],
        ['/api/auth/session', 'GET'],
        ['/settings', 'POST'],
        ['/settings', 'GET'],
        ['/api/release-probe', 'POST'],
      ]) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('5');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-middleware-next')).toBeNull();
        expect(await response.json()).toEqual({
          error: 'Assistant is being updated. Please try again shortly.',
          code: 'updating',
        });
      }
    },
  );
  it('retains only read-only release probes during the pause', () => {
    runtime.ASSISTANT_RELEASE_WRITES_PAUSED = true;
    for (const path of ['/api/health', '/api/ready', '/api/release-probe'])
      for (const method of ['GET', 'HEAD']) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.headers.get('x-middleware-next')).toBe('1');
      }
  });
  it('restores normal authenticated adapter routing when explicitly resumed', () => {
    runtime.PERSISTENCE_DRIVER = 'firestore';
    runtime.ASSISTANT_RELEASE_WRITES_PAUSED = false;
    for (const path of ['/api/chat', '/api/mobile/v1/chat']) {
      const response = proxy(new NextRequest(`https://assistant.test${path}`, { method: 'POST' }));
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
    expect(
      proxy(new NextRequest('https://assistant.test/api/release-probe')).headers.get(
        'x-middleware-next',
      ),
    ).toBe('1');
  });
});
