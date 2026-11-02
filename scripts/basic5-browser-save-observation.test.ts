import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Basic5SaveObservationDiagnostic,
  observeBasic5Save,
} from './basic5-browser-save-observation.js';

type FakeResponse = { matches: boolean; status: number; valid: boolean };

class FakeTimeoutError extends Error {}

class FakePage {
  closed = false;
  waits: { timeout: number; signal: AbortSignal }[] = [];
  private readonly responses = new Set<(response: FakeResponse) => void>();
  private readonly closures = new Set<() => void>();

  on(event: 'response', listener: (response: FakeResponse) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'response' | 'close', listener: ((response: FakeResponse) => void) | (() => void)) {
    if (event === 'response') this.responses.add(listener as (response: FakeResponse) => void);
    else this.closures.add(listener as () => void);
    return this;
  }

  off(event: 'response', listener: (response: FakeResponse) => void): this;
  off(event: 'close', listener: () => void): this;
  off(event: 'response' | 'close', listener: ((response: FakeResponse) => void) | (() => void)) {
    if (event === 'response') this.responses.delete(listener as (response: FakeResponse) => void);
    else this.closures.delete(listener as () => void);
    return this;
  }

  isClosed() {
    return this.closed;
  }

  waitForResponse(
    predicate: (response: FakeResponse) => boolean,
    options: { timeout: number; signal: AbortSignal },
  ) {
    this.waits.push(options);
    let cleanup = () => {};
    const promise = new Promise<FakeResponse>((resolve, reject) => {
      const onResponse = (response: FakeResponse) => {
        if (predicate(response)) resolve(response);
      };
      const onClose = () => reject(new Error('closed private browser details'));
      const onAbort = () => reject(new Error('aborted private waiter details'));
      const timer = setTimeout(
        () => reject(new FakeTimeoutError('private timeout details')),
        options.timeout,
      );
      this.on('response', onResponse);
      this.on('close', onClose);
      options.signal.addEventListener('abort', onAbort, { once: true });
      cleanup = () => {
        clearTimeout(timer);
        this.off('response', onResponse);
        this.off('close', onClose);
        options.signal.removeEventListener('abort', onAbort);
      };
      if (this.closed) onClose();
      else if (options.signal.aborted) onAbort();
    });
    return promise.finally(cleanup);
  }

  emitResponse(response: FakeResponse) {
    for (const listener of [...this.responses]) listener(response);
  }

  close() {
    this.closed = true;
    for (const listener of [...this.closures]) listener();
  }

  get listenerCount() {
    return this.responses.size + this.closures.size;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const validResponse = { matches: true, status: 200, valid: true };

function fixture() {
  const page = new FakePage();
  const diagnostics: Basic5SaveObservationDiagnostic[] = [];
  let posts = 0;
  let active = false;
  let notify = (_matched: boolean | null) => {};
  const dispose = vi.fn(() => {
    active = false;
  });
  const request = (matched: boolean | null = true) => {
    posts += 1;
    if (active) notify(matched);
  };
  const parse = vi.fn(async (response: FakeResponse) => {
    if (response.status >= 400) throw new Error('private HTTP response body');
    if (!response.valid) throw new Error('private malformed response body');
    return 'verified-receipt';
  });
  const readUi = vi.fn(async () => ({
    nativeValid: true,
    invalidControlPresent: false,
    alertPresent: false,
    saveEnabled: true,
  }));
  const input: Parameters<typeof observeBasic5Save<FakeResponse, string>>[0] = {
    operation: 'add_family_relationship',
    page,
    click: vi.fn(async () => {
      request();
      page.emitResponse(validResponse);
    }),
    parse,
    matchResponse: (response) => response.matches,
    status: (response) => response.status,
    activateRequestObserver: (listener) => {
      active = true;
      notify = listener;
      return dispose;
    },
    totalMatchingPostCount: () => posts,
    readUi,
    isTimeoutError: (error) => error instanceof FakeTimeoutError,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
  return {
    page,
    diagnostics,
    dispose,
    request,
    parse,
    readUi,
    input,
    run: () => observeBasic5Save(input),
  };
}

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
}

function expectClean(f: ReturnType<typeof fixture>) {
  expect(f.page.listenerCount).toBe(0);
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
}

describe('bounded actual BASIC5 save observation with fake page and timers', () => {
  it('returns the strict parser result and cleans every observer after a matched response', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe('verified-receipt');
    expect(f.parse).toHaveBeenCalledExactlyOnceWith(validResponse);
    expect(f.diagnostics).toEqual([
      {
        operation: 'add_family_relationship',
        phase: 'parse',
        totalMatchingPostCount: 1,
        commandMatched: true,
        httpStatus: 200,
        nativeValid: true,
        invalidControlPresent: false,
        alertPresent: false,
        saveEnabled: true,
        pageClosed: false,
        errorStage: null,
        errorCategory: null,
      },
    ]);
    expectClean(f);
  });

  it('installs an abortable response waiter before click using the same bounded time budget', async () => {
    const f = fixture();
    f.input.click = vi.fn(async (remainingMs) => {
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual(30_000);
      expect(f.page.waits).toHaveLength(1);
      expect(f.page.waits[0]?.signal.aborted).toBe(false);
      expect(f.page.waits[0]?.timeout).toBe(remainingMs);
      f.request();
      f.page.emitResponse(validResponse);
    });
    await expect(f.run()).resolves.toBe('verified-receipt');
    expect(f.page.waits[0]?.signal.aborted).toBe(true);
    expectClean(f);
  });

  it('preserves the exact click rejection and aborts its still-pending response waiter', async () => {
    const f = fixture();
    const cause = new Error('private click details, URL and form value');
    f.input.click = vi.fn(async () => {
      throw cause;
    });
    await expect(f.run()).rejects.toBe(cause);
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'click_pending',
      totalMatchingPostCount: 0,
      httpStatus: null,
      errorStage: 'click',
      errorCategory: 'other',
    });
    expect(JSON.stringify(f.diagnostics)).not.toContain(cause.message);
    expect(f.parse).not.toHaveBeenCalled();
    expectClean(f);
    await vi.runAllTimersAsync();
  });

