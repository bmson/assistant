import { describe, expect, it } from 'vitest';
import { coalesce } from './coalesce';

describe('coalesce', () => {
  it('runs one computation for callers that overlap', async () => {
    let runs = 0;
    let release: (value: number) => void = () => {};
    const work = () => {
      runs += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };
    const first = coalesce('same', work);
    const second = coalesce('same', work);
    release(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(runs).toBe(1);
  });

  it('never serves a settled result to a later caller', async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      return runs;
    };
    expect(await coalesce('later', work)).toBe(1);
    expect(await coalesce('later', work)).toBe(2);
  });

  it('keeps different keys apart and shares a failure only with those who waited on it', async () => {
    const failing = coalesce('boom', () => Promise.reject(new Error('read failed')));
    const waiting = coalesce('boom', async () => 'unused');
    await expect(failing).rejects.toThrow('read failed');
    await expect(waiting).rejects.toThrow('read failed');
    expect(await coalesce('boom', async () => 'recovered')).toBe('recovered');
    expect(await coalesce('other', async () => 'independent')).toBe('independent');
  });
});
