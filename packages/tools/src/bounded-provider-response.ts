/** Await a transaction phase without letting an ignored abort keep it alive. */
export class ProviderDeadlineError extends Error {}
export class ProviderResponseLimitError extends Error {}

export async function providerTransaction<T>(
  caller: AbortSignal | null | undefined,
  timeoutMs: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (caller?.aborted) throw caller.reason ?? new Error('Provider request aborted');
  const controller = new AbortController();
  let interrupt: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    interrupt = reject;
  });
  const abort = () => {
    controller.abort(caller?.reason);
    interrupt(caller?.reason ?? new Error('Provider request aborted'));
  };
  caller?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    const error = new ProviderDeadlineError(`${label} request timed out after ${timeoutMs}ms`);
    controller.abort(error);
    interrupt(error);
  }, timeoutMs);
  try {
    return await Promise.race([run(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', abort);
  }
}

export async function withProviderSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw signal.reason ?? new Error('Provider request aborted');
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Provider request aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** The deadline includes headers, every body chunk, and reader cleanup. */
export async function boundedProviderResponse(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; maxBytes: number; label: string },
): Promise<Response> {
  return providerTransaction(init.signal, options.timeoutMs, options.label, async (signal) => {
    if (signal.aborted) throw signal.reason;
    const fetching = fetcher(url, { ...init, signal });
    fetching.then(
      (response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await withProviderSignal(fetching, signal);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new ProviderResponseLimitError(
        `${options.label} response exceeds ${options.maxBytes} bytes`,
      );
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await withProviderSignal(reader.read(), signal);
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes)
          throw new ProviderResponseLimitError(
            `${options.label} response exceeds ${options.maxBytes} bytes`,
          );
        chunks.push(value);
      }
    } finally {
      // A hostile stream may never finish cancel(); cleanup cannot extend the
      // transaction deadline or hide its unknown external-effect disposition.
      void reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    );
    return new Response(new Uint8Array(bytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
}
