import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  boundedWeb17HttpLogText,
  projectWeb17HttpTransportObservations,
  WEB17_PREVIEW_LINE_CAP,
  WEB17_PREVIEW_LOG_BYTE_CAP,
} from './web17-preview-diagnostics.js';
import {
  createWeb17TransportDiagnostics,
  WEB17_TRANSPORT_EVENT_CAP,
} from './web17-transport-diagnostics.js';

const require = createRequire(import.meta.url);
const { installWeb17PreviewHttpObserver } = require('./web17-preview-http.cjs') as {
  installWeb17PreviewHttpObserver: (options: {
    Server: typeof FakeServer;
    token: string;
    writeRecord: (record: Record<string, unknown>) => void;
    env?: Record<string, string>;
  }) => boolean;
};
const token = 'a'.repeat(43);
const nonce = 'abcdefghijklmnopqrstuv';

class FakeServer {
  calls: unknown[][] = [];
  emit(...args: unknown[]): unknown {
    this.calls.push(args);
    return 'original-result';
  }
  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: 3001 };
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    url: '/chat/all?_rsc=private-query',
    headers: {
      rsc: '1',
      'x-web17-request-class': 'rsc',
      'x-web17-attempt': nonce,
      'x-web17-diagnostic-token': token,
    },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function install(
  records: Record<string, unknown>[],
  BaseServer: typeof FakeServer = FakeServer,
  env = { NODE_ENV: 'development', WEB_APP_PREVIEW_ENABLED: 'true' },
) {
  class TestServer extends BaseServer {}
  expect(
    installWeb17PreviewHttpObserver({
      Server: TestServer,
      token,
      writeRecord: (record) => records.push(record),
      env,
    }),
  ).toBe(true);
  return TestServer;
}