  it('preserves the primary click cause when the response waiter rejects first on page close', async () => {
    const f = fixture();
    const click = deferred<void>();
    const cause = new Error('private primary click cause');
    f.input.click = () => {
      f.page.close();
      return click.promise;
    };
    const result = settled(f.run());
    await vi.advanceTimersByTimeAsync(1);
    click.reject(cause);
    expect(await result).toEqual({ kind: 'error', error: cause });
    expect(f.diagnostics[0]).toMatchObject({ pageClosed: true, errorStage: 'click' });
    expectClean(f);
  });

  it('keeps the later response phase when the click subsequently rejects', async () => {
    const f = fixture();
    const cause = new Error('private click failure after response');
    f.input.click = async () => {
      f.request();
      f.page.emitResponse(validResponse);
      throw cause;
    };
    await expect(f.run()).rejects.toBe(cause);
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'response_seen',
      httpStatus: 200,
      errorStage: 'click',
    });
    expect(f.parse).not.toHaveBeenCalled();
    expectClean(f);
  });

  it('retains waiter failure when page closure precedes successful click completion', async () => {
    const f = fixture();
    f.input.click = async () => {
      f.page.close();
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.diagnostics[0]).toMatchObject({
      pageClosed: true,
      errorStage: 'wait',
      errorCategory: 'page_closed',
    });
    expect(f.parse).not.toHaveBeenCalled();
    expectClean(f);
  });

  it('times out a completed click with no POST and never invokes the parser', async () => {
    const f = fixture();
    f.input.click = vi.fn(async () => {});
    const result = settled(f.run());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).kind).toBe('error');
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'click_done',
      totalMatchingPostCount: 0,
      commandMatched: null,
      httpStatus: null,
      errorStage: 'wait',
      errorCategory: 'timeout',
    });
    expect(f.parse).not.toHaveBeenCalled();
    expectClean(f);
  });

  it('retains post-click client-validation flags when no POST precedes the response timeout', async () => {
    const f = fixture();
    let clientErrorsVisible = false;
    f.input.readUi = vi.fn(async () => ({
      nativeValid: true,
      invalidControlPresent: clientErrorsVisible,
      alertPresent: clientErrorsVisible,
      saveEnabled: true,
    }));
    f.input.click = async () => {
      clientErrorsVisible = true;
    };
    const result = settled(f.run());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).kind).toBe('error');
    expect(f.input.readUi).toHaveBeenCalledTimes(2);
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'click_done',
      totalMatchingPostCount: 0,
      commandMatched: null,
      httpStatus: null,
      nativeValid: true,
      invalidControlPresent: true,
      alertPresent: true,
      saveEnabled: true,
      errorStage: 'wait',
      errorCategory: 'timeout',
    });
    expect(f.parse).not.toHaveBeenCalled();
    expectClean(f);
  });

  it('bounds a stuck click and handles its late rejection after waiter cleanup', async () => {
    const f = fixture();
    const click = deferred<void>();
    f.input.click = () => click.promise;
    const result = settled(f.run());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).kind).toBe('error');
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'click_pending',
      errorStage: 'click',
      errorCategory: 'timeout',
    });
    expectClean(f);
    click.reject(new Error('private late click rejection'));
    await vi.advanceTimersByTimeAsync(1);
  });

  it('distinguishes a matching POST with no response from no dispatch', async () => {
    const f = fixture();
    f.input.click = async () => f.request();
    const result = settled(f.run());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).kind).toBe('error');
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'request_seen',
      totalMatchingPostCount: 1,
      commandMatched: true,
      httpStatus: null,
      errorStage: 'wait',
      errorCategory: 'timeout',
    });
    expectClean(f);
  });

  it('ignores unmatched responses and retains the observed wrong-command flag', async () => {
    const f = fixture();
    f.input.click = async () => {
      f.request(false);
      f.page.emitResponse({ ...validResponse, matches: false });
    };
    const result = settled(f.run());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).kind).toBe('error');
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'request_seen',
      totalMatchingPostCount: 1,
      commandMatched: false,
      httpStatus: null,
      errorStage: 'wait',
    });
    expect(f.parse).not.toHaveBeenCalled();
    expectClean(f);
  });

  it.each([
    { status: 422, valid: true },
    { status: 200, valid: false },
  ])('preserves actual parse rejection after observed HTTP $status', async (response) => {
    const f = fixture();
    const cause = new Error('private parsed body details');
    f.input.parse = vi.fn(async () => {
      throw cause;
    });
    f.input.click = async () => {
      f.request();
      f.page.emitResponse({ matches: true, ...response });
    };
    await expect(f.run()).rejects.toBe(cause);
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'parse',
      httpStatus: response.status,
      errorStage: 'parse',
      errorCategory: 'other',
    });
    expect(JSON.stringify(f.diagnostics)).not.toContain(cause.message);
    expectClean(f);
  });

  it('bounds a parser that never settles and handles its late rejection', async () => {
    const f = fixture();
    const parse = deferred<string>();
    f.input.parse = () => parse.promise;
    const result = settled(f.run());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).kind).toBe('error');
    expect(f.diagnostics[0]).toMatchObject({
      phase: 'parse',
      httpStatus: 200,
      errorStage: 'parse',
      errorCategory: 'timeout',
    });
    expectClean(f);
    parse.reject(new Error('private late parse rejection'));
    await vi.advanceTimersByTimeAsync(1);
  });

  it('keeps native-invalid UI metadata observational rather than inventing no-dispatch authority', async () => {
    const f = fixture();
    f.input.readUi = async () => ({
      nativeValid: false,
      invalidControlPresent: true,
      alertPresent: true,
      saveEnabled: false,
    });
    await expect(f.run()).resolves.toBe('verified-receipt');
    expect(f.diagnostics[0]).toMatchObject({
      nativeValid: false,
      invalidControlPresent: true,
      alertPresent: true,
      saveEnabled: false,
      errorStage: null,
    });
    expectClean(f);
  });

  it('tolerates UI read failure without replacing a successful save', async () => {
    const f = fixture();
    f.input.readUi = async () => {
      throw new Error('private DOM details');
    };
    await expect(f.run()).resolves.toBe('verified-receipt');
    expect(f.diagnostics[0]).toMatchObject({
      nativeValid: null,
      invalidControlPresent: null,
      alertPresent: null,
      saveEnabled: null,
    });
    expectClean(f);
  });

  it('bounds a slow UI read and handles its late rejection after return', async () => {
    const f = fixture();
    const ui = deferred<Awaited<ReturnType<typeof f.input.readUi>>>();
    f.input.readUi = () => ui.promise;
    const result = settled(f.run());
    // Both pre-click and post-click best-effort UI reads get at most 250 ms,
    // sharing the same total save budget rather than extending it.
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ kind: 'value', value: 'verified-receipt' });
    expect(f.input.click).toHaveBeenCalledWith(29_750);
    expect(f.page.waits[0]?.timeout).toBe(29_750);
    expect(f.diagnostics[0]).toMatchObject({ nativeValid: null });
    expectClean(f);
    ui.reject(new Error('private late UI rejection'));
    await vi.advanceTimersByTimeAsync(1);
  });

  it('does not let a throwing diagnostic sink or observer disposer replace the operation result', async () => {
    const f = fixture();
    f.input.onDiagnostic = () => {
      throw new Error('private sink failure');
    };
    f.input.activateRequestObserver = () => () => {
      f.dispose();
      throw new Error('private observer dispose failure');
    };
    await expect(f.run()).resolves.toBe('verified-receipt');
    expectClean(f);
  });

  it('does not start a click or request observer when the page is already closed', async () => {
    const f = fixture();
    f.page.closed = true;
    await expect(f.run()).rejects.toThrow();
    expect(f.input.click).not.toHaveBeenCalled();
    expect(f.parse).not.toHaveBeenCalled();
    expect(f.page.waits).toEqual([]);
    expect(f.diagnostics[0]).toMatchObject({
      pageClosed: true,
      errorStage: 'wait',
      errorCategory: 'page_closed',
    });
    expect(f.dispose).not.toHaveBeenCalled();
    expect(f.page.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([Number.NaN, -1, 65])(
    'keeps an unavailable or invalid POST count unknown (%s)',
    async (count) => {
      const f = fixture();
      f.input.totalMatchingPostCount = () => count;
      await expect(f.run()).resolves.toBe('verified-receipt');
      expect(f.diagnostics[0]?.totalMatchingPostCount).toBeNull();
      expectClean(f);
    },
  );

  it('keeps a throwing POST count observer unknown rather than reporting zero', async () => {
    const f = fixture();
    f.input.totalMatchingPostCount = () => {
      throw new Error('private counter failure');
    };
    await expect(f.run()).resolves.toBe('verified-receipt');
    expect(f.diagnostics[0]?.totalMatchingPostCount).toBeNull();
    expectClean(f);
  });
});
