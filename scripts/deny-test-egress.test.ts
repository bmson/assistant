import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const preloader = fileURLToPath(new URL('./deny-test-egress.mjs', import.meta.url));

function runIsolated(script: string) {
  return spawnSync(process.execPath, ['--import', preloader, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS: '1' },
    timeout: 10_000,
  });
}

describe('test egress guard', () => {
  it('rejects direct external fetches before making a request', () => {
    const child = runIsolated(`
      try {
        await fetch('https://example.com');
        process.exitCode = 1;
      } catch (error) {
        process.exitCode = String(error).includes('External network access is disabled') ? 0 : 2;
      }
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  it('rejects a loopback fetch that redirects to an external host', () => {
    const child = runIsolated(`
      import http from 'node:http';
      const server = http.createServer((_request, response) => {
        response.writeHead(302, { location: 'https://example.com/redirected' });
        response.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await fetch('http://127.0.0.1:' + server.address().port);
        process.exitCode = 1;
      } catch (error) {
        process.exitCode = String(error).includes('External network access is disabled') ? 0 : 2;
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  it('allows omitted-host local sockets and blocks normalized external socket options', () => {
    const child = runIsolated(`
      import net from 'node:net';
      const server = net.createServer((socket) => socket.end('ok'));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection({ port: server.address().port });
          socket.once('data', resolve);
          socket.once('error', reject);
        });
        let blocked = false;
        try { net.createConnection({ port: 80, host: 'example.com' }); }
        catch (error) { blocked = String(error).includes('External network access is disabled'); }
        let blockedArray = false;
        try { new net.Socket().connect([80, 'example.com']); }
        catch (error) { blockedArray = String(error).includes('External network access is disabled'); }
        let blockedTls = false;
        try { (await import('node:tls')).connect({ port: 443, host: 'example.com' }); }
        catch (error) { blockedTls = String(error).includes('External network access is disabled'); }
        process.exitCode = blocked && blockedArray && blockedTls ? 0 : 1;
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
    expect(child.status, child.stderr).toBe(0);
  });
});
