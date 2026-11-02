import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER,
  MAX_RECOVERY_CONFLICT_CALLBACKS_TOTAL,
  OwnerEditorRecoveryConflictBarrier,
} from './owner-editor-recovery-conflict.test-support.js';

describe('owner-editor recovery conflict barrier', () => {
  afterEach(() => vi.useRealTimers());

  it('does not count retries of one client as a second preparing participant', async () => {
    vi.useFakeTimers();
    const barrier = new OwnerEditorRecoveryConflictBarrier(5_000);
    try {
      barrier.callbackStarted(0);
      const first = barrier.waitForBothPreparing(0);
      barrier.callbackStarted(0);
      const retry = barrier.waitForBothPreparing(0);
      expect(barrier.snapshot()).toMatchObject({
        firstAttemptClients: [0],
        callbackEntries: [2, 0],
        preparingReads: [2, 0],
        distinctPreparingClients: [0],
        timedOut: false,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(first).resolves.toBe('timeout');
      await expect(retry).resolves.toBe('timeout');
      expect(barrier.snapshot().timedOut).toBe(true);
    } finally {
      barrier.dispose();
    }
  });

  it('opens for two distinct racers while allowing extra preparing reads from retries', async () => {
    vi.useFakeTimers();
    const barrier = new OwnerEditorRecoveryConflictBarrier();
    try {
      barrier.callbackStarted(0);
      const first = barrier.waitForBothPreparing(0);
      barrier.callbackStarted(0);
      const retry = barrier.waitForBothPreparing(0);
      barrier.callbackStarted(1);
      const second = barrier.waitForBothPreparing(1);
      await expect(Promise.all([first, retry, second])).resolves.toEqual([
        'both-racers-preparing',
        'both-racers-preparing',
        'both-racers-preparing',
      ]);
      expect(barrier.snapshot()).toMatchObject({
        firstAttemptClients: [0, 1],
        callbackEntries: [2, 1],
        preparingReads: [2, 1],
        distinctPreparingClients: [0, 1],
        totalCallbacks: 3,
        totalPreparingReads: 3,
        timedOut: false,
      });
    } finally {
      barrier.dispose();
    }
  });

  it('disposes blocked callbacks and enforces per-client and total callback bounds', async () => {
    const barrier = new OwnerEditorRecoveryConflictBarrier(5_000);
    const blocked = barrier.waitForBothPreparing(0);
    barrier.dispose();
    await expect(blocked).resolves.toBe('disposed');
    expect(barrier.snapshot().disposed).toBe(true);
    expect(() => barrier.callbackStarted(0)).toThrow('disposed');

    const bounded = new OwnerEditorRecoveryConflictBarrier(5_000);
    try {
      for (let index = 0; index < MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER; index += 1)
        bounded.callbackStarted(0);
      for (let index = 0; index < MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER; index += 1)
        bounded.callbackStarted(1);
      expect(bounded.snapshot().totalCallbacks).toBe(MAX_RECOVERY_CONFLICT_CALLBACKS_TOTAL);
      expect(() => bounded.callbackStarted(0)).toThrow('callback bound exceeded');
      expect(bounded.snapshot().callbackEntries).toEqual([
        MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER,
        MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER,
      ]);
    } finally {
      bounded.dispose();
    }
  });
});
