import { describe, expect, it, vi } from 'vitest';
import { requestPanelUpload } from './upload-request';

const origin = 'https://assistant.test';
const data = new FormData();
data.set('file', new File(['synthetic'], 'review.txt'));

describe('enhanced upload response contract', () => {
  it('posts the original multipart body and navigates to the existing same-origin destination', async () => {
    const fetcher = vi.fn(async () => Response.json({ redirectTo: '/import?source=synthetic' }));
    await expect(requestPanelUpload('/api/import/upload', data, fetcher, origin)).resolves.toBe(
      `${origin}/import?source=synthetic`,
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/import/upload', {
      method: 'POST',
      body: data,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  });

  it.each([
    [400, /file or label/],
    [401, /Sign in again/],
    [403, /Sign in again/],
    [413, /25MB/],
    [415, /file or label/],
    [503, /Try again/],
  ])('turns HTTP %s into a readable recovery message', async (status, message) => {
    await expect(
      requestPanelUpload(
        '/api/documents/upload',
        data,
        async () => Response.json({ error: 'internal endpoint detail' }, { status }),
        origin,
      ),
    ).rejects.toThrow(message);
  });

  it('does not automatically retry an interrupted request', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      requestPanelUpload('/api/documents/upload', data, fetcher, origin),
    ).rejects.toThrow(/Refresh this page/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response('<html>Unexpected server page</html>'),
    Response.json({}),
    Response.json(null),
    Response.json({ redirectTo: 'https://outside.test/' }),
    Response.json({ redirectTo: '//outside.test/' }),
    Response.json({ redirectTo: '/audit' }),
    Response.json({ redirectTo: 'http://[' }),
  ])('does not claim an unconfirmed upload succeeded', async (response) => {
    await expect(
      requestPanelUpload('/api/documents/upload', data, async () => response, origin),
    ).rejects.toThrow(/could not be confirmed/);
  });
});
