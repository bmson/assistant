import { describe, expect, it } from 'vitest';
import { advanceExternalEffect, type ExternalEffectProgress } from './external-effect.js';

const created: ExternalEffectProgress = {
  provider: 'google',
  kind: 'document',
  objectId: 'doc-1',
  stage: 'created',
  payloadDigest: 'a'.repeat(64),
};
describe('external effect checkpoint contract', () => {
  it('advances and replays the same provider object without changing approved bytes', () => {
    expect(advanceExternalEffect(null, created)).toEqual(created);
    const filled = advanceExternalEffect(created, { ...created, stage: 'filled' });
    expect(advanceExternalEffect(filled, filled)).toEqual(filled);
    expect(advanceExternalEffect(filled, { ...created, stage: 'shared' }).stage).toBe('shared');
  });
  it('rejects skipped/regressed stages, different object identities and changed approved bytes', () => {
    for (const patch of [
      { stage: 'shared' },
      { objectId: 'doc-2' },
      { payloadDigest: 'b'.repeat(64) },
      { kind: 'slides' },
    ])
      expect(() =>
        advanceExternalEffect(created, { ...created, ...patch } as ExternalEffectProgress),
      ).toThrow();
    expect(() => advanceExternalEffect({ ...created, stage: 'filled' }, created)).toThrow();
    expect(() => advanceExternalEffect(null, { ...created, stage: 'filled' })).toThrow();
  });
});
