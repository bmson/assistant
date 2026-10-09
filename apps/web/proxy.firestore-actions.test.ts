import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeConfig = vi.hoisted(() => ({
  PERSISTENCE_DRIVER: 'firestore',
  RESTORE_REHEARSAL: false,
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => runtimeConfig }));

import { proxy } from './proxy.js';

const status = (path: string, method: string) =>
  proxy(new NextRequest(`http://localhost${path}`, { method })).status;

describe('Firestore mobile and web ingress', () => {
  beforeEach(() => {
    runtimeConfig.RESTORE_REHEARSAL = false;
  });

  it('passes repair reads, reports, and decisions to authenticated handlers', () => {
    for (const method of ['GET', 'POST'])
      expect(status('/api/mobile/v1/repairs', method)).toBe(200);
    const path = `/api/mobile/v1/repairs/${randomUUID()}`;
    expect(status(path, 'POST')).toBe(200);
    for (const method of ['GET', 'PATCH', 'DELETE']) expect(status(path, method)).toBe(503);
    expect(status('/api/mobile/v1/repairs', 'DELETE')).toBe(503);
    expect(status('/api/mobile/v1/repairs/not-a-uuid', 'POST')).toBe(503);
    expect(status(`${path}/extra`, 'POST')).toBe(503);
  });

  it('passes supported anomaly and suggestion writes to authenticated handlers', () => {
    const paths = [
      `/api/mobile/v1/anomalies/${randomUUID()}`,
      `/api/mobile/v1/suggestions/${randomUUID()}`,
    ];
    for (const path of paths) {
      expect(status(path, 'POST')).toBe(200);
      expect(status(path, 'DELETE')).toBe(503);
    }
  });

  it('passes portable mobile overview and document reads', () => {
    const documentId = randomUUID();
    expect(status('/api/mobile/v1/overview', 'GET')).toBe(200);
    expect(status('/api/mobile/v1/documents', 'GET')).toBe(200);
    expect(status(`/api/mobile/v1/documents/${documentId}`, 'GET')).toBe(200);
    // These handlers explicitly return 501 until document processing is portable.
    expect(status('/api/mobile/v1/documents', 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/documents/${documentId}`, 'DELETE')).toBe(200);
  });

  it('keeps malformed IDs, unsupported methods, and SQL-only routes blocked', () => {
    expect(status('/api/mobile/v1/anomalies/not-a-uuid', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/suggestions/not-a-uuid', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/documents/not-a-uuid', 'GET')).toBe(503);
    expect(status('/api/mobile/v1/overview', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/knowledge/graph', 'POST')).toBe(503);
  });

  it('passes only supported knowledge relationship review methods for exact IDs', () => {
    const path = `/api/mobile/v1/knowledge/relations/${randomUUID()}`;
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(status(path, method)).toBe(200);
    }
    expect(status(path, 'PATCH')).toBe(503);
    expect(status('/api/mobile/v1/knowledge/relations/not-a-uuid', 'GET')).toBe(503);
  });

  it('keeps cancellation unavailable during restore rehearsal', () => {
    runtimeConfig.RESTORE_REHEARSAL = true;
    expect(status('/api/chat/cancel', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/chat/cancel', 'POST')).toBe(503);
    runtimeConfig.RESTORE_REHEARSAL = false;
  });

  it('passes only exact chat cancellation POST routes and preserves forms POST', () => {
    for (const path of ['/api/chat/cancel', '/api/mobile/v1/chat/cancel']) {
      expect(status(path, 'POST')).toBe(200);
      for (const method of ['GET', 'PUT', 'DELETE']) expect(status(path, method)).toBe(503);
      expect(status(`${path}/extra`, 'POST')).toBe(503);
    }
    expect(status('/api/mobile/v1/chat/forms', 'POST')).toBe(200);
    expect(status('/api/mobile/v1/chat/forms', 'GET')).toBe(503);
  });

  it('passes passkey owner-auth pages and endpoints', () => {
    for (const path of ['/setup', '/signin', '/security']) {
      expect(status(path, 'GET')).toBe(200);
      expect(status(path, 'POST')).toBe(503);
    }
    for (const method of ['GET', 'POST', 'DELETE'])
      expect(status('/api/owner/passkeys', method)).toBe(200);
    expect(status('/api/owner/claim', 'PUT')).toBe(503);
  });
});
