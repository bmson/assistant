import { describe, expect, it } from 'vitest';
import {
  createWeb17NavigationDiagnostics,
  WEB17_NAVIGATION_DIAGNOSTIC_CAP,
} from './web17-navigation-diagnostics.js';
import {
  createWeb17TransportDiagnostics,
  selectWeb17TransportCandidate,
  WEB17_TRANSPORT_BYTE_CAP,
  WEB17_TRANSPORT_EVENT_CAP,
} from './web17-transport-diagnostics.js';

const nonce = 'abcdefghijklmnopqrstuv';
describe('bounded WEB17 transport observations', () => {
  it('still selects the post-click candidate when navigation attempt admission is saturated', () => {
    const navigation = createWeb17NavigationDiagnostics('http://127.0.0.1:3001');
    navigation.setObserverAvailable(true);
    for (let index = 0; index < WEB17_NAVIGATION_DIAGNOSTIC_CAP; index++)
      expect(
        navigation.recordRscAttemptStarted(
          `abcdefghijklmnopqrst${String(index).padStart(2, '0')}`,
          true,
        ),
      ).toBe(true);
    navigation.markClickAttempted();
    expect(navigation.recordRscAttemptStarted(nonce, false)).toBe(false);
    const trace = createWeb17TransportDiagnostics(() => 0);
    expect(
      selectWeb17TransportCandidate(trace, {
        nonce,
        prefetch: false,
        clickAttempted: navigation.snapshot().clickAttempted,
      }),
    ).toBe(true);
    trace.record(nonce, 'continue_started', { nonceHeaderInjected: false });
    expect(trace.snapshot().events).toHaveLength(1);
    expect(trace.snapshot().events[0]?.nonceHeaderInjected).toBe(false);
  });
  it('reserves the cap for one selected post-click candidate rather than earlier requests', () => {
    const trace = createWeb17TransportDiagnostics(() => 0);
    const earlier = 'xxxxxxxxxxxxxxxxxxxxxx';
    for (let index = 0; index < 100; index++)
      trace.record(earlier, 'response_headers', { status: 200 });
    expect(trace.selectNonce(nonce)).toBe(true);
    expect(trace.selectNonce(earlier)).toBe(false);
    trace.record(earlier, 'request_finished');
    trace.record(nonce, 'continue_started');
    expect(trace.snapshot().overflow).toBe(false);
    expect(trace.snapshot().events).toHaveLength(1);
    expect(trace.snapshot().selectedNonce).toBe(nonce);
  });
  it('does not equate continuation, response headers or data preparation with a finished body', () => {
    let clock = 0;
    const trace = createWeb17TransportDiagnostics(() => clock);
    trace.selectNonce(nonce);
    trace.record(nonce, 'continue_started');
    clock = 4;
    trace.record(nonce, 'continue_resolved');
    clock = 9;
    trace.record(nonce, 'response_headers', { status: 200 });
    trace.seal('failed');
    expect(trace.snapshot()).toMatchObject({ result: 'failed', serverTransport: 'not_observed' });
    expect(trace.snapshot().events.map((event) => event.phase)).toEqual([
      'continue_started',
      'continue_resolved',
      'response_headers',
    ]);
  });
  it('freezes before cleanup and keeps observed terminal byte metadata separate', () => {
    const trace = createWeb17TransportDiagnostics(() => 0);
    trace.selectNonce(nonce);
    trace.record(nonce, 'request_finished');
    trace.record(nonce, 'sizes_observed', { responseBodyBytes: 537 });
    trace.seal('passed');
    trace.record(nonce, 'request_failed');
    const snapshot = trace.snapshot();
    snapshot.events[0]!.phase = 'continue_rejected';
    expect(trace.snapshot().events[0]?.phase).toBe('request_finished');
    expect(trace.snapshot().events).toHaveLength(2);
    expect(trace.snapshot().events[1]?.responseBodyBytes).toBe(537);
  });
  it('accepts no private strings, arbitrary identifiers or invalid numeric metadata', () => {
    const trace = createWeb17TransportDiagnostics(() => 0);
    trace.selectNonce(nonce);
    trace.record('private-owner-email@example.test', 'headers_failed');
    trace.record(nonce, 'continue_rejected', {
      status: 999,
      responseBodyBytes: -1,
      url: 'https://private.test/secret',
      headers: { authorization: 'secret' },
      error: 'secret',
    } as never);
    const output = JSON.stringify(trace.snapshot());
    expect(output).not.toMatch(/secret|private|authorization|999/);
    expect(trace.snapshot().events).toEqual([
      { sequence: 1, nonce, phase: 'continue_rejected', elapsedMs: 0 },
    ]);
  });
  it('caps all observations and serialized output', () => {
    const trace = createWeb17TransportDiagnostics(() => 0);
    trace.selectNonce(nonce);
    for (let index = 0; index < 200; index++)
      trace.record(nonce, 'sizes_observed', { responseBodyBytes: 1_000_000_000 });
    trace.seal('failed');
    expect(trace.snapshot().overflow).toBe(true);
    expect(trace.snapshot().events.length).toBeLessThanOrEqual(WEB17_TRANSPORT_EVENT_CAP);
    expect(Buffer.byteLength(JSON.stringify(trace.snapshot()))).toBeLessThanOrEqual(
      WEB17_TRANSPORT_BYTE_CAP,
    );
  });
});
