// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpOAuthControl } from './mcp-oauth-control';

const connectionId = 'a4c4f601-0244-4351-968a-1a5337a1a463';
const flowId = 'a38a97fc-15ed-4649-9917-0e2d2c0a98a4';
const key = `assistant:mcp-oauth:${connectionId}`;

let root: ReturnType<typeof createRoot>;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('leaves sign-in hidden when the server does not advertise it', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ connectionId, signInAvailable: false, grant: 'none' })),
  );
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  expect(container.querySelector('button')).toBeNull();
});

it('checks the same attempt after returning and keeps an older authorization visible after denial', async () => {
  sessionStorage.setItem(key, flowId);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ connectionId, flowId, outcome: 'denied' }))
    .mockResolvedValueOnce(
      Response.json({ connectionId, signInAvailable: true, grant: 'authorized' }),
    );
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  expect(fetch.mock.calls[0]?.[0]).toBe(
    `/api/mobile/v1/mcp/${connectionId}/oauth/flow?flowId=${flowId}`,
  );
  expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET']);
  expect(container.textContent).toContain('The service did not grant access');
  expect(container.textContent).toContain('Tool sign-in authorized');
  expect(container.textContent).not.toContain('Sign-in confirmed');
  expect(sessionStorage.getItem(key)).toBeNull();
});

it('leaves the attempt recoverable when readback returns a different flow ID', async () => {
  sessionStorage.setItem(key, flowId);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ connectionId, flowId: connectionId, outcome: 'authorized' }),
    );
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Check sign-in status');
  expect(container.textContent).not.toContain('Sign-in confirmed');
  expect(sessionStorage.getItem(key)).toBe(flowId);
});

it('offers sign-in only after explicit provider verification', async () => {
  const status = { connectionId, signInAvailable: true, grant: 'none' };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(Response.json({ ...status, providerAvailable: true }));
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  expect(container.textContent).not.toContain('Sign in to this service');
  expect(fetch).toHaveBeenCalledTimes(1);
  const check = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Check browser sign-in',
  );
  expect(check).toBeDefined();
  await act(async () => check?.click());
  expect(fetch.mock.calls[1]?.[0]).toBe(`/api/mobile/v1/mcp/${connectionId}/oauth?verify=provider`);
  expect(container.textContent).toContain('Sign in to this service');
});

it.each([
  [flowId, true],
  [connectionId, false],
])(
  'confirms a completed attempt only when the canonical grant generation is %s',
  async (grantGeneration, confirmed) => {
    sessionStorage.setItem(key, flowId);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ connectionId, flowId, outcome: 'authorized' }))
        .mockResolvedValueOnce(
          Response.json({
            connectionId,
            signInAvailable: true,
            grant: 'authorized',
            grantGeneration,
          }),
        ),
    );
    await act(async () =>
      root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
    );
    expect(container.textContent?.includes('Sign-in confirmed')).toBe(confirmed);
    expect(container.textContent?.includes('Couldn’t confirm the change')).toBe(!confirmed);
  },
);

const statusPath = `/api/mobile/v1/mcp/${connectionId}/oauth`;
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (node) =>
      (node.querySelector('[aria-live="polite"]')?.textContent ?? node.textContent) === label,
  );

it.each(['network', 'http503'] as const)(
  'recovers an initial %s status failure through an explicit read-only retry',
  async (failure) => {
    const fetch = vi.fn();
    if (failure === 'network') fetch.mockRejectedValueOnce(new TypeError('Synthetic offline'));
    else fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetch.mockResolvedValueOnce(
      Response.json({ connectionId, signInAvailable: true, grant: 'authorized' }),
    );
    vi.stubGlobal('fetch', fetch);
    await act(async () =>
      root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
    );
    expect(container.textContent).toContain('Couldn’t load the saved sign-in status. Try again.');
    expect(button('Check sign-in status')).toBeDefined();
    expect(button('Sign in to this service')).toBeUndefined();
    expect(button('Reconnect sign-in')).toBeUndefined();
    expect(button('Disconnect sign-in')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => button('Check sign-in status')?.click());
    expect(container.textContent).toContain('Tool sign-in authorized');
    expect(button('Disconnect sign-in')).toBeDefined();
    expect(button('Check sign-in status')).toBeUndefined();
    expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      [statusPath, 'GET'],
      [statusPath, 'GET'],
    ]);
  },
);

