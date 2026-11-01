import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnerEditorReadOnlyJsonClient } from './owner-editor-readonly-http.js';

const endpoint = () =>
  new URL(
    'https://run.googleapis.com/v2/projects/example-project/locations/us-central1/jobs/maintenance/executions/run-one',
  );

afterEach(() => vi.useRealTimers());

describe('bounded read-only Google transport with invented responses', () => {
  it('uses only GET, rejects redirects and never exposes token or response configuration', async () => {
    const fetcher = vi.fn(async () => new Response('{"taskCount":1}'));
    const lease = createOwnerEditorReadOnlyJsonClient({
      getAccessToken: async () => 'private-token',
      fetch: fetcher,
    });
    await expect(lease.client.get(endpoint())).resolves.toEqual({ taskCount: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      endpoint().href,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
      }),
    );
    await lease.disposeClients();
    await expect(lease.client.get(endpoint())).rejects.toThrow(
      'Read-only inspection is unavailable',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://attacker.example/collect-token',
    'https://run.googleapis.com/v2/projects/example-project/locations/us-central1/jobs/maintenance:run',
  ])(
    'dispatches only the private URL when the caller changes its URL to %s during ADC',
    async (replacement) => {
      let resolveToken: (token: string) => void = () => undefined;
      const token = new Promise<string>((resolve) => {
        resolveToken = resolve;
      });
      const fetcher = vi.fn(async () => new Response('{}'));
      const lease = createOwnerEditorReadOnlyJsonClient({
        getAccessToken: () => token,
        fetch: fetcher,
      });
      const callerUrl = endpoint();
      const validatedHref = callerUrl.href;
      const pending = lease.client.get(callerUrl);
      callerUrl.href = replacement;
      resolveToken('private-token');
      await pending;
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        validatedHref,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetcher).not.toHaveBeenCalledWith(replacement, expect.anything());
      await lease.disposeClients();
    },
  );

  it.each([
    'https://example.com/v2/projects/example-project',
    'https://run.googleapis.com/v2/projects/example-project/locations/us-central1/jobs/maintenance:run',
    'https://firestore.googleapis.com/v1/projects/example-project/databases/(default)/documents/secrets',
    'https://firestore.googleapis.com/v1/projects/example-project/databases/(default)/collectionGroups/contacts/indexes?unknown=1',
    'https://user@run.googleapis.com/v2/projects/example-project/locations/us-central1/jobs/maintenance/executions/run-one',
  ])('rejects an unsupported resource before acquiring credentials: %s', async (url) => {
    const token = vi.fn(async () => 'private-token');
    const fetcher = vi.fn(async () => new Response('{}'));
    const lease = createOwnerEditorReadOnlyJsonClient({ getAccessToken: token, fetch: fetcher });
    await expect(lease.client.get(new URL(url))).rejects.toThrow(
      'Read-only inspection is unavailable',
    );
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await lease.disposeClients();
  });

  it('times out ADC and prevents an API dispatch when the token arrives late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let resolveToken: (token: string) => void = () => undefined;
    const token = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const fetcher = vi.fn(async () => new Response('{}'));
    const lease = createOwnerEditorReadOnlyJsonClient({
      getAccessToken: () => token,
      fetch: fetcher,
    });
    const rejected = expect(lease.client.get(endpoint())).rejects.toThrow(
      'Read-only inspection is unavailable',
    );
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    resolveToken('late-private-token');
    await Promise.resolve();
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    await lease.disposeClients();
  });

  it('aborts outstanding reads on disposal without claiming ADC was cancelled', async () => {
    const token = new Promise<string>(() => undefined);
    const fetcher = vi.fn(async () => new Response('{}'));
    const lease = createOwnerEditorReadOnlyJsonClient({
      getAccessToken: () => token,
      fetch: fetcher,
    });
    const rejected = expect(lease.client.get(endpoint())).rejects.toThrow(
      'Read-only inspection is unavailable',
    );
    await lease.disposeClients();
    await rejected;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a read after the total budget before acquiring credentials', async () => {
    let now = 1000;
    const token = vi.fn(async () => 'private-token');
    const fetcher = vi.fn(async () => new Response('{}'));
    const lease = createOwnerEditorReadOnlyJsonClient({
      getAccessToken: token,
      fetch: fetcher,
      now: () => now,
    });
    now += 60_001;
    await expect(lease.client.get(endpoint())).rejects.toThrow(
      'Read-only inspection is unavailable',
    );
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await lease.disposeClients();
  });

  it('does not expose credential-provider failures or dispatch an API request', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    const lease = createOwnerEditorReadOnlyJsonClient({
      async getAccessToken() {
        throw new Error('private credential detail');
      },
      fetch: fetcher,
    });
    await expect(lease.client.get(endpoint())).rejects.toThrow(
      /^Read-only inspection is unavailable$/,
    );
    expect(fetcher).not.toHaveBeenCalled();
    await lease.disposeClients();
  });

  it.each([
    () => new Response('private-body', { status: 403 }),
    () => new Response('{bad-private-json'),
    () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
    () => new Response(new Uint8Array([0xc3, 0x28])),
  ])('maps denied, malformed and oversized responses to fixed errors', async (response) => {
    const lease = createOwnerEditorReadOnlyJsonClient({
      getAccessToken: async () => 'private-token',
      fetch: async () => response(),
    });
    await expect(lease.client.get(endpoint())).rejects.toThrow(
      /^Read-only inspection is unavailable$/,
    );
    await lease.disposeClients();
  });
});
