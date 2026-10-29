import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  PERSISTENCE_DRIVER: 'firestore',
  RESTORE_REHEARSAL: false,
  ASSISTANT_RELEASE_WRITES_PAUSED: false,
  WEB_APP_PREVIEW_ENABLED: false,
  AUTH_URL: '',
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => runtime }));

import { proxy } from './proxy';

const person = '123e4567-e89b-42d3-a456-426614174000';
const pages = [
  '/profile',
  '/profile/memories',
  '/people',
  `/people/${person}`,
  '/profile/knowledge',
  `/profile/knowledge/notes/${person}`,
];

describe.each(['postgres', 'firestore'])('Memory browse ingress in %s', (driver) => {
  beforeEach(() => {
    runtime.PERSISTENCE_DRIVER = driver;
    runtime.RESTORE_REHEARSAL = false;
    runtime.ASSISTANT_RELEASE_WRITES_PAUSED = false;
  });

  it('forwards only exact GET/HEAD pages to their owner-authenticated composition', () => {
    for (const path of pages) {
      for (const method of ['GET', 'HEAD']) {
        const response = proxy(
          new NextRequest(`https://assistant.test${path}?view=map&q=Ada`, { method }),
        );
        expect(response.headers.get('x-middleware-next')).toBe('1');
        expect(response.headers.get('location')).toBeNull();
      }
    }
  });

  it('blocks direct Server Action and mutation attempts before a handler can run', () => {
    const mutation = vi.fn();
    for (const path of pages) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = proxy(
          new NextRequest(`https://assistant.test${path}?view=cleanup&edit=true`, {
            method,
            headers: { 'next-action': 'synthetic-known-write-action' },
          }),
        );
        if (response.headers.get('x-middleware-next') === '1') mutation();
        expect(response.status).toBe(405);
        expect(response.headers.get('x-middleware-next')).toBeNull();
      }
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  it('does not admit malformed identifiers or additional profile/people descendants', () => {
    for (const path of [
      '/profile/about',
      '/profile/data',
      '/profile/knowledge/extra',
      '/profile/knowledge/notes/not-an-id',
      '/profile/knowledge/notes/123e4567-e89b-02d3-a456-426614174000',
      `/profile/knowledge/notes/${person}/extra`,
      `/profile/knowledge/notes/${person}/`,
      `/profile/people/${person}`,
      '/people/not-an-id',
      '/people/123e4567-e89b-02d3-a456-426614174000',
      '/people/123e4567-e89b-42d3-0456-426614174000',
      `/people/${person}/extra`,
      '/people/',
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.status).toBe(307);
        expect(response.headers.get('x-middleware-next')).toBeNull();
      }
      const response = proxy(new NextRequest(`https://assistant.test${path}`, { method: 'POST' }));
      expect(response.status).toBe(410);
      expect(response.headers.get('x-middleware-next')).toBeNull();
    }
  });

  it.each(['pause', 'rehearsal'])('preserves the earlier %s fence', (fence) => {
    runtime.ASSISTANT_RELEASE_WRITES_PAUSED = fence === 'pause';
    runtime.RESTORE_REHEARSAL = fence === 'rehearsal';
    for (const path of pages) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const response = proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        expect(response.status).toBe(503);
        expect(response.headers.get('x-middleware-next')).toBeNull();
      }
    }
  });
});