it('hides canonical unavailable-none after a recovery read and never probes its provider', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Synthetic offline'))
    .mockResolvedValueOnce(Response.json({ connectionId, signInAvailable: false, grant: 'none' }));
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  await act(async () => button('Check sign-in status')?.click());
  expect(container.querySelector('button')).toBeNull();
  expect(container.textContent).toBe('');
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
    [statusPath, 'GET'],
    [statusPath, 'GET'],
  ]);
});

it('recovers reconnectable status without starting consent or probing until the owner explicitly checks', async () => {
  const status = { connectionId, signInAvailable: true, grant: 'reauthorization_required' };
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Synthetic offline'))
    .mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(Response.json({ ...status, providerAvailable: true }));
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  await act(async () => button('Check sign-in status')?.click());
  expect(container.textContent).toContain('Tool sign-in needs attention');
  expect(button('Check browser sign-in')).toBeDefined();
  expect(button('Reconnect sign-in')).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => button('Check browser sign-in')?.click());
  expect(button('Reconnect sign-in')).toBeDefined();
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
    [statusPath, 'GET'],
    [statusPath, 'GET'],
    [`${statusPath}?verify=provider`, 'GET'],
  ]);
});

it('reconciles an expired attempt and confirms disconnect only after canonical none readback', async () => {
  sessionStorage.setItem(key, flowId);
  const authorized = { connectionId, signInAvailable: true, grant: 'authorized' };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ connectionId, flowId, outcome: 'expired' }))
    .mockResolvedValueOnce(Response.json(authorized))
    .mockResolvedValueOnce(Response.json({ ...authorized, grant: 'none' }))
    .mockResolvedValueOnce(Response.json({ ...authorized, grant: 'none' }));
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  expect(container.textContent).toContain('This sign-in attempt expired');
  expect(container.textContent).toContain('Tool sign-in authorized');
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => button('Disconnect sign-in')?.click());
  expect(button('Confirm disconnect')).toBeDefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => button('Confirm disconnect')?.click());
  expect(container.textContent).toContain('Tool sign-in disconnected.');
  expect(container.textContent).not.toContain('Tool sign-in authorized');
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
    [`${statusPath}/flow?flowId=${flowId}`, 'GET'],
    [statusPath, 'GET'],
    [statusPath, 'DELETE'],
    [statusPath, 'GET'],
  ]);
});

it('does not confirm or repeat disconnect when canonical readback fails, and recovers with GET only', async () => {
  const authorized = { connectionId, signInAvailable: true, grant: 'authorized' };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(authorized))
    .mockResolvedValueOnce(Response.json({ ...authorized, grant: 'none' }))
    .mockRejectedValueOnce(new TypeError('Synthetic readback failure'))
    .mockResolvedValueOnce(Response.json({ ...authorized, grant: 'none' }));
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  await act(async () => button('Disconnect sign-in')?.click());
  await act(async () => button('Confirm disconnect')?.click());
  expect(container.textContent).toContain('Couldn’t confirm the change');
  expect(container.textContent).not.toContain('Tool sign-in disconnected.');
  expect(button('Check sign-in status')).toBeDefined();
  expect(button('Disconnect sign-in')?.disabled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => button('Check sign-in status')?.click());
  expect(container.textContent).not.toContain('Tool sign-in authorized');
  expect(button('Disconnect sign-in')).toBeUndefined();
  expect(button('Check sign-in status')).toBeUndefined();
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
    [statusPath, 'GET'],
    [statusPath, 'DELETE'],
    [statusPath, 'GET'],
    [statusPath, 'GET'],
  ]);
});

it('keeps repeated status-read failures recoverable without implying a mutation or retrying automatically', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Synthetic offline'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({ connectionId, signInAvailable: true, grant: 'authorized' }),
    );
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={false} />),
  );
  await act(async () => button('Check sign-in status')?.click());
  expect(container.textContent).toContain('Couldn’t load the saved sign-in status. Try again.');
  expect(container.textContent).not.toContain('Couldn’t confirm the change');
  expect(button('Check sign-in status')).toBeDefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => button('Check sign-in status')?.click());
  expect(container.textContent).toContain('Tool sign-in authorized');
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
    [statusPath, 'GET'],
    [statusPath, 'GET'],
    [statusPath, 'GET'],
  ]);
});

it('retains the parent disabled gate on status recovery', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Synthetic offline'));
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<McpOAuthControl connectionId={connectionId} disabled={true} />),
  );
  expect(button('Check sign-in status')?.disabled).toBe(true);
  await act(async () => button('Check sign-in status')?.click());
  expect(fetch).toHaveBeenCalledTimes(1);
});
