import { describe, expect, it } from 'vitest';
import {
  projectWeb17PreviewDiagnostics,
  WEB17_PREVIEW_CHAT_ALL_STAGE_EVENT_CAP,
  WEB17_PREVIEW_COUNT_CAP,
  WEB17_PREVIEW_LINE_CAP,
} from './web17-preview-diagnostics.js';

describe('bounded WEB-17 preview diagnostics', () => {
  it('projects allowlisted compile, route, and error classes without retaining log values', () => {
    const input = [
      '✓ Ready in 512ms',
      '✓ Compiled /api/health in 330ms (102 modules)',
      '\u001b[36m○ Compiling /chat/[private-route-id] ...\u001b[39m',
      '\u001b[36m○ Compiling /chat/all ...\u001b[39m',
      '\u001b[32m✓ Compiled /chat/all in 21.5s (411 modules)\u001b[39m',
      '\u001b[32mGET /chat/all?_rsc=private-rsc-token 500 in 9ms\u001b[39m',
      'Failed to compile: private-email@example.test',
      "Module not found: Can't resolve 'private-file-path'",
      'TypeError: private response body and Authorization: Bearer private-secret',
      'DATABASE_URL=postgres://private-user:private-password@127.0.0.1/private-db',
    ].join('\n');

    const result = projectWeb17PreviewDiagnostics(input);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      kind: 'WEB17_PREVIEW_DIAGNOSTICS',
      logAvailable: true,
      serverStageStatus: 'no_matching_event',
      readyMarkers: 1,
      routes: {
        api_health: { compiled: 1, compileDuration: { under_1s: 1 } },
        chat_detail: { compileStarted: 1 },
        chat_all: {
          compileStarted: 1,
          compiled: 1,
          compileDuration: { '20s_or_more': 1 },
          completedResponses: 1,
          responseStatus: { serverError: 1 },
        },
      },
      errors: { compileFailure: 1, moduleResolution: 1, runtime: 1 },
    });
    for (const secret of [
      'private-rsc-token',
      'private-email@example.test',
      'private-file-path',
      'private response body',
      'private-secret',
      'private-user',
      'private-password',
      'private-db',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('caps output counters and scanned lines while marking truncation', () => {
    const routeLines = Array.from(
      { length: WEB17_PREVIEW_COUNT_CAP + 2 },
      () => '\u001b[32mGET /chat/all 200 in 20ms\u001b[39m',
    );
    const input = [
      ...Array.from({ length: WEB17_PREVIEW_LINE_CAP }, () => 'noise'),
      ...routeLines,
    ].join('\n');
    const result = projectWeb17PreviewDiagnostics(input);

    expect(result.routes.chat_all.completedResponses).toBe(WEB17_PREVIEW_COUNT_CAP);
    expect(result.routes.chat_all.responseStatus.success).toBe(WEB17_PREVIEW_COUNT_CAP);
    expect(result.linesScanned).toBe(WEB17_PREVIEW_LINE_CAP);
    expect(result.inputTruncated).toBe(true);
    expect(result.overflow).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(2_500);
  });

  it('keeps invalid compile durations unknown instead of classifying them as long', () => {
    const result = projectWeb17PreviewDiagnostics(
      ['Compiled /chat/all in -1ms', 'Compiled /chat/all in Infinityms'].join('\n'),
    );
    expect(result.routes.chat_all.compileDuration.unknown).toBe(2);
    expect(result.routes.chat_all.compileDuration['20s_or_more']).toBe(0);
  });

  it('reports an unavailable preview log without exposing an error message', () => {
    expect(projectWeb17PreviewDiagnostics(undefined, { logAvailable: false })).toMatchObject({
      kind: 'WEB17_PREVIEW_DIAGNOSTICS',
      logAvailable: false,
      inputTruncated: false,
      linesScanned: 0,
      serverStageStatus: 'unavailable',
    });
  });

  it('retains only bounded correlated chat-list stage markers', () => {
    const nonce = 'Abcdef0123456789_-xyz0';
    const safe = {
      kind: 'WEB17_CHAT_ALL_STAGE',
      nonce,
      prefetch: false,
      phase: 'conversations_started',
      elapsed: 'under_1s',
    };
    const unknownElapsed = {
      ...safe,
      phase: 'search_params_started',
      elapsed: 'unknown',
    };
    const hostile = {
      ...safe,
      phase: 'conversations_started',
      rawUrl: '/chat/all?private=query',
    };
    const input = [
      `[WEB17_CHAT_ALL_STAGE] ${JSON.stringify(safe)}`,
      `[WEB17_CHAT_ALL_STAGE] ${JSON.stringify(unknownElapsed)}`,
      `[WEB17_CHAT_ALL_STAGE] ${JSON.stringify(hostile)}`,
      `[WEB17_CHAT_ALL_STAGE] ${JSON.stringify({ ...safe, nonce: 'private-owner-id' })}`,
    ].join('\n');
    expect(
      projectWeb17PreviewDiagnostics(`[WEB17_CHAT_ALL_STAGE] ${JSON.stringify(safe)}`)
        .serverStageStatus,
    ).toBe('observed');
    const result = projectWeb17PreviewDiagnostics(input);

    expect(result.chatAllStageEvents).toEqual([safe, unknownElapsed]);
    expect(result.serverStageStatus).toBe('incomplete');
    expect(result.overflow).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private=query');
    expect(JSON.stringify(result)).not.toContain('private-owner-id');
    expect(JSON.stringify(result)).not.toContain('rawUrl');
  });

  it('accepts only the six fixed PostgreSQL agent-resolution call phases', () => {
    const phases = [
      'owner_assertion_call_started',
      'owner_assertion_call_returned',
      'owner_assertion_call_threw',
      'agent_row_lookup_call_started',
      'agent_row_lookup_call_returned',
      'agent_row_lookup_call_threw',
    ];
    const nonce = 'Abcdef0123456789_-xyz0';
    const input = [
      ...phases.map((phase) =>
        JSON.stringify({
          kind: 'WEB17_CHAT_ALL_STAGE',
          nonce,
          prefetch: false,
          phase,
          elapsed: 'under_1s',
        }),
      ),
      JSON.stringify({
        kind: 'WEB17_CHAT_ALL_STAGE',
        nonce,
        prefetch: false,
        phase: 'owner_assertion_sql_failed',
        elapsed: 'under_1s',
      }),
    ]
      .map((event) => `[WEB17_CHAT_ALL_STAGE] ${event}`)
      .join('\n');

    const result = projectWeb17PreviewDiagnostics(input);
    expect(result.chatAllStageEvents.map((event) => event.phase)).toEqual(phases);
    expect(JSON.stringify(result)).not.toContain('owner_assertion_sql_failed');
  });

  it('caps server stage markers while retaining their safe correlation fields', () => {
    const events = Array.from(
      { length: WEB17_PREVIEW_CHAT_ALL_STAGE_EVENT_CAP + 3 },
      (_, index) => ({
        kind: 'WEB17_CHAT_ALL_STAGE',
        nonce: `Abcdef0123456789_-${String(index).padStart(4, '0')}`,
        prefetch: index === 0,
        phase: 'request_received',
        elapsed: 'under_1s',
      }),
    );
    const result = projectWeb17PreviewDiagnostics(
      events.map((event) => `[WEB17_CHAT_ALL_STAGE] ${JSON.stringify(event)}`).join('\n'),
    );
    expect(result.chatAllStageEvents).toHaveLength(WEB17_PREVIEW_CHAT_ALL_STAGE_EVENT_CAP);
    expect(result.serverStageStatus).toBe('incomplete');
    expect(result.chatAllStageEvents[0]).toMatchObject({
      prefetch: true,
      phase: 'request_received',
    });
    expect(result.overflow).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
  });
});
