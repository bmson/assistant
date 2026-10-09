import dgram from 'node:dgram';
import net, { isIP } from 'node:net';
import tls from 'node:tls';

function normalizedAddress(address: string | undefined): string {
  return String(address ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/, '');
}

function isLoopback(address: string | undefined): boolean {
  const host = normalizedAddress(address);
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

function assertLoopback(address: string | undefined): void {
  if (!isLoopback(address))
    throw new Error('External network access is disabled during restore rehearsal');
}

/** Defense in depth for the Node agent process; the host still needs egress policy. */
export function installRestoreNetworkFence() {
  const originalFetch = globalThis.fetch;
  const originalSocketConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalDgramConnect = dgram.Socket.prototype.connect;
  const originalDgramSend = dgram.Socket.prototype.send;

  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    if (url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
    assertLoopback(url.hostname);
    const request = input instanceof Request ? new Request(url, input) : url;
    const response = await originalFetch(request, { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    if (location && [301, 302, 303, 307, 308].includes(response.status))
      assertLoopback(new URL(location, url).hostname);
    return response;
  };

  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const [raw, ...rest] = args;
    if (typeof raw === 'number') {
      const host = typeof rest[0] === 'string' ? rest[0] : '127.0.0.1';
      assertLoopback(host);
      if (rest.length === 0) args.splice(1, 0, host);
    }
    if (Array.isArray(raw) && typeof raw[0] === 'number' && typeof raw[1] === 'string')
      assertLoopback(raw[1]);
    const candidates = Array.isArray(raw) ? raw : [raw];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const row = candidate as {
        path?: unknown;
        host?: string;
        hostname?: string;
        lookup?: unknown;
      };
      if (row.path) continue;
      const host = row.host ?? row.hostname ?? 'localhost';
      if (host.toLowerCase() === 'localhost') {
        row.host = '127.0.0.1';
        delete row.hostname;
        delete row.lookup;
      } else assertLoopback(host);
    }
    return (originalSocketConnect as unknown as (...args: unknown[]) => net.Socket).apply(
      this,
      args,
    );
  } as typeof net.Socket.prototype.connect;

  tls.connect = function (this: typeof tls, ...args: unknown[]) {
    const [raw] = args;
    if (raw && typeof raw === 'object') {
      const row = raw as { host?: string; hostname?: string; servername?: string };
      const host = row.host ?? row.hostname ?? row.servername ?? 'localhost';
      if (host.toLowerCase() === 'localhost') row.host = '127.0.0.1';
      else assertLoopback(host);
      if (row.servername) assertLoopback(row.servername);
    }
    return (originalTlsConnect as unknown as (...args: unknown[]) => tls.TLSSocket).apply(
      this,
      args,
    );
  } as typeof tls.connect;

  const connectedLocally = new WeakSet<dgram.Socket>();
  dgram.Socket.prototype.connect = function (
    this: dgram.Socket,
    port: number,
    addressOrCallback?: string | (() => void),
    callback?: () => void,
  ) {
    let address = typeof addressOrCallback === 'string' ? addressOrCallback : '127.0.0.1';
    if (address.toLowerCase() === 'localhost') address = '127.0.0.1';
    assertLoopback(address);
    connectedLocally.add(this);
    return (originalDgramConnect as unknown as (...args: unknown[]) => void).apply(this, [
      port,
      ...(addressOrCallback === undefined
        ? []
        : [typeof addressOrCallback === 'string' ? address : addressOrCallback]),
      ...(callback ? [callback] : []),
    ]);
  };
  dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: unknown[]) {
    if (!connectedLocally.has(this)) {
      const portIndex = args.findIndex((value) => typeof value === 'number');
      const address = portIndex >= 0 ? args[portIndex + 1] : undefined;
      if (typeof address === 'string' && address.toLowerCase() === 'localhost')
        args[portIndex + 1] = '127.0.0.1';
      assertLoopback(typeof address === 'string' ? address : undefined);
    }
    return (originalDgramSend as unknown as (...args: unknown[]) => void).apply(this, args);
  };

  return () => {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalSocketConnect;
    tls.connect = originalTlsConnect;
    dgram.Socket.prototype.connect = originalDgramConnect;
    dgram.Socket.prototype.send = originalDgramSend;
  };
}
