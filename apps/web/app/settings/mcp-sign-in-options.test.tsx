// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkMcpSignInOptions,
  McpSignInOptions,
  type McpSignInOptionsResult,
  McpSignInOptionsResultView,
} from './mcp-sign-in-options';

const result = (
  status: McpSignInOptionsResult['status'],
  issuer?: string,
): McpSignInOptionsResult => ({
  status,
  authenticated: false,
  oauthConnectionSupported: false,
  transportProtocolVersion: '2025-11-25',
  resource: null,
  reason: null,
  authorizationServers: issuer
    ? [
        {
          issuer,
          pkceS256: true,
          authorizationResponseIssuerRequired: false,
          registration: {
            preRegistration: 'not_checked',
            clientIdMetadataDocument: false,
            dynamicClientRegistration: false,
          },
        },
      ]
    : [],
});

const connection = {
  id: 'connection-1',
  endpoint: 'https://tools.example.test/mcp',
  enabled: true,
  hasBearerToken: true,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('transient MCP sign-in options', () => {
  it('checks only on request, blocks duplicate checks, and makes no sign-in claim', async () => {
    let finish!: (result: McpSignInOptionsResult) => void;
    const check = vi.fn(
      () =>
        new Promise<McpSignInOptionsResult>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => root.render(<McpSignInOptions connection={connection} check={check} />));
    expect(check).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector('button')?.click();
      container.querySelector('button')?.click();
    });
    expect(check).toHaveBeenCalledExactlyOnceWith(connection.id);
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => finish(result('supported', 'https://auth.example.test/oauth')));
    expect(container.textContent).toContain('Sign-in setup found');
    expect(container.textContent).toContain('Checking setup doesn’t sign you in');
    expect(container.textContent).toContain('auth.example.test');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).not.toContain('Ready');
  });

  it('discards an in-flight result when the endpoint changes', async () => {
    let finish!: (result: McpSignInOptionsResult) => void;
    const check = () =>
      new Promise<McpSignInOptionsResult>((resolve) => {
        finish = resolve;
      });
    await act(async () => root.render(<McpSignInOptions connection={connection} check={check} />));
    await act(async () => container.querySelector('button')?.click());
    await act(async () =>
      root.render(
        <McpSignInOptions
          connection={{ ...connection, endpoint: 'https://other.example.test/mcp' }}
          check={check}
        />,
      ),
    );
    await act(async () => finish(result('supported', 'https://old-auth.example.test')));
    expect(container.textContent).not.toContain('old-auth');
    expect(container.textContent).not.toContain('Sign-in setup found');
    expect(container.querySelector('button')?.disabled).toBe(false);
  });

  it('clears a settled result when the saved authentication changes', async () => {
    const check = async () => result('unsupported');
    await act(async () => root.render(<McpSignInOptions connection={connection} check={check} />));
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('No supported sign-in setup found');
    await act(async () =>
      root.render(
        <McpSignInOptions connection={{ ...connection, hasBearerToken: false }} check={check} />,
      ),
    );
    expect(container.textContent).not.toContain('No supported sign-in setup found');
  });

  it('keeps failures transient and permits another explicit check', async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsafe provider detail'))
      .mockResolvedValueOnce(result('unsupported'));
    await act(async () => root.render(<McpSignInOptions connection={connection} check={check} />));
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('Couldn’t check sign-in options');
    expect(container.textContent).not.toContain('unsafe provider detail');
    await act(async () => container.querySelector('button')?.click());
    expect(check).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('No supported sign-in setup found');
  });

  it('does not expose credential-bearing metadata or turn metadata into a link', () => {
    const html = renderToStaticMarkup(
      <McpSignInOptionsResultView
        result={result('supported', 'https://user:secret@auth.example.test/oauth?code=private')}
      />,
    );
    expect(html).not.toContain('secret');
    expect(html).not.toContain('private');
    expect(html).not.toContain('<a');
    expect(html).toContain('Checking setup');
    const longHost = `${'very-long-host-'.repeat(10)}example.test`;
    const wrapped = renderToStaticMarkup(
      <McpSignInOptionsResultView result={result('supported', `https://${longHost}/oauth`)} />,
    );
    expect(wrapped).toContain(longHost);
    expect(wrapped).toContain('break-all');
  });
});

it('validates the response binding on the same-origin read', async () => {
  const body = { ...result('supported', 'https://auth.example.test'), connectionId: 'other' };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(body))
    .mockResolvedValueOnce(Response.json({ ...body, connectionId: connection.id }));
  vi.stubGlobal('fetch', fetch);
  await expect(checkMcpSignInOptions(connection.id)).rejects.toThrow('unverified');
  await expect(checkMcpSignInOptions(connection.id)).resolves.toMatchObject({
    status: 'supported',
  });
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/mobile/v1/mcp/connection-1/authorization',
    expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    }),
  );
});

it.each([404, 409, 503])('treats HTTP %s as a failed read', async (status) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: 'Private detail' }, { status })),
  );
  await expect(checkMcpSignInOptions(connection.id)).rejects.toThrow('Sign-in options unavailable');
});

it('does not restore the prior result after disabling and re-enabling a connection', async () => {
  const check = vi.fn().mockResolvedValue(result('supported', 'https://auth.example.test'));
  await act(async () => root.render(<McpSignInOptions connection={connection} check={check} />));
  await act(async () => container.querySelector('button')?.click());
  expect(container.textContent).toContain('Sign-in setup found');
  await act(async () =>
    root.render(<McpSignInOptions connection={{ ...connection, enabled: false }} check={check} />),
  );
  expect(container.querySelector('button')?.disabled).toBe(true);
  await act(async () => root.render(<McpSignInOptions connection={connection} check={check} />));
  expect(container.textContent).not.toContain('Sign-in setup found');
  expect(check).toHaveBeenCalledTimes(1);
});