describe('WEB-17 local preview HTTP observer', () => {
  it.each([1, 2, 3])('bounds decoded tails beginning with %i replacement characters', (count) => {
    const cap = WEB17_PREVIEW_LOG_BYTE_CAP;
    const rawTail = Buffer.concat([Buffer.alloc(count, 0x80), Buffer.alloc(cap - count, 0x61)]);
    const input = rawTail.toString('utf8');
    expect(rawTail.length).toBe(cap);
    expect(Buffer.byteLength(input, 'utf8')).toBeGreaterThan(cap);
    const bounded = boundedWeb17HttpLogText(input);
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(cap);
    expect(bounded.text).toBe('\ufffd'.repeat(Math.floor(count / 3)) + 'a'.repeat(cap - count));
    expect(bounded.truncated).toBe(true);
  });

  it.each(
    ['a', 'ø', '界', '😀', '\ufffd'].flatMap((unit) =>
      ['', 'x', 'xx', 'xxx'].map((tail) => ({ unit, tail })),
    ),
  )('keeps complete code points for $unit with tail "$tail"', ({ unit, tail }) => {
    const cap = WEB17_PREVIEW_LOG_BYTE_CAP;
    const width = Buffer.byteLength(unit, 'utf8');
    const bounded = boundedWeb17HttpLogText(unit.repeat(Math.ceil(cap / width) + 2) + tail);
    expect(bounded.text).toBe(unit.repeat(Math.floor((cap - tail.length) / width)) + tail);
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(cap);
    expect(bounded.truncated).toBe(true);
  });

  it.each(['a', 'ø', '界', '😀'])('preserves exactly capped %s text without truncation', (unit) => {
    const cap = WEB17_PREVIEW_LOG_BYTE_CAP;
    const width = Buffer.byteLength(unit, 'utf8');
    const input = unit.repeat(Math.floor(cap / width)) + 'a'.repeat(cap % width);
    expect(boundedWeb17HttpLogText(input)).toEqual({ text: input, truncated: false });
  });

  it('forwards the exact event once with its original receiver, arguments and return', () => {
    const records: Record<string, unknown>[] = [];
    const Server = install(records);
    const server = new Server();
    const req = request();
    expect(
      installWeb17PreviewHttpObserver({
        Server,
        token,
        writeRecord: (record) => records.push(record),
        env: { NODE_ENV: 'development', WEB_APP_PREVIEW_ENABLED: 'true' },
      }),
    ).toBe(false);
    const response = {
      listeners: new Map<string, () => void>(),
      once(event: string, callback: () => void) {
        this.listeners.set(event, callback);
      },
      statusCode: 204,
      writableFinished: false,
    };
    const args = ['request', req, response];

    expect(server.emit(...args)).toBe('original-result');
    expect(server.calls).toEqual([args]);
    expect(records).toEqual([
      {
        kind: 'WEB17_HTTP_TRANSPORT',
        nonce,
        phase: 'node_request_dispatch',
        layer: 'node_local',
        duplicatePossible: true,
      },
    ]);
    response.listeners.get('finish')?.();
    response.listeners.get('close')?.();
    expect(records.slice(1).map((record) => record.phase)).toEqual([
      'node_response_finish',
      'node_response_close',
    ]);
    expect(JSON.stringify(records)).not.toMatch(/private-query|diagnostic-token|a{43}/);
  });

  it('preserves original throws and calls the original exactly once when observation fails', () => {
    const records: Record<string, unknown>[] = [];
    class ThrowingServer extends FakeServer {
      originalCalls = 0;
      emit(...args: unknown[]) {
        this.originalCalls += 1;
        this.calls.push(args);
        throw new Error('original failure');
      }
    }
    const Server = install(records, ThrowingServer);
    const server = new Server();
    expect(() =>
      server.emit('request', request(), {
        once: () => {
          throw Error('observer');
        },
      }),
    ).toThrow('original failure');
    expect((server as ThrowingServer).originalCalls).toBe(1);
  });

  it('swallows callback getter errors and keeps development-preview gates explicit', () => {
    const records: Record<string, unknown>[] = [];
    const Server = install(records);
    const server = new Server();
    const callbacks = new Map<string, () => void>();
    const throwingStatus = {
      once(event: string, listener: () => void) {
        callbacks.set(event, listener);
      },
      get statusCode(): number {
        throw new Error('untrusted getter');
      },
      get writableFinished(): boolean {
        throw new Error('untrusted getter');
      },
    };
    server.emit('request', request(), throwingStatus);
    expect(() => callbacks.get('finish')?.()).not.toThrow();
    expect(() => callbacks.get('close')?.()).not.toThrow();

    const disabledRecords: Record<string, unknown>[] = [];
    const DisabledServer = install(disabledRecords, FakeServer, {
      NODE_ENV: 'production',
      WEB_APP_PREVIEW_ENABLED: 'false',
    });
    new DisabledServer().emit('request', request(), { once() {} });
    expect(disabledRecords).toEqual([]);
  });

  it('ignores non-preview, non-loopback, non-RSC, invalid-token and over-cap nonce candidates', () => {
    const records: Record<string, unknown>[] = [];
    const Server = install(records);
    const server = new Server();
    const cases = [
      request({ url: '/chat/private?_rsc=x' }),
      request({ headers: { ...request().headers, rsc: '0' } }),
      request({
        headers: { ...request().headers, 'x-web17-diagnostic-token': 'x'.repeat(100_000) },
      }),
      request({ socket: { remoteAddress: '203.0.113.2' } }),
    ];
    for (const candidate of cases) server.emit('request', candidate, { once() {} });
    expect(records).toEqual([]);
    expect(server.calls).toHaveLength(cases.length);
  });

  it('bounds the merged observation at the shared transport event cap and labels overflow incomplete', () => {
    const lines = Array.from(
      { length: 50 },
      () =>
        `[WEB17_HTTP] ${JSON.stringify({
          kind: 'WEB17_HTTP_TRANSPORT',
          nonce,
          phase: 'node_request_dispatch',
          layer: 'node_local',
          duplicatePossible: true,
        })}`,
    );
    const projected = projectWeb17HttpTransportObservations(lines.join('\n'), nonce);
    expect(projected.events).toHaveLength(WEB17_TRANSPORT_EVENT_CAP);
    expect(projected.status).toBe('incomplete');
    const transport = createWeb17TransportDiagnostics(() => 0);
    transport.selectNonce(nonce);
    transport.importNodeObservations(projected.events, projected.status);
    transport.seal('passed');
    expect(transport.snapshot().events.length).toBeLessThanOrEqual(WEB17_TRANSPORT_EVENT_CAP);
    expect(Buffer.byteLength(JSON.stringify(transport.snapshot()), 'utf8')).toBeLessThanOrEqual(
      8_192,
    );
    expect(transport.snapshot().nodeObservationStatus).toBe('incomplete');
    expect(lines.length).toBeLessThanOrEqual(WEB17_PREVIEW_LINE_CAP);

    const otherNonce = 'zzzzzzzzzzzzzzzzzzzzzz';
    const interleaved = Array.from(
      { length: WEB17_TRANSPORT_EVENT_CAP },
      () =>
        `[WEB17_HTTP] ${JSON.stringify({
          kind: 'WEB17_HTTP_TRANSPORT',
          nonce: otherNonce,
          phase: 'node_request_dispatch',
          layer: 'node_local',
          duplicatePossible: true,
        })}`,
    );
    interleaved.push(lines[0] ?? '');
    const selectedBelowCap = projectWeb17HttpTransportObservations(interleaved.join('\n'), nonce);
    expect(selectedBelowCap.events).toHaveLength(1);
    expect(selectedBelowCap.status).toBe('incomplete');
  });

  it('keeps only two nonce candidates and stops installing callbacks at the local cap', () => {
    const records: Record<string, unknown>[] = [];
    const Server = install(records);
    const server = new Server();
    server.emit('request', request(), { once() {} });
    server.emit(
      'request',
      request({
        headers: { ...request().headers, 'x-web17-attempt': 'zzzzzzzzzzzzzzzzzzzzzz' },
      }),
      { once() {} },
    );
    server.emit(
      'request',
      request({
        headers: { ...request().headers, 'x-web17-attempt': 'yyyyyyyyyyyyyyyyyyyyyy' },
      }),
      { once() {} },
    );
    expect(records).toHaveLength(2);

    const capRecords: Record<string, unknown>[] = [];
    const CapServer = install(capRecords);
    const cappedServer = new CapServer();
    const responses = Array.from({ length: WEB17_TRANSPORT_EVENT_CAP + 1 }, () => ({
      listeners: 0,
      once() {
        this.listeners += 1;
      },
    }));
    for (const response of responses) cappedServer.emit('request', request(), response);
    expect(capRecords).toHaveLength(WEB17_TRANSPORT_EVENT_CAP);
    expect(responses[WEB17_TRANSPORT_EVENT_CAP - 1]?.listeners).toBe(0);
    expect(responses[WEB17_TRANSPORT_EVENT_CAP]?.listeners).toBe(0);
  });

  it('projects only exact selected-nonce records and treats missing or truncated input as unknown', () => {
    const safe = {
      kind: 'WEB17_HTTP_TRANSPORT',
      nonce,
      phase: 'node_response_close',
      layer: 'node_local',
      duplicatePossible: true,
      writableFinished: false,
    };
    const unrelated = { ...safe, nonce: 'zzzzzzzzzzzzzzzzzzzzzz' };
    expect(
      projectWeb17HttpTransportObservations(`[WEB17_HTTP] ${JSON.stringify(safe)}`, nonce),
    ).toEqual({
      status: 'observed',
      events: [{ nonce, phase: 'node_response_close', writableFinished: false }],
    });
    expect(
      projectWeb17HttpTransportObservations(`[WEB17_HTTP] ${JSON.stringify(unrelated)}`, nonce),
    ).toEqual({
      status: 'unavailable',
      events: [],
    });
    expect(projectWeb17HttpTransportObservations(undefined, nonce).status).toBe('unavailable');
    expect(
      projectWeb17HttpTransportObservations(`[WEB17_HTTP] ${JSON.stringify(safe)}`, nonce, true)
        .status,
    ).toBe('incomplete');
  });

  it('marks byte and line cap truncation incomplete without retaining source text', () => {
    const oversized = projectWeb17HttpTransportObservations(`${'x'.repeat(70_000)}\n`, nonce);
    const oversizedUnicode = projectWeb17HttpTransportObservations(
      `${'ø'.repeat(40_000)}\n`,
      nonce,
    );
    const overLineCap = projectWeb17HttpTransportObservations(
      Array.from({ length: WEB17_PREVIEW_LINE_CAP + 1 }, () => 'unrelated').join('\n'),
      nonce,
    );
    expect(oversized).toEqual({ status: 'incomplete', events: [] });
    expect(oversizedUnicode).toEqual({ status: 'incomplete', events: [] });
    expect(overLineCap).toEqual({ status: 'incomplete', events: [] });
    expect(JSON.stringify([oversized, overLineCap])).not.toContain('unrelated');
  });
});
