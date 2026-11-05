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

  it('keeps the default trace at 18 events and fits PostgreSQL detail into the 20-event cap', () => {
    const requestPhases = [
      'request_received',
      'auth_started',
      'auth_completed',
      'search_params_started',
      'search_params_completed',
      'history_started',
      'agent_started',
      'agent_completed',
      'conversations_started',
      'conversations_completed',
      'archived_count_started',
      'archived_count_completed',
      'scope_count_started',
      'scope_count_completed',
      'active_ids_started',
      'active_ids_completed',
      'history_completed',
      'page_data_ready',
    ] as const;
    const pgPhases = [
      'request_received',
      'auth_completed',
      'search_params_completed',
      'history_started',
      'agent_started',
      'owner_assertion_call_started',
      'owner_assertion_call_returned',
      'agent_row_lookup_call_started',
      'agent_row_lookup_call_returned',
      'agent_completed',
      'conversations_started',
      'conversations_completed',
      'archived_count_started',
      'archived_count_completed',
      'scope_count_started',
      'scope_count_completed',
      'active_ids_started',
      'active_ids_completed',
      'history_completed',
      'page_data_ready',
    ] as const;
    const base = {
      enabled: true,
      host: '127.0.0.1:3001',
      requestClass: 'rsc',
      write: (line: string) => line,
    };
    const ordinaryWrites: string[] = [];
    const ordinary = createWeb17ChatAllStageObserver({
      ...base,
      nonce: 'Ordinary0123456789_-xyz0',
      write: (line) => ordinaryWrites.push(line),
    });
    for (const phase of requestPhases) ordinary?.record(phase);
    const ordinaryEvents = ordinaryWrites.map((line) =>
      JSON.parse(line.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length)),
    );
    expect(ordinaryEvents).toHaveLength(18);
    expect(ordinaryEvents.map((event) => event.phase)).toEqual(requestPhases);

    const postgresWrites: string[] = [];
    const postgres = createWeb17ChatAllStageObserver({
      ...base,
      nonce: 'Postgres0123456789_-xyz',
      postgresDetail: true,
      write: (line) => postgresWrites.push(line),
    });
    for (const phase of [
      ...requestPhases.slice(0, 1),
      'auth_started',
      ...requestPhases.slice(2, 3),
      'search_params_started',
      ...requestPhases.slice(4, 7),
      'owner_assertion_call_started',
      'owner_assertion_call_returned',
      'agent_row_lookup_call_started',
      'agent_row_lookup_call_returned',
      ...requestPhases.slice(7),
    ] as const)
      postgres?.record(phase);
    const postgresEvents = postgresWrites.map((line) =>
      JSON.parse(line.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length)),
    );
    expect(postgresEvents).toHaveLength(WEB17_CHAT_ALL_STAGE_EVENT_CAP);
    expect(postgresEvents.at(-1)?.phase).toBe('page_data_ready');
    expect(postgresEvents.map((event) => event.phase)).toEqual(pgPhases);
  });

  it('keeps eligible PostgreSQL observer events on their own nonce and filters detail by default', () => {
    const base = {
      enabled: true,
      host: '127.0.0.1:3001',
      requestClass: 'rsc',
      postgresDetail: true,
    };
    const firstWrites: string[] = [];
    const secondWrites: string[] = [];
    const ordinaryWrites: string[] = [];
    const first = createWeb17ChatAllStageObserver({
      ...base,
      nonce: 'FirstNonce0123456789_-xyz',
      write: (line) => firstWrites.push(line),
    });
    const second = createWeb17ChatAllStageObserver({
      ...base,
      nonce: 'SecondNonce0123456789_-xy',
      write: (line) => secondWrites.push(line),
    });
    const ordinary = createWeb17ChatAllStageObserver({
      ...base,
      nonce: 'Ordinary0123456789_-xyz0',
      postgresDetail: false,
      write: (line) => ordinaryWrites.push(line),
    });

    first?.recordPostgresAgentResolutionStage('owner_assertion_call_started');
    second?.recordPostgresAgentResolutionStage('agent_row_lookup_call_returned');
    ordinary?.recordPostgresAgentResolutionStage('owner_assertion_call_started');
    ordinary?.record('auth_started');

    const event = (line: string) => {
      const { nonce, phase } = JSON.parse(line.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length)) as {
        nonce: string;
        phase: string;
      };
      return { nonce, phase };
    };
    expect(firstWrites.map(event)).toEqual([
      { nonce: 'FirstNonce0123456789_-xyz', phase: 'owner_assertion_call_started' },
    ]);
    expect(secondWrites.map(event)).toEqual([
      { nonce: 'SecondNonce0123456789_-xy', phase: 'agent_row_lookup_call_returned' },
    ]);
    expect(ordinaryWrites.map(event)).toEqual([
      { nonce: 'Ordinary0123456789_-xyz0', phase: 'auth_started' },
    ]);
  });

  it('retains PostgreSQL owner-resolution failure markers under the unchanged cap', () => {
    const writes: string[] = [];
    const observer = createWeb17ChatAllStageObserver({
      enabled: true,
      host: '127.0.0.1:3001',
      requestClass: 'rsc',
      nonce: 'Failure0123456789_-xyz0',
      postgresDetail: true,
      write: (line) => writes.push(line),
    });
    for (const phase of [
      'request_received',
      'auth_completed',
      'search_params_completed',
      'history_started',
      'agent_started',
      'owner_assertion_call_started',
      'owner_assertion_call_threw',
      'agent_failed',
      'history_failed',
    ] as const)
      observer?.record(phase);

    const events = writes.map((line) => JSON.parse(line.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length)));
    expect(events.map((event) => event.phase)).toEqual([
      'request_received',
      'auth_completed',
      'search_params_completed',
      'history_started',
      'agent_started',
      'owner_assertion_call_started',
      'owner_assertion_call_threw',
      'agent_failed',
      'history_failed',
    ]);
    expect(events).toHaveLength(9);

    const upstreamWrites: string[] = [];
    const upstreamFailure = createWeb17ChatAllStageObserver({
      enabled: true,
      host: '127.0.0.1:3001',
      requestClass: 'rsc',
      nonce: 'Upstream0123456789_-xyz',
      postgresDetail: true,
      write: (line) => upstreamWrites.push(line),
    });
    upstreamFailure?.record('auth_failed');
    upstreamFailure?.record('search_params_failed');
    expect(
      upstreamWrites.map(
        (line) => JSON.parse(line.slice(WEB17_CHAT_ALL_STAGE_PREFIX.length)).phase,
      ),
    ).toEqual(['auth_failed', 'search_params_failed']);
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
