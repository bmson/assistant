export type BoundedResponseBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: 'too-large' | 'read-failed' };

/** Buffer a response body only while its actual streamed byte count stays bounded. */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<BoundedResponseBody> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too-large' };
  }
  if (!response.body) return { ok: false, reason: 'read-failed' };

  const reader = response.body.getReader();
  const bytes = new Uint8Array(new ArrayBuffer(maxBytes));
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too-large' };
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
    return { ok: true, bytes: bytes.subarray(0, total) };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: 'read-failed' };
  } finally {
    reader.releaseLock();
  }
}
