import { describe, expect, it } from 'vitest';
import { isMissionSessionTask } from './context-helpers.js';

describe('isMissionSessionTask', () => {
  const valid = {
    type: 'adhoc',
    parentTaskId: 'm-123',
    trust: 'owner',
    trigger: {
      source: 'mission_wake',
      payload: { missionId: 'm-123', instruction: 'continue the current mission' },
    },
  } as const;

  it('requires a mission-wake child bound to its exact parent and an allowed trust', () => {
    expect(isMissionSessionTask(valid)).toBe(true);
    expect(isMissionSessionTask({ ...valid, parentTaskId: 'm-other' })).toBe(false);
    expect(isMissionSessionTask({ ...valid, type: 'chat_turn' })).toBe(false);
    expect(isMissionSessionTask({ ...valid, trust: 'unknown' })).toBe(false);
    expect(
      isMissionSessionTask({ ...valid, trigger: { ...valid.trigger, source: 'internal' } }),
    ).toBe(false);
  });

  it('is false for a D9 known-sender-reply child (adhoc, no mission id)', () => {
    expect(
      isMissionSessionTask({
        trigger: { payload: { kind: 'known_sender_reply', to: 'x@y.z' } },
      } as never),
    ).toBe(false);
  });

  it('is false when there is no payload or a non-string mission id', () => {
    expect(isMissionSessionTask({ ...valid, trigger: {} })).toBe(false);
    expect(isMissionSessionTask({ ...valid, trigger: null as never })).toBe(false);
    expect(
      isMissionSessionTask({
        ...valid,
        trigger: { source: 'mission_wake', payload: { missionId: 42 } },
      }),
    ).toBe(false);
  });
});
