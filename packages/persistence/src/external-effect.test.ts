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
  it('retains a Calendar operation before its POST and verifies only that same object', () => {
    const prepared: ExternalEffectProgress = {
      ...created,
      kind: 'calendar_event',
      objectId: 'ac0123456789abcdef',
      stage: 'prepared',
    };
    expect(advanceExternalEffect(null, prepared)).toEqual(prepared);
    expect(() => advanceExternalEffect(prepared, { ...prepared, stage: 'verified' })).toThrow(
      'skipped',
    );
    const accepted = advanceExternalEffect(prepared, { ...prepared, stage: 'created' });
    expect(advanceExternalEffect(accepted, { ...prepared, stage: 'verified' }).stage).toBe(
      'verified',
    );
    expect(() => advanceExternalEffect(accepted, prepared)).toThrow('stale');
    expect(() =>
      advanceExternalEffect(prepared, { ...prepared, objectId: 'another', stage: 'created' }),
    ).toThrow('identity');
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
