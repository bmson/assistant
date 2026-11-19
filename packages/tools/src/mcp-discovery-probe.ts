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
    rpc.id !== id ||
    Object.hasOwn(rpc, 'result') ||
    !rpc.error ||
    typeof rpc.error !== 'object' ||
    Array.isArray(rpc.error)
  )
    return false;
  const error = rpc.error as Record<string, unknown>;
  // Unknown modern errors, invalid params, version/header/capability errors,
  // and method-not-found never become permission to switch protocol eras.
  return (
    (error.code === -32000 || error.code === -32600) &&
    typeof error.message === 'string' &&
    /^(?:server(?: is)? not initialized|initialization required)\.?$/i.test(error.message)
  );
}
