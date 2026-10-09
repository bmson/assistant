import { describe, expect, it } from 'vitest';
import { estimateSmsSegments } from './sms-segments.js';

describe('SMS segment estimation', () => {
  it('uses GSM-7 single and concatenated limits', () => {
    expect(estimateSmsSegments('a'.repeat(160))).toMatchObject({
      encoding: 'gsm7',
      encodedUnits: 160,
      submittedMessages: 1,
      estimatedSegments: 1,
    });
    expect(estimateSmsSegments('a'.repeat(161))).toMatchObject({
      encoding: 'gsm7',
      encodedUnits: 161,
      estimatedSegments: 2,
    });
  });

  it('counts GSM-7 extension-table symbols as two septets each', () => {
    expect(estimateSmsSegments('^'.repeat(80))).toMatchObject({
      encoding: 'gsm7',
      encodedUnits: 160,
      estimatedSegments: 1,
    });
    expect(estimateSmsSegments('^'.repeat(81))).toMatchObject({
      encoding: 'gsm7',
      encodedUnits: 162,
      estimatedSegments: 2,
    });
  });

  it('switches the full body to UCS-2 for emoji and non-Latin text', () => {
    expect(estimateSmsSegments('😀'.repeat(35))).toMatchObject({
      encoding: 'ucs2',
      encodedUnits: 70,
      estimatedSegments: 1,
    });
    expect(estimateSmsSegments('😀'.repeat(36))).toMatchObject({
      encoding: 'ucs2',
      encodedUnits: 72,
      estimatedSegments: 2,
    });
    expect(estimateSmsSegments('你好')).toMatchObject({ encoding: 'ucs2', encodedUnits: 2 });
  });

  it('keeps long-body estimates bounded by encoded units, not code points', () => {
    expect(estimateSmsSegments('x'.repeat(1500))).toMatchObject({
      encoding: 'gsm7',
      encodedUnits: 1500,
      estimatedSegments: 10,
    });
    expect(estimateSmsSegments('😀'.repeat(750))).toMatchObject({
      encoding: 'ucs2',
      encodedUnits: 1500,
      estimatedSegments: 23,
    });
  });
});
