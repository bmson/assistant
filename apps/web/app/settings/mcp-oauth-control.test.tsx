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
