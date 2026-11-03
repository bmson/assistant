import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryLibraryDiagnosticContext,
  withMemoryLibraryPhase,
} from './memory-library-diagnostics.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('memory library phase diagnostics', () => {
  it('emits only bounded phase metadata and a whitelisted numeric provider code', async () => {
    vi.stubEnv('K_REVISION', 'assistant-web-test-1');
    const context = createMemoryLibraryDiagnosticContext();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const privateMarker = 'synthetic-owner-row-content-and-query';
    const failure = Object.assign(new Error(privateMarker), { code: 14 });

    await expect(
      withMemoryLibraryPhase(context, 'list', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const [line] = info.mock.calls[0] ?? [];
    expect(typeof line).toBe('string');
    const event = JSON.parse(String(line)) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: 'memory_library_phase',
      requestId: context.requestId,
      revision: 'assistant-web-test-1',
      phase: 'list',
      outcome: 'error',
      errorCode: 'UNAVAILABLE',
    });
    expect(event.elapsedMs).toEqual(expect.any(Number));
    expect(String(line)).not.toContain(privateMarker);
  });

  it('maps unrecognized or hostile codes to one safe bucket without replacing the error', async () => {
    const context = createMemoryLibraryDiagnosticContext();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const failure = new Error('private query and row marker');
    Object.defineProperty(failure, 'code', {
      get() {
        throw new Error('hostile code getter');
      },
    });

    await expect(
      withMemoryLibraryPhase(context, 'filters', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const [line] = info.mock.calls[0] ?? [];
    expect(JSON.parse(String(line))).toMatchObject({
      phase: 'filters',
      outcome: 'error',
      errorCode: 'UNCLASSIFIED',
    });
    expect(String(line)).not.toContain('private query and row marker');
    expect(String(line)).not.toContain('hostile code getter');
  });

  it('does not log successful operations and keeps the original error if logging fails', async () => {
    const context = createMemoryLibraryDiagnosticContext();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('synthetic logger failure');
    });
    const value = { total: 1 };
    const failure = new Error('synthetic repository failure');

    await expect(withMemoryLibraryPhase(context, 'list', async () => value)).resolves.toBe(value);
    expect(info).not.toHaveBeenCalled();
    await expect(
      withMemoryLibraryPhase(context, 'filters', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(info).toHaveBeenCalledOnce();
  });
});
