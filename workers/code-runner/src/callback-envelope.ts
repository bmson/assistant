/** Leave room below the agent's 512 KiB request limit for future framing. */
export const CALLBACK_BYTE_LIMIT = 480 * 1024;
export interface CallbackResult {
  stdout: string;
  stderr: string;
  [key: string]: unknown;
}
function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function preview(value: string, budget: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedBytes(value.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  // Do not emit half a surrogate pair at the preview boundary.
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1] ?? '')) low--;
  return value.slice(0, low);
}

/** Bound the actual UTF-8 JSON envelope, preserving all non-log result fields. */
export function callbackEnvelope(taskId: string, token: string, result: CallbackResult): string {
  const envelope = { taskId, token, result };
  if (encodedBytes(envelope) <= CALLBACK_BYTE_LIMIT) return JSON.stringify(envelope);
  const next = {
    ...result,
    stdout: '',
    stderr: '',
    logPreview: {
      stdoutCapturedBytes: Buffer.byteLength(result.stdout, 'utf8'),
      stderrCapturedBytes: Buffer.byteLength(result.stderr, 'utf8'),
      stdoutPreviewTruncated: true,
      stderrPreviewTruncated: true,
    },
  };
  const overhead = encodedBytes({ taskId, token, result: next });
  if (overhead > CALLBACK_BYTE_LIMIT) throw new Error('code callback metadata exceeds byte limit');
  const available = Math.max(0, CALLBACK_BYTE_LIMIT - overhead - 64);
  // Empty JSON string quotes are already included in overhead.
  next.stdout = preview(result.stdout, Math.floor(available / 2) + 2);
  next.stderr = preview(result.stderr, available - (encodedBytes(next.stdout) - 2) + 2);
  next.logPreview.stdoutPreviewTruncated = next.stdout !== result.stdout;
  next.logPreview.stderrPreviewTruncated = next.stderr !== result.stderr;
  const body = JSON.stringify({ taskId, token, result: next });
  if (Buffer.byteLength(body, 'utf8') > CALLBACK_BYTE_LIMIT)
    throw new Error('code callback exceeds byte limit');
  return body;
}
