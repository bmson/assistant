import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRestoreNetworkFence } from './restore-network-fence.js';

describe('restore rehearsal network fence', () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.unstubAllGlobals();
  });

  it('blocks direct external fetches and external redirects before following them', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://provider.example.test/' },
        }),
    );
    vi.stubGlobal('fetch', fakeFetch);
    uninstall = installRestoreNetworkFence();

    await expect(fetch('https://provider.example.test/')).rejects.toThrow(
      'External network access is disabled during restore rehearsal',
    );
    expect(fakeFetch).not.toHaveBeenCalled();
    await expect(fetch('http://127.0.0.1:8787/')).rejects.toThrow(
      'External network access is disabled during restore rehearsal',
    );
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('rejects external TCP and UDP destinations before opening sockets', () => {
    uninstall = installRestoreNetworkFence();
    const stream = new net.Socket();
    const datagram = dgram.createSocket('udp4');
    expect(() => stream.connect({ host: '203.0.113.10', port: 443 })).toThrow(
      'External network access is disabled during restore rehearsal',
    );
    expect(() => tls.connect({ host: '203.0.113.10', port: 443 })).toThrow(
      'External network access is disabled during restore rehearsal',
    );
    expect(() => datagram.connect(53, '203.0.113.10')).toThrow(
      'External network access is disabled during restore rehearsal',
    );
    stream.destroy();
  });
});
