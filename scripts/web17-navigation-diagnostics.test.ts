import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  classifyWeb17Path,
  createWeb17NavigationDiagnostics,
  observeWeb17AllChatsLinks,
  projectWeb17NavigationDiagnostics,
  WEB17_NAVIGATION_DIAGNOSTIC_CAP,
} from './web17-navigation-diagnostics.js';

describe('bounded WEB-17 navigation diagnostics', () => {
  const origin = 'https://assistant.example.test';
  const fixturePath = '/chat/synthetic-fixture';

  it('observes exactly one matching link without returning href text or waiting for it', () => {
    const link = (href: string | null) => ({ getAttribute: () => href });
    expect(observeWeb17AllChatsLinks([link('/chat/all')], origin)).toEqual({
      count: 1,
      matches: true,
    });
    expect(
      observeWeb17AllChatsLinks(
        [link('https://assistant.example.test/chat/all?private=q')],
        origin,
      ),
    ).toEqual({ count: 1, matches: true });
    expect(
      observeWeb17AllChatsLinks([link('https://other.example.test/chat/all')], origin),
    ).toEqual({
      count: 1,
      matches: false,
    });
    expect(observeWeb17AllChatsLinks([link('/chat/private-id')], origin)).toEqual({
      count: 1,
      matches: false,
    });
    expect(observeWeb17AllChatsLinks([], origin)).toEqual({ count: 0, matches: null });
    expect(observeWeb17AllChatsLinks([link(`/chat/all?${'x'.repeat(2_100)}`)], origin)).toEqual({
      count: 1,
      matches: null,
    });
    expect(
      classifyWeb17Path(`https://assistant.example.test${fixturePath}`, origin, fixturePath),
    ).toBe('fixture_chat');
    expect(
      classifyWeb17Path('https://assistant.example.test/chat/private-id', origin, fixturePath),
    ).toBe('other_same_origin');
    expect(classifyWeb17Path('https://other.example.test/chat/all', origin, fixturePath)).toBe(
      'off_origin',
    );
    expect(classifyWeb17Path('not a url', origin, fixturePath)).toBe('unknown');
  });

  it('can be serialized as a Playwright callback without module-scope dependencies', () => {
    const result = runInNewContext(`(${observeWeb17AllChatsLinks.toString()})(elements, origin)`, {
      URL,
      elements: [{ getAttribute: () => '/chat/all' }],
      origin,
    });
    expect(JSON.stringify(result)).toBe('{"count":1,"matches":true}');
  });

  it('records only capped document, RSC and other route event/status classes', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setFixtureChatPath(fixturePath);
    diagnostics.setObserverAvailable(true);
    diagnostics.setAllChatsLinkObservation(1, true);
    diagnostics.markClickAttempted();
    diagnostics.setClickCompleted(true);

    diagnostics.recordMainFrameNavigation('https://assistant.example.test/chat/all');
    diagnostics.recordRequestStarted('https://assistant.example.test/chat/all', 'document', true);
    diagnostics.recordResponse('https://assistant.example.test/chat/all', 'document', true, 200);
    diagnostics.recordRequestFinished('https://assistant.example.test/chat/all', 'document', true);

    const query = 'private-query-sentinel';
    const rscUrl = `https://assistant.example.test/chat/all?_rsc=${query}`;
    diagnostics.recordRequestStarted(rscUrl, 'fetch', false);
    diagnostics.recordResponse(rscUrl, 'fetch', false, 503);
    diagnostics.recordRequestFailed(rscUrl, 'fetch', false, 'net::ERR_TIMED_OUT');

    diagnostics.recordRequestStarted('https://assistant.example.test/chat/all', 'fetch', false);
    diagnostics.recordResponse('https://assistant.example.test/chat/all', 'fetch', false, 302);
    diagnostics.recordRequestFailed(
      'https://assistant.example.test/chat/all',
      'fetch',
      false,
      `private-error-sentinel ${'x'.repeat(200)}`,
    );
    diagnostics.setPageErrorCount(1);
    diagnostics.finalizeExpectedRouteObservation();

    const snapshot = diagnostics.snapshot();
    expect(snapshot.observerAvailable).toBe(true);
    expect(projectWeb17NavigationDiagnostics(snapshot)).toEqual(snapshot);
    expect(snapshot.mainFrameExpectedRouteCommitted).toBe(true);
    expect(snapshot.mainFrameTransitions).toMatchObject({ all_chats: 1 });
    expect(snapshot.requests?.document).toMatchObject({
      started: 1,
      finished: 1,
      responseStatus: { success: 1 },
    });
    expect(snapshot.requests?.rsc).toMatchObject({
      started: 1,
      failed: 1,
      responseStatus: { server_error: 1 },
      requestFailure: { timeout: 1 },
    });
    expect(snapshot.requests?.other).toMatchObject({
      started: 1,
      failed: 1,
      responseStatus: { redirect: 1 },
      requestFailure: { other: 1 },
    });
    expect(snapshot.pageErrorCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain(query);
    expect(JSON.stringify(snapshot)).not.toContain('private-error-sentinel');
    expect(JSON.stringify(snapshot)).not.toContain('/chat/all');
  });

  it('saturates fixed counters with overflow and keeps unobserved navigation facts unknown', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setFixtureChatPath(fixturePath);
    diagnostics.setObserverAvailable(null);
    diagnostics.setAllChatsLinkObservation(1_000, 'not-a-boolean');
    diagnostics.finalizeExpectedRouteObservation();
    const snapshot = diagnostics.snapshot();
    expect(snapshot.observerAvailable).toBeNull();
    expect(snapshot.allChatsLinkCount).toBeNull();
    expect(snapshot.allChatsLinkTargetMatches).toBeNull();
    expect(snapshot.mainFrameExpectedRouteCommitted).toBeNull();
    expect(snapshot.requests).toBeNull();
    expect(snapshot.overflow).toBe(true);
  });

  it('saturates event counters and marks overflow without inferring event correlation', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setFixtureChatPath(fixturePath);
    diagnostics.setObserverAvailable(true);
    for (let index = 0; index <= WEB17_NAVIGATION_DIAGNOSTIC_CAP; index++) {
      diagnostics.recordRequestStarted('https://assistant.example.test/chat/all', 'document', true);
      diagnostics.recordResponse('https://assistant.example.test/chat/all', 'document', true, 200);
      diagnostics.setPageErrorCount(index + 1);
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot.requests?.document).toMatchObject({
      started: WEB17_NAVIGATION_DIAGNOSTIC_CAP,
      responseStatus: { success: WEB17_NAVIGATION_DIAGNOSTIC_CAP },
    });
    expect(snapshot.pageErrorCount).toBe(WEB17_NAVIGATION_DIAGNOSTIC_CAP);
    expect(snapshot.overflow).toBe(true);
  });

  it('does not infer a navigation commit from an RSC response without a frame event', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setFixtureChatPath(fixturePath);
    diagnostics.setObserverAvailable(true);
    diagnostics.recordResponse(
      'https://assistant.example.test/chat/all?_rsc=private-query-sentinel',
      'fetch',
      false,
      200,
    );
    diagnostics.finalizeExpectedRouteObservation();
    const snapshot = diagnostics.snapshot();
    expect(snapshot.requests?.rsc).toMatchObject({
      started: 0,
      responseStatus: { success: 1 },
    });
    expect(snapshot.mainFrameExpectedRouteCommitted).toBe(false);
    expect(snapshot.mainFrameTransitions).toEqual({
      all_chats: 0,
      fixture_chat: 0,
      other_same_origin: 0,
      off_origin: 0,
    });
  });

  it('correlates a post-click non-prefetch RSC by opaque nonce', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setFixtureChatPath(fixturePath);
    diagnostics.setObserverAvailable(true);
    const prefetchNonce = 'Abcdef0123456789_-pref0';
    const clickNonce = 'Abcdef0123456789_-click';
    diagnostics.recordRscAttemptStarted(prefetchNonce, true);
    diagnostics.markClickAttempted();
    diagnostics.recordRscAttemptStarted(clickNonce, false);
    diagnostics.recordRscAttemptResponse(clickNonce, 200);

    const snapshot = diagnostics.snapshot();
    expect(snapshot.correlatedRscAttempts).toEqual([
      {
        nonce: prefetchNonce,
        prefetch: true,
        startedAfterClick: false,
        finished: false,
        failed: false,
        responseStatus: null,
      },
      {
        nonce: clickNonce,
        prefetch: false,
        startedAfterClick: true,
        finished: false,
        failed: false,
        responseStatus: 'success',
      },
    ]);
    expect(snapshot.selectedClickRscNonce).toBe(clickNonce);
    expect(projectWeb17NavigationDiagnostics(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('/chat/all');
    expect(JSON.stringify(snapshot)).not.toContain('private-query');
  });

  it('bounds correlated RSC attempts and rejects malformed nonces', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setObserverAvailable(true);
    diagnostics.recordRscAttemptStarted('private-owner-id', false);
    for (let index = 0; index <= WEB17_NAVIGATION_DIAGNOSTIC_CAP; index++) {
      const nonce = `Abcdef0123456789_-${String(index).padStart(4, '0')}`;
      diagnostics.recordRscAttemptStarted(nonce, index === 0);
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot.correlatedRscAttempts).toHaveLength(WEB17_NAVIGATION_DIAGNOSTIC_CAP);
    expect(snapshot.overflow).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('private-owner-id');
    expect(projectWeb17NavigationDiagnostics(snapshot)).toEqual(snapshot);
  });

  it('downgrades a previously observed commit to unknown if observer health is later lost', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setObserverAvailable(true);
    diagnostics.recordMainFrameNavigation('https://assistant.example.test/chat/all');
    diagnostics.setObserverAvailable(false);
    const snapshot = diagnostics.snapshot();
    expect(snapshot.mainFrameExpectedRouteCommitted).toBeNull();
    expect(snapshot.mainFrameTransitions).toBeNull();
    expect(snapshot.requests).toBeNull();
    expect(projectWeb17NavigationDiagnostics(snapshot)).toEqual(snapshot);
  });

  it('keeps malformed or hostile metadata unknown and never retains its contents', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setFixtureChatPath(fixturePath);
    diagnostics.setObserverAvailable(true);
    diagnostics.setAllChatsLinkObservation('many', 'private-href-sentinel');
    diagnostics.recordRequestStarted(
      `https://assistant.example.test/chat/all?${'private-url-sentinel'.repeat(500)}`,
      'unknown-private-resource-type',
      false,
    );
    diagnostics.recordRequestFailed(
      'not a valid URL private-url-sentinel',
      { toString: () => 'private-type-sentinel' },
      false,
      { toString: () => 'private-error-sentinel' },
    );
    diagnostics.recordResponse('https://assistant.example.test/chat/all', 'other', false, '500');
    diagnostics.finalizeExpectedRouteObservation();
    const snapshot = diagnostics.snapshot();
    expect(snapshot.allChatsLinkCount).toBeNull();
    expect(snapshot.allChatsLinkTargetMatches).toBeNull();
    expect(snapshot.mainFrameExpectedRouteCommitted).toBeNull();
    expect(snapshot.observerAvailable).toBe(false);
    expect(snapshot.requests).toBeNull();
    const serialized = JSON.stringify(snapshot);
    for (const sentinel of [
      'private-href-sentinel',
      'private-url-sentinel',
      'private-type-sentinel',
      'private-error-sentinel',
    ])
      expect(serialized).not.toContain(sentinel);
    expect(projectWeb17NavigationDiagnostics(snapshot)).toEqual(snapshot);
  });

  it('strictly rejects extra fields and invalid diagnostic counts before failure-only output', () => {
    const diagnostics = createWeb17NavigationDiagnostics(origin);
    diagnostics.setObserverAvailable(true);
    const snapshot = diagnostics.snapshot();
    expect(projectWeb17NavigationDiagnostics(snapshot)).toEqual(snapshot);

    const invalid = [
      { ...snapshot, rawUrl: 'private-url-sentinel' },
      {
        ...snapshot,
        requests: {
          ...snapshot.requests,
          document: { ...snapshot.requests?.document, started: -1 },
        },
      },
      {
        ...snapshot,
        requests: {
          ...snapshot.requests,
          document: {
            ...snapshot.requests?.document,
            responseStatus: { ...snapshot.requests?.document.responseStatus, private_status: 1 },
          },
        },
      },
      { ...snapshot, allChatsLinkCount: 0, allChatsLinkTargetMatches: true },
      { ...snapshot, observerAvailable: false },
      { ...snapshot, aggregateEventCountsAreUncorrelatedObservations: false },
    ];
    for (const candidate of invalid)
      expect(projectWeb17NavigationDiagnostics(candidate)).toBeNull();
    expect(JSON.stringify(projectWeb17NavigationDiagnostics(invalid[0]))).not.toContain(
      'private-url-sentinel',
    );
  });
});
