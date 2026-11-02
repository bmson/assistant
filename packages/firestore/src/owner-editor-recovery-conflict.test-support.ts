export const RECOVERY_CONFLICT_TIMEOUT_MS = 5_000;
export const MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER = 9;
export const MAX_RECOVERY_CONFLICT_CALLBACKS_TOTAL = 18;

export type RecoveryConflictRacer = 0 | 1;
export type RecoveryConflictBarrierResult = 'both-racers-preparing' | 'timeout' | 'disposed';

export interface RecoveryConflictBarrierSnapshot {
  timeoutMs: number;
  firstAttemptClients: RecoveryConflictRacer[];
  callbackEntries: [number, number];
  preparingReads: [number, number];
  distinctPreparingClients: RecoveryConflictRacer[];
  totalCallbacks: number;
  totalPreparingReads: number;
  timedOut: boolean;
  disposed: boolean;
}

/** Test-only rendezvous that distinguishes two racers from retries of one racer. */
export class OwnerEditorRecoveryConflictBarrier {
  private readonly callbackEntries: [number, number] = [0, 0];
  private readonly preparingReads: [number, number] = [0, 0];
  private readonly preparingClients = new Set<RecoveryConflictRacer>();
  private readonly firstAttemptClients = new Set<RecoveryConflictRacer>();
  private readonly opened: Promise<RecoveryConflictBarrierResult>;
  private resolveOpened!: (result: RecoveryConflictBarrierResult) => void;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  private disposed = false;
  private totalCallbacks = 0;

  constructor(readonly timeoutMs = RECOVERY_CONFLICT_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw new Error('Conflict barrier timeout is out of bounds');
    this.opened = new Promise((resolve) => {
      this.resolveOpened = resolve;
    });
    this.timeout = setTimeout(() => {
      if (this.preparingClients.size >= 2 || this.disposed) return;
      this.timedOut = true;
      this.timeout = undefined;
      this.resolveOpened('timeout');
    }, timeoutMs);
  }

  callbackStarted(racer: RecoveryConflictRacer): void {
    if (this.disposed) throw new Error('Conflict barrier is disposed');
    if (
      this.callbackEntries[racer] >= MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER ||
      this.totalCallbacks >= MAX_RECOVERY_CONFLICT_CALLBACKS_TOTAL
    )
      throw new Error('Conflict barrier callback bound exceeded');
    if (this.callbackEntries[racer] === 0) this.firstAttemptClients.add(racer);
    this.callbackEntries[racer] += 1;
    this.totalCallbacks += 1;
  }

  async waitForBothPreparing(racer: RecoveryConflictRacer): Promise<RecoveryConflictBarrierResult> {
    if (this.disposed) return 'disposed';
    this.preparingReads[racer] += 1;
    this.preparingClients.add(racer);
    if (this.preparingClients.size === 2) {
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = undefined;
      this.resolveOpened('both-racers-preparing');
    }
    return this.opened;
  }

  snapshot(): RecoveryConflictBarrierSnapshot {
    return {
      timeoutMs: this.timeoutMs,
      firstAttemptClients: [...this.firstAttemptClients].sort(),
      callbackEntries: [...this.callbackEntries],
      preparingReads: [...this.preparingReads],
      distinctPreparingClients: [...this.preparingClients].sort(),
      totalCallbacks: this.totalCallbacks,
      totalPreparingReads: this.preparingReads[0] + this.preparingReads[1],
      timedOut: this.timedOut,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.resolveOpened('disposed');
  }
}
