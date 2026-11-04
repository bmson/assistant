import { describe, expect, it } from 'vitest';
import {
  projectWeb17PreviewDiagnostics,
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

  it('reports an unavailable preview log without exposing an error message', () => {
    expect(projectWeb17PreviewDiagnostics(undefined, { logAvailable: false })).toMatchObject({
      kind: 'WEB17_PREVIEW_DIAGNOSTICS',
      logAvailable: false,
      inputTruncated: false,
      linesScanned: 0,
    });
  });
});
