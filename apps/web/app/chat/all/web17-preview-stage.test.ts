import { createRequestStore } from 'next/dist/server/async-storage/request-store';
import { describe, expect, it } from 'vitest';
import {
  createWeb17ChatAllStageObserver,
  elapsedBucket,
  isWeb17ChatAllNonce,
  isWeb17ChatAllPhase,
  isWeb17ChatAllPreviewEnabled,
  WEB17_CHAT_ALL_STAGE_EVENT_CAP,
  WEB17_CHAT_ALL_STAGE_PREFIX,
} from './web17-preview-stage.js';

describe('WEB-17 chat list stage diagnostics', () => {
  it('requires all dedicated development-preview opt-ins', () => {
    expect(
      isWeb17ChatAllPreviewEnabled({
        nodeEnv: 'development',
        previewEnabled: 'true',
        diagnosticsEnabled: '1',
      }),
    ).toBe(true);
    expect(
      isWeb17ChatAllPreviewEnabled({
        nodeEnv: 'production',
        previewEnabled: 'true',
        diagnosticsEnabled: '1',
      }),
    ).toBe(false);
    expect(
      isWeb17ChatAllPreviewEnabled({
        nodeEnv: 'development',
        previewEnabled: 'false',
        diagnosticsEnabled: '1',
      }),
    ).toBe(false);
    expect(
      isWeb17ChatAllPreviewEnabled({
        nodeEnv: 'development',
        previewEnabled: 'true',
        diagnosticsEnabled: '0',
      }),
    ).toBe(false);
  });

  it('requires loopback RSC preview requests and a bounded opaque nonce', () => {
    const base = {
      enabled: true,
      host: '127.0.0.1:3001',
      requestClass: 'rsc',
      nonce: 'Abcdef0123456789_-xyz0',
      write: () => {},
    };
    expect(createWeb17ChatAllStageObserver(base)).toBeDefined();
    expect(createWeb17ChatAllStageObserver({ ...base, enabled: false })).toBeUndefined();
    expect(
      createWeb17ChatAllStageObserver({ ...base, host: 'preview.example.test' }),
    ).toBeUndefined();
    expect(createWeb17ChatAllStageObserver({ ...base, requestClass: 'document' })).toBeUndefined();
    expect(createWeb17ChatAllStageObserver({ ...base, nonce: 'not a nonce' })).toBeUndefined();
    expect(isWeb17ChatAllNonce('Abcdef0123456789_-xyz0')).toBe(true);
    expect(isWeb17ChatAllNonce('private-owner-id')).toBe(false);
  });

  it('emits only fixed stages, the opaque correlation nonce and elapsed buckets', () => {
    const writes: string[] = [];
    let now = 0;
    const observer = createWeb17ChatAllStageObserver({
      enabled: true,
      host: 'localhost:3001',
      requestClass: 'rsc-prefetch',
      nonce: 'Abcdef0123456789_-xyz0',
      now: () => now,
      write: (line) => writes.push(line),
    });
    expect(observer).toBeDefined();
    observer?.record('request_received');
    now = 1_500;
    observer?.record('search_params_started');
    observer?.recordHistoryStage('conversations_started');
    observer?.record('page_data_ready');

    const events = writes.map((line) => {
      expect(line.startsWith(WEB17_CHAT_ALL_STAGE_PREFIX)).toBe(true);
      return JSON.parse(line.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length));
    });
    expect(events).toEqual([
      {
        kind: 'WEB17_CHAT_ALL_STAGE',
        nonce: 'Abcdef0123456789_-xyz0',
        prefetch: true,
        phase: 'request_received',
        elapsed: 'under_1s',
      },
      {
        kind: 'WEB17_CHAT_ALL_STAGE',
        nonce: 'Abcdef0123456789_-xyz0',
        prefetch: true,
        phase: 'search_params_started',
        elapsed: 'under_5s',
      },
      {
        kind: 'WEB17_CHAT_ALL_STAGE',
        nonce: 'Abcdef0123456789_-xyz0',
        prefetch: true,
        phase: 'conversations_started',
        elapsed: 'under_5s',
      },
      {
        kind: 'WEB17_CHAT_ALL_STAGE',
        nonce: 'Abcdef0123456789_-xyz0',
        prefetch: true,
        phase: 'page_data_ready',
        elapsed: 'under_5s',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('127.0.0.1');
    expect(JSON.stringify(events)).not.toContain('3001');
    expect(JSON.stringify(events)).not.toContain('rsc');
    expect(isWeb17ChatAllPhase('page_data_ready')).toBe(true);
    expect(isWeb17ChatAllPhase('private-stage')).toBe(false);
  });

  it('saturates stage event emission at a fixed cap and marks invalid timing unknown', () => {
    const writes: string[] = [];
    const observer = createWeb17ChatAllStageObserver({
      enabled: true,
      host: '127.0.0.1',
      requestClass: 'rsc',
      nonce: 'Abcdef0123456789_-xyz0',
      now: () => 0,
      write: (line) => writes.push(line),
    });
    for (let index = 0; index < WEB17_CHAT_ALL_STAGE_EVENT_CAP + 2; index++)
      observer?.record('request_received');

    expect(writes).toHaveLength(WEB17_CHAT_ALL_STAGE_EVENT_CAP);
    const firstLine = writes[0];
    expect(firstLine).toBeDefined();
    expect(JSON.parse(firstLine?.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length) ?? '{}').elapsed).toBe(
      'under_1s',
    );
    expect(elapsedBucket(-1)).toBe('unknown');
    expect(elapsedBucket(0)).toBe('under_1s');
    expect(elapsedBucket(1_000)).toBe('under_5s');
    expect(elapsedBucket(5_000)).toBe('under_20s');
    expect(elapsedBucket(20_000)).toBe('20s_or_more');
    expect(elapsedBucket(Number.NaN)).toBe('unknown');
  });

  it('marks elapsed time unknown when the clock is unavailable', () => {
    const writes: string[] = [];
    const observer = createWeb17ChatAllStageObserver({
      enabled: true,
      host: 'localhost:3001',
      requestClass: 'rsc',
      nonce: 'Abcdef0123456789_-xyz0',
      now: () => {
        throw new Error('synthetic clock failure');
      },
      write: (line) => writes.push(line),
    });
    observer?.record('request_received');
    expect(JSON.parse(writes[0]?.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length) ?? '{}').elapsed).toBe(
      'unknown',
    );
  });

  it('marks non-finite elapsed measurements unknown while retaining zero as under one second', () => {
    expect(elapsedBucket(Number.NaN)).toBe('unknown');
    expect(elapsedBucket(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(elapsedBucket(Number.NEGATIVE_INFINITY)).toBe('unknown');
    expect(elapsedBucket(-0.1)).toBe('unknown');
    expect(elapsedBucket(0)).toBe('under_1s');
  });

  it('uses a browser-validated marker that survives Next request header filtering', () => {
    const requestHeaders = new Headers({
      host: '127.0.0.1:3001',
      rsc: '1',
      'next-router-prefetch': '1',
      'x-web17-attempt': 'Abcdef0123456789_-xyz0',
      'x-web17-request-class': 'rsc-prefetch',
    });
    const store = createRequestStore({
      phase: 'render',
      headers: requestHeaders,
      onUpdateCookies: undefined,
      url: { pathname: '/chat/all' },
      rootParams: {},
      implicitTags: { tags: [], expirationsByCacheKind: new Map() },
      resumeDataCache: null,
      previewProps: undefined,
      isHmrRefresh: false,
      serverComponentsHmrCache: undefined,
      hmrRefreshHash: undefined,
      stagedFallbackParams: null,
    });
    const userlandHeaders = store.headers;

    expect(userlandHeaders.get('rsc')).toBeNull();
    expect(userlandHeaders.get('next-router-prefetch')).toBeNull();
    expect(userlandHeaders.get('x-web17-request-class')).toBe('rsc-prefetch');
    expect(userlandHeaders.get('x-web17-attempt')).toBe('Abcdef0123456789_-xyz0');
    const writes: string[] = [];
    const observer = createWeb17ChatAllStageObserver({
      enabled: true,
      host: userlandHeaders.get('host'),
      requestClass: userlandHeaders.get('x-web17-request-class'),
      nonce: userlandHeaders.get('x-web17-attempt'),
      write: (line) => writes.push(line),
    });
    expect(observer).toBeDefined();
    observer?.record('request_received');
    expect(JSON.parse(writes[0]?.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length) ?? '{}')).toMatchObject({
      prefetch: true,
      phase: 'request_received',
    });
  });
});
