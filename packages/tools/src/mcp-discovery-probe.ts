import { withProviderSignal } from './bounded-provider-response.js';

/** A deliberately narrower subset of the modern binding's HTTP-400 fallback. */
export async function permitsLegacyDiscoveryProbe(
  response: Response,
  id: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (response.status !== 400) return false;
  const maxBytes = 300_000;
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) return false;
  const reader = response.body?.getReader();
  if (!reader) return true;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await withProviderSignal(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return false;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) return true;
  if (
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    return false;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rpc = value as Record<string, unknown>;
  if (
    rpc.jsonrpc !== '2.0' ||
    (rpc.id !== id && rpc.id !== null && rpc.id !== 'server-error') ||
    Object.hasOwn(rpc, 'result') ||
    !rpc.error ||
    typeof rpc.error !== 'object' ||
    Array.isArray(rpc.error)
  )
    return false;
  const error = rpc.error as Record<string, unknown>;
  function supportedLegacyVersion(requested: string, versions: string): boolean {
    const supported = versions.split(', ');
    return (
      requested === '2026-07-28' &&
      supported.includes('2025-11-25') &&
      new Set(supported).size === supported.length &&
      supported.every((version) => {
        const parsed = Date.parse(`${version}T00:00:00Z`);
        return (
          Number.isFinite(parsed) &&
          new Date(parsed).toISOString().slice(0, 10) === version &&
          version <= '2025-11-25'
        );
      })
    );
  }
  // Python SDK 1.30.0 uses this exact sentinel only for transport-level
  // rejections before dispatch. It is not accepted for generic RPC errors.
  if (rpc.id === 'server-error') {
    if (error.code !== -32600 || typeof error.message !== 'string') return false;
    if (error.message === 'Bad Request: Missing session ID') return true;
    const unsupported =
      /^Bad Request: Unsupported protocol version: (\d{4}-\d{2}-\d{2})\. Supported versions: (\d{4}-\d{2}-\d{2}(?:, \d{4}-\d{2}-\d{2})*)$/.exec(
        error.message,
      );
    return (
      !!unsupported?.[1] &&
      !!unsupported[2] &&
      supportedLegacyVersion(unsupported[1], unsupported[2])
    );
  }
  // TypeScript SDK 1.32.2 uses null for these exact transport rejections.
  if (error.code === -32000 && typeof error.message === 'string') {
    if (error.message === 'Bad Request: Server not initialized') return true;
    const unsupported =
      /^Bad Request: Unsupported protocol version: (\d{4}-\d{2}-\d{2}) \(supported versions: (\d{4}-\d{2}-\d{2}(?:, \d{4}-\d{2}-\d{2})*)\)$/.exec(
        error.message,
      );
    if (unsupported?.[1] && unsupported[2])
      return supportedLegacyVersion(unsupported[1], unsupported[2]);
  }
  // Recognized modern errors and all unrelated/mismatching request ids still
  // fail closed. Generic legacy evidence remains request-id matched only.
  return (
    rpc.id === id &&
    (error.code === -32000 || error.code === -32600) &&
    typeof error.message === 'string' &&
    /^(?:server(?: is)? not initialized|initialization required)\.?$/i.test(error.message)
  );
}
