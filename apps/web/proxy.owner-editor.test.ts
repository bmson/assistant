import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  PERSISTENCE_DRIVER: 'firestore',
  RESTORE_REHEARSAL: false,
  ASSISTANT_RELEASE_WRITES_PAUSED: false,
  WEB_APP_PREVIEW_ENABLED: false,
  AUTH_URL: 'https://assistant.test',
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => config }));

import { proxy } from './proxy';

describe.each(['postgres', 'firestore'])('exact owner editor ingress in %s', (driver) => {
  beforeEach(() => {
    config.PERSISTENCE_DRIVER = driver;
    config.RESTORE_REHEARSAL = false;
    config.ASSISTANT_RELEASE_WRITES_PAUSED = false;
  });
  const paths = ['/api/people/editor', '/api/profile/knowledge/family'];
  it('forwards only GET receipt lookups and POST commands to the guarded adapters', () => {
    for (const path of paths)
      for (const method of ['GET', 'POST']) {
        expect(
          proxy(new NextRequest(`https://assistant.test${path}`, { method })).headers.get(
            'x-middleware-next',
          ),
        ).toBe('1');
      }
    for (const path of paths)
      for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET, POST');
        expect(response.headers.get('x-middleware-next')).toBeNull();
      }
  });
  it('keeps page Server Actions closed', () => {
    for (const path of [
      '/people',
      '/profile/knowledge',
      '/people/123e4567-e89b-42d3-a456-426614174000',
    ])
      expect(
        proxy(
          new NextRequest(`https://assistant.test${path}`, {
            method: 'POST',
            headers: { 'Next-Action': 'synthetic-action' },
          }),
        ).status,
      ).toBe(405);
  });
  it.each(['pause', 'rehearsal'])('keeps the earlier %s fence for lookup and apply', (fence) => {
    config.ASSISTANT_RELEASE_WRITES_PAUSED = fence === 'pause';
    config.RESTORE_REHEARSAL = fence === 'rehearsal';
    for (const path of paths)
      for (const method of ['GET', 'POST']) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.status).toBe(503);
        expect(response.headers.get('x-middleware-next')).toBeNull();
      }
  });
});

it('does not turn the Firestore exact exception into a prefix allowlist', () => {
  config.PERSISTENCE_DRIVER = 'firestore';
  config.RESTORE_REHEARSAL = false;
  config.ASSISTANT_RELEASE_WRITES_PAUSED = false;
  for (const path of [
    '/api/people/editor/extra',
    '/api/people/editor/',
    '/api/profile/knowledge/family/extra',
    '/api/profile/knowledge/family/',
    '/api/profile/knowledge/correct',
  ]) {
    const response = proxy(new NextRequest(`https://assistant.test${path}`, { method: 'POST' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-middleware-next')).toBeNull();
  }
});
