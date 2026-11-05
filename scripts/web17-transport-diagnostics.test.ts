import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createWeb17NavigationDiagnostics,
  WEB17_NAVIGATION_DIAGNOSTIC_CAP,
} from './web17-navigation-diagnostics.js';
import {
  createWeb17TransportDiagnostics,
  observeWeb17Safely,
  projectWeb17BrowserError,
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
    expect(trace.snapshot()).toMatchObject({
      result: 'failed',
      serverTransport: 'NOT_INSTRUMENTED',
    });
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
      {
        sequence: 1,
        nonce,
        phase: 'continue_rejected',
        scenarioElapsedMs: 0,
        sinceClickMs: null,
        sinceRequestMs: null,
      },
    ]);
  });
  it('caps all observations and serialized output', () => {
    const trace = createWeb17TransportDiagnostics(() => 0);
    trace.selectNonce(nonce);
    for (let index = 0; index < 200; index++)
      trace.record(nonce, 'sizes_observed', { responseBodyBytes: 1_000_000_000 });
    for (let index = 0; index < 9; index++)
      trace.recordBrowserError('console', 'TypeError: private');
    trace.seal('failed');
    expect(trace.snapshot().overflow).toBe(true);
    expect(trace.snapshot().events.length).toBeLessThanOrEqual(WEB17_TRANSPORT_EVENT_CAP);
    expect(Buffer.byteLength(JSON.stringify(trace.snapshot()))).toBeLessThanOrEqual(
      WEB17_TRANSPORT_BYTE_CAP,
    );
  });
});

describe('WEB17 diagnostic origins and privacy', () => {
  it('uses the actual click and request event rather than route interception as origins', () => {
    let clock = 10;
    const trace = createWeb17TransportDiagnostics(() => clock);
    clock = 100;
    trace.markClickAttempted();
    clock = 130; // Route interception is later than the captured request event.
    trace.selectNonce(nonce);
    trace.recordRequestStart(nonce, 110);
    trace.record(nonce, 'continue_resolved');
    expect(trace.snapshot().events).toEqual([
      {
        sequence: 1,
        nonce,
        phase: 'request_started',
        scenarioElapsedMs: 100,
        sinceClickMs: 10,
        sinceRequestMs: 0,
      },
      {
        sequence: 2,
        nonce,
        phase: 'continue_resolved',
        scenarioElapsedMs: 120,
        sinceClickMs: 30,
        sinceRequestMs: 20,
      },
    ]);
    trace.record(nonce, 'response_headers', { status: 200 });
    expect(trace.snapshot().events.some((event) => event.phase === 'response_body_finished')).toBe(
      false,
    );
  });
  it('keeps missing request observations explicit without inventing an interception origin', () => {
    const trace = createWeb17TransportDiagnostics(() => 100);
    trace.markClickAttempted();
    trace.selectNonce(nonce);
    trace.recordRequestStart(nonce, undefined);
    trace.record(nonce, 'continue_resolved');
    expect(trace.snapshot().requestStartObservation).toBe('unavailable');
    expect(trace.snapshot().events[0]).toMatchObject({ sinceRequestMs: null, sinceClickMs: 0 });
    trace.seal('failed');
    expect(trace.snapshot()).toMatchObject({
      remountAssertions: 'NOT_RUN',
      serverTransport: 'NOT_INSTRUMENTED',
    });
  });
  it('does not let an observer or a broken clock throw into browser flow', () => {
    expect(() =>
      observeWeb17Safely(() => {
        throw new Error('private');
      }),
    ).not.toThrow();
    const trace = createWeb17TransportDiagnostics(() => {
      throw new Error('clock');
    });
    trace.markClickAttempted();
    trace.selectNonce(nonce);
    trace.record(nonce, 'continue_resolved');
    expect(trace.snapshot().events[0]).toMatchObject({
      scenarioElapsedMs: null,
      sinceClickMs: null,
      sinceRequestMs: null,
    });
  });
  it('projects only fixed classes and allowlisted locations without private text', () => {
    const raw =
      'TypeError: secret@example.test token=private\n at https://private.test/_next/static/chunks/secret.js:12:34)';
    expect(projectWeb17BrowserError('pageerror', raw)).toEqual({
      source: 'pageerror',
      errorClass: 'TypeError',
      location: 'next_static',
      line: 12,
      column: 34,
    });
    expect(projectWeb17BrowserError('console', 'private /unknown/private.ts:2:4)')).toEqual({
      source: 'console',
      errorClass: 'other',
      location: 'unavailable',
      line: null,
      column: null,
    });
    expect(JSON.stringify(projectWeb17BrowserError('pageerror', raw))).not.toMatch(
      /secret|private|token|https|chunks/,
    );
  });
  it('caps browser errors at eight within the shared byte cap and freezes before cleanup', () => {
    const trace = createWeb17TransportDiagnostics(() => 0);
    for (let index = 0; index < 9; index++) trace.recordBrowserError('console', 'Error: private');
    expect(trace.snapshot().browserErrors).toHaveLength(8);
    expect(trace.snapshot().overflow).toBe(true);
    trace.markRemountAssertionsStarted();
    trace.seal('failed');
    const frozen = JSON.stringify(trace.snapshot());
    trace.recordBrowserError('pageerror', 'TypeError');
    trace.markClickAttempted();
    trace.recordRequestStart(nonce, 0);
    trace.markRemountAssertionsStarted();
    expect(JSON.stringify(trace.snapshot())).toBe(frozen);
    expect(trace.snapshot().remountAssertions).toBe('STARTED');
    expect(Buffer.byteLength(frozen)).toBeLessThanOrEqual(WEB17_TRANSPORT_BYTE_CAP);
  });
  it('never accesses response bodies or console argument values in the added diagnostics', () => {
    const source = readFileSync(
      new URL('./web17-delayed-old-poll.browser.ts', import.meta.url),
      'utf8',
    );
    expect(source.indexOf('const onPageError')).toBeGreaterThan(
      source.indexOf('async function verifyUnmountedPollDoesNotPublishAfterRemount'),
    );
    const observer = source.slice(
      source.indexOf('function observeAllChatsNavigation'),
      source.indexOf('async function verifyUnmountedPoll'),
    );
    expect(observer).not.toMatch(/response\.(?:body|text|json)\(/);
    const errors = source.slice(
      source.indexOf('const onPageError'),
      source.indexOf('browserErrorObserverInstalled = true', source.indexOf('const onPageError')),
    );
    expect(errors).not.toMatch(/\.args\(|jsonValue\(|\.location\(/);
  });
});
