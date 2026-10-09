import { describe, expect, it, vi } from 'vitest';
import { requestBrowserSignOut } from './browser-signout';

describe('requestBrowserSignOut', () => {
  it('posts same-origin and returns only a confirmed same-origin redirect', async () => {
    const fetcher = vi.fn(async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: 'https://assistant.test/signin' },
      });
      return response;
    });
    await expect(requestBrowserSignOut(fetcher, 'https://assistant.test')).resolves.toBe(
      'https://assistant.test/signin',
    );
    expect(fetcher).toHaveBeenCalledWith('/api/owner/browser-signout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'text/html' },
    });
  });

  it('rejects failed, non-redirect, and cross-origin responses', async () => {
    const failed = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(requestBrowserSignOut(failed, 'https://assistant.test')).rejects.toThrow();
    const unredirected = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(requestBrowserSignOut(unredirected, 'https://assistant.test')).rejects.toThrow();
    const external = vi.fn(async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: 'https://outside.test/signin' },
      });
      return response;
    });
    await expect(requestBrowserSignOut(external, 'https://assistant.test')).rejects.toThrow();
    const sameOriginWrongPath = vi.fn(async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: 'https://assistant.test/audit' },
      });
      return response;
    });
    await expect(
      requestBrowserSignOut(sameOriginWrongPath, 'https://assistant.test'),
    ).rejects.toThrow();
  });
});
