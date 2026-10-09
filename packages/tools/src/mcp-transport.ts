/** A request stream settles only on its own JSON-RPC response, never a notification. */
export interface McpRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}
export class AmbiguousMcpMutationError extends Error {
  readonly effectStatus = 'unknown' as const;
  constructor() {
    super(
      'The remote MCP action may have completed. Its response was not confirmed; automatic retry is suppressed.',
    );
    this.name = 'AmbiguousMcpMutationError';
  }
}
export function isAmbiguousMcpMutationError(value: unknown): value is AmbiguousMcpMutationError {
  return value instanceof AmbiguousMcpMutationError;
}
function matched(value: unknown, id: unknown): McpRpcResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.jsonrpc !== '2.0' || row.id !== id || (!('result' in row) && !('error' in row)))
    return null;
  if ('error' in row && (!row.error || typeof row.error !== 'object' || Array.isArray(row.error)))
    throw new Error('MCP server returned an invalid RPC error.');
  return row as unknown as McpRpcResponse;
}
export async function readMcpRpcResponse(
  response: Response,
  id: unknown,
  signal: AbortSignal,
  options: { maxBytes?: number; onNotification?: (value: Record<string, unknown>) => void } = {},
): Promise<McpRpcResponse> {
  const maxBytes = options.maxBytes ?? 300_000;
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes)
    throw new Error('MCP response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('MCP server did not return a response body.');
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let interrupted: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    interrupted = () => reject(new Error('MCP response deadline exceeded.'));
    signal.addEventListener('abort', interrupted, { once: true });
    if (signal.aborted) interrupted();
  });
  const event = (frame: string): McpRpcResponse | null => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return null;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error('MCP server returned invalid event JSON.');
    }
    const result = matched(value, id);
    if (result) return result;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      if (row.jsonrpc === '2.0' && typeof row.method === 'string' && !('id' in row))
        options.onNotification?.(row);
      else if (typeof row.method === 'string' && 'id' in row)
        throw new Error('MCP server requests are unsupported by this client.');
    }
    return null;
  };
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abort]);
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('MCP response is too large.');
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      if (sse) {
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary) break;
          const result = event(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (result) return result;
        }
      } else if (done) {
        let value: unknown;
        try {
          value = JSON.parse(buffer);
        } catch {
          throw new Error('MCP server returned invalid JSON.');
        }
        const result = matched(value, id);
        if (result) return result;
      }
      if (done) throw new Error('MCP stream ended without a matching request response.');
    }
  } finally {
    if (interrupted) signal.removeEventListener('abort', interrupted);
    // A server may leave SSE open after its result. Cancellation must not wait for that server.
    void reader.cancel().catch(() => {});
  }
}
