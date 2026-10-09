import { describe, expect, it } from 'vitest';
import {
  requireCurrentVisualCoverage,
  type VisualCaptureInputs,
  visualCaptureFreshness,
  visualCaptureReceipt,
} from './visual-capture-provenance.js';

const original: VisualCaptureInputs = {
  htmlSha256: 'html',
  componentSha256: 'source1',
  stylesheetSha256: 'css1',
  buildSha256: 'build1',
};
describe('immutable visual capture provenance', () => {
  it('keeps unrefreshed captures stale after a selective shared CSS recapture', () => {
    const a = visualCaptureReceipt(
      'static-source',
      original,
      new Uint8Array([1]),
      new Date('2026-10-07T00:00Z'),
    );
    const b = visualCaptureReceipt(
      'static-source',
      original,
      new Uint8Array([2]),
      new Date('2026-10-07T00:00Z'),
    );
    const next = { ...original, stylesheetSha256: 'css2' };
    const refreshed = visualCaptureReceipt('static-source', next, new Uint8Array([3]));
    expect(visualCaptureFreshness(refreshed, next, 'static-source')).toBe('current');
    expect(visualCaptureFreshness(b, next, 'static-source')).toBe('stale');
    expect(a.inputs.stylesheetSha256).toBe('css1');
    expect(b.inputs.stylesheetSha256).toBe('css1');
    expect(refreshed.id).not.toBe(a.id);
    expect(() =>
      requireCurrentVisualCoverage([
        { screenshot: 'A', freshness: 'current' },
        { screenshot: 'B', freshness: 'stale' },
      ]),
    ).toThrow('B');
  });
  it.each(['htmlSha256', 'componentSha256', 'buildSha256'] as const)(
    'invalidates changed %s without rewriting the original receipt',
    (key) => {
      const receipt = visualCaptureReceipt('hydrated-synthetic', original, new Uint8Array([1]));
      expect(
        visualCaptureFreshness(receipt, { ...original, [key]: 'new' }, 'hydrated-synthetic'),
      ).toBe('stale');
      expect(receipt.inputs[key]).toBe(original[key]);
    },
  );
  it('keeps evidence modes separate and treats old unprovenanced captures as unknown', () => {
    const receipt = visualCaptureReceipt('static-frozen-baseline', original, new Uint8Array([1]));
    expect(visualCaptureFreshness(receipt, original, 'real-route')).toBe('stale');
    expect(visualCaptureFreshness(undefined, original, 'static-source')).toBe('unknown');
    expect(() =>
      requireCurrentVisualCoverage([{ screenshot: 'old', freshness: 'unknown' }]),
    ).toThrow('old');
  });
});
