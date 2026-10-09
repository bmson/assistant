import { createHash, randomUUID } from 'node:crypto';

export type VisualEvidenceMode =
  | 'static-source'
  | 'static-frozen-baseline'
  | 'hydrated-synthetic'
  | 'real-route'
  | 'native-device';
export interface VisualCaptureInputs {
  htmlSha256: string;
  componentSha256: string;
  stylesheetSha256: string;
  buildSha256: string;
}
export interface VisualCaptureReceipt {
  id: string;
  capturedAt: string;
  mode: VisualEvidenceMode;
  screenshotSha256: string;
  inputs: VisualCaptureInputs;
}
export function visualHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function visualCaptureReceipt(
  mode: VisualEvidenceMode,
  inputs: VisualCaptureInputs,
  pixels: Uint8Array,
  now = new Date(),
): VisualCaptureReceipt {
  return {
    id: randomUUID(),
    capturedAt: now.toISOString(),
    mode,
    screenshotSha256: visualHash(pixels),
    inputs: { ...inputs },
  };
}
export function visualCaptureFreshness(
  receipt: VisualCaptureReceipt | undefined,
  current: VisualCaptureInputs,
  mode: VisualEvidenceMode,
): 'current' | 'stale' | 'unknown' {
  if (!receipt?.inputs) return 'unknown';
  return receipt.mode === mode &&
    (Object.keys(current) as Array<keyof VisualCaptureInputs>).every(
      (key) => receipt.inputs[key] === current[key],
    )
    ? 'current'
    : 'stale';
}
export function requireCurrentVisualCoverage(
  rows: Array<{ screenshot: string; freshness: string }>,
): void {
  const missing = rows.filter((row) => row.freshness !== 'current');
  if (missing.length)
    throw new Error(
      `Current visual coverage is incomplete: ${missing.map((row) => row.screenshot).join(', ')}`,
    );
}
