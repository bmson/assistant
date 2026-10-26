import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  PERSISTENCE_DRIVER: 'firestore',
  RESTORE_REHEARSAL: false,
  WEB_APP_PREVIEW_ENABLED: false,
  AUTH_URL: '',
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => config }));

import { proxy } from './proxy';

describe.each(['firestore', 'postgres'])('mobile administration in %s mode', (driver) => {
  it('serves public app icons instead of redirecting them to Settings', () => {
    config.PERSISTENCE_DRIVER = driver;
    for (const path of [
      '/icon.svg',
      '/apple-icon.png',
      '/icons/assistant-192.png',
      '/icons/assistant-512.png',
      '/icons/assistant-mark.svg',
      '/icons/assistant-source.svg',
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('x-middleware-next')).toBe('1');
      }
    }
  });
  it('admits only owner chat routes and preserves other retired-page boundaries', () => {
    config.PERSISTENCE_DRIVER = driver;
    for (const path of ['/chat', '/chat/all', `/chat/${randomUUID()}`]) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.status).toBe(200);
        expect(response.headers.get('x-middleware-next')).toBe('1');
      }
      expect(
        proxy(new NextRequest(`https://assistant.test${path}`, { method: 'DELETE' })).status,
      ).toBe(410);
    }
    for (const path of [
      '/',
      '/chat/not-a-conversation-id',
      '/chat/123e4567-e89b-12d3-a456-426614174000/extra',
      '/tasks',
      '/documents',
    ]) {
      const result = proxy(new NextRequest(`https://assistant.test${path}`));
      expect(result.status).toBe(307);
      expect(result.headers.get('location')).toBe('https://assistant.test/settings');
      expect(
        proxy(new NextRequest(`https://assistant.test${path}`, { method: 'POST' })).status,
      ).toBe(410);
    }
    const auditApi = `https://assistant.test/api/audit/${randomUUID()}`;
    expect(proxy(new NextRequest(auditApi)).status).toBe(200);
    expect(proxy(new NextRequest(auditApi, { method: 'POST' })).status).toBe(405);
    expect(
      proxy(new NextRequest('https://assistant.test/api/owner/browser-signout', { method: 'POST' }))
        .status,
    ).toBe(200);
    for (const path of [
      '/settings',
      '/audit',
      `/audit/${randomUUID()}`,
      '/signin',
      '/setup',
      '/security',
    ])
      expect(proxy(new NextRequest(`https://assistant.test${path}`)).status).toBe(200);
    expect(
      proxy(new NextRequest('https://assistant.test/settings', { method: 'POST' })).status,
    ).toBe(200);
    expect(proxy(new NextRequest('https://assistant.test/audit', { method: 'POST' })).status).toBe(
      405,
    );
    expect(proxy(new NextRequest('https://assistant.test/api/mobile/v1/bootstrap')).status).toBe(
      200,
    );
    expect(proxy(new NextRequest('https://assistant.test/api/auth/session')).status).toBe(200);
  });

  it('does not let local preview settings open other retired product routes', () => {
    const request = (path: string, method = 'GET', host = 'localhost') =>
      new NextRequest(`http://${host}${path}`, { method });
    const configure = (options: {
      enabled: boolean;
      nodeEnv?: string;
      authUrl?: string;
      host?: string;
      path?: string;
      method?: string;
    }) => {
      config.PERSISTENCE_DRIVER = 'firestore';
      config.RESTORE_REHEARSAL = false;
      config.WEB_APP_PREVIEW_ENABLED = options.enabled;
      config.AUTH_URL = options.authUrl ?? 'http://localhost:3000';
      vi.stubEnv('NODE_ENV', options.nodeEnv ?? 'development');
      try {
        return proxy(
          request(options.path ?? '/tasks', options.method ?? 'GET', options.host ?? 'localhost'),
        );
      } finally {
        vi.unstubAllEnvs();
        config.WEB_APP_PREVIEW_ENABLED = false;
        config.AUTH_URL = '';
      }
    };

    const closedByDefault = configure({ enabled: false });
    expect(closedByDefault.status).toBe(307);
    expect(closedByDefault.headers.get('location')).toBe('http://localhost/settings');
    expect(configure({ enabled: false, method: 'POST' }).status).toBe(410);
    expect(configure({ enabled: true, nodeEnv: 'production' }).status).toBe(307);
    expect(configure({ enabled: true, host: 'preview.example.test' }).status).toBe(307);
    expect(configure({ enabled: true, authUrl: 'https://preview.example.test' }).status).toBe(307);
    expect(configure({ enabled: true, authUrl: 'ftp://localhost:3000' }).status).toBe(307);
    expect(configure({ enabled: true, authUrl: 'http://user:secret@localhost:3000' }).status).toBe(
      307,
    );
    expect(configure({ enabled: true, path: '/chat/not-a-conversation-id' }).status).toBe(307);

    // The preview setting does not broaden unrelated product routes or API gates.
    config.PERSISTENCE_DRIVER = 'firestore';
    config.WEB_APP_PREVIEW_ENABLED = false;
    vi.stubEnv('NODE_ENV', 'development');
    try {
      expect(proxy(request('/api/chat', 'POST')).status).toBe(200);
      expect(proxy(request('/api/mobile/v1/chat', 'POST')).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exposes only health/readiness and static assets during restore rehearsal', () => {
    config.PERSISTENCE_DRIVER = 'postgres';
    config.RESTORE_REHEARSAL = true;
    config.WEB_APP_PREVIEW_ENABLED = true;
    config.AUTH_URL = 'http://localhost:3000';
    vi.stubEnv('NODE_ENV', 'development');
    try {
      for (const path of [
        '/api/health',
        '/api/ready',
        '/_next/static/chunks/app.js',
        '/icon.svg',
      ]) {
        expect(proxy(new NextRequest(`https://assistant.test${path}`)).status).toBe(200);
      }
      for (const path of ['/api/auth/signin', '/api/mobile/v1/chat', '/settings', '/api/files']) {
        expect(proxy(new NextRequest(`https://assistant.test${path}`)).status).toBe(503);
      }
      expect(
        proxy(new NextRequest('https://assistant.test/api/health', { method: 'POST' })).status,
      ).toBe(503);
    } finally {
      config.RESTORE_REHEARSAL = false;
      config.WEB_APP_PREVIEW_ENABLED = false;
      config.AUTH_URL = '';
      vi.unstubAllEnvs();
    }
  });
});
