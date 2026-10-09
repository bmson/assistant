export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;

export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 408 | 413; error: string };

export type BoundedBytesResult =
  | { ok: true; value: Uint8Array }
  | { ok: false; status: 400 | 408 | 413; error: string };

export type BoundedFormDataResult =
  | { ok: true; value: FormData }
  | { ok: false; status: 400 | 408 | 413; error: string };

export const DEFAULT_MAX_MULTIPART_BODY_BYTES = 26 * 1024 * 1024;
export const DEFAULT_MAX_BODY_DURATION_MS = 10_000;

function rejectOversizedDeclaredBody(request: Request, maxBytes: number): boolean {
  const length = request.headers.get('content-length');
  if (!length || !/^\d+$/.test(length) || Number(length) <= maxBytes) return false;
  void request.body?.cancel().catch(() => undefined);
  return true;
}

/** Read a request body into a bounded buffer; never wait for stream cancellation. */
export async function readBoundedBytes(
  request: Request,
  maxBytes: number,
  maxDurationMs = DEFAULT_MAX_BODY_DURATION_MS,
): Promise<BoundedBytesResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('Invalid request body byte limit');
  if (!Number.isFinite(maxDurationMs) || maxDurationMs < 1)
    throw new Error('Invalid request body duration limit');
  if (rejectOversizedDeclaredBody(request, maxBytes))
    return { ok: false, status: 413, error: 'Request body is too large.' };
  if (!request.body) return { ok: false, status: 400, error: 'Request body is required.' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error('request body read timed out'));
    }, maxDurationMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: 'Request body is too large.' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: bytes };
  } catch {
    void reader.cancel().catch(() => undefined);
    if (timedOut) return { ok: false, status: 408, error: 'Request body took too long.' };
    return { ok: false, status: 400, error: 'Request body could not be read.' };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    reader.releaseLock();
  }
}

/** Parse multipart fields/files only after the full raw body passed the byte and time bounds. */
export async function readBoundedFormData(
  request: Request,
  maxBytes = DEFAULT_MAX_MULTIPART_BODY_BYTES,
  maxDurationMs = DEFAULT_MAX_BODY_DURATION_MS,
): Promise<BoundedFormDataResult> {
  const bounded = await readBoundedBytes(request, maxBytes, maxDurationMs);
  if (!bounded.ok) return bounded;
  try {
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    const boundedRequest = new Request(request.url, {
      method: request.method,
      headers,
      // readBoundedBytes returns a freshly allocated, zero-offset Uint8Array.
      body: bounded.value.buffer as ArrayBuffer,
    });
    return { ok: true, value: await boundedRequest.formData() };
  } catch {
    return { ok: false, status: 400, error: 'Request body must be valid multipart form data.' };
  }
}

/** Read a JSON request without allowing an unbounded text() or json() allocation. */
export async function readBoundedJson(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
  maxDurationMs = DEFAULT_MAX_BODY_DURATION_MS,
): Promise<BoundedJsonResult> {
  const bounded = await readBoundedBytes(request, maxBytes, maxDurationMs);
  if (!bounded.ok)
    return bounded.status === 400 ? { ...bounded, error: 'Request body must be JSON.' } : bounded;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bounded.value);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'Request body must be valid JSON.' };
  }
}
