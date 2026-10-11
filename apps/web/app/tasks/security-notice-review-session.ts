import type { OwnerSecurityReviewItem } from '@assistant/application/security-incidents';
import {
  decideSecurityReview,
  listSecurityReviews,
  type SecurityReviewDecisionResult,
} from './security-notice-review-client';

export interface SecurityReviewState {
  items: OwnerSecurityReviewItem[];
  loadState: 'loading' | 'ready' | 'unavailable';
  refreshing: boolean;
  pendingId: string | null;
  message: string;
  staleList: boolean;
}

export interface SecurityReviewTransport {
  list(signal: AbortSignal): Promise<OwnerSecurityReviewItem[]>;
  decide(
    incidentId: string,
    body: { expectedRevision: number; disposition: 'expected' | 'dismissed'; reason: string },
    signal: AbortSignal,
  ): Promise<SecurityReviewDecisionResult>;
}

const defaultTransport: SecurityReviewTransport = {
  list: (signal) => listSecurityReviews(signal),
  decide: (incidentId, body, signal) => decideSecurityReview(incidentId, body, signal),
};

export class SecurityReviewSession {
  readonly ownerId: string;
  private readonly transport: SecurityReviewTransport;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private lifecycle = 0;
  private disposed = false;
  private active = false;
  private mutationInFlight = false;
  private listController: AbortController | null = null;
  private mutationController: AbortController | null = null;
  private state: SecurityReviewState = {
    items: [],
    loadState: 'loading',
    refreshing: false,
    pendingId: null,
    message: '',
    staleList: false,
  };

  constructor(ownerId: string, transport: SecurityReviewTransport = defaultTransport) {
    this.ownerId = ownerId;
    this.transport = transport;
  }

  readonly getSnapshot = (): SecurityReviewState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(next: Partial<SecurityReviewState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => {
      listener();
    });
  }

  start(): void {
    if (this.active) return;
    this.disposed = false;
    this.active = true;
    this.lifecycle += 1;
    void this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.lifecycle += 1;
    this.generation += 1;
    this.listController?.abort();
    this.mutationController?.abort();
    this.listController = null;
    this.mutationController = null;
    this.mutationInFlight = false;
    this.state = { ...this.state, pendingId: null, refreshing: false };
  }

  async refresh(
    options: { message?: string; pendingMessage?: string; failureMessage?: string } = {},
  ): Promise<void> {
    if (this.disposed) return;
    const requestGeneration = ++this.generation;
    const requestLifecycle = this.lifecycle;
    const requestOwnerId = this.ownerId;
    this.listController?.abort();
    const controller = new AbortController();
    this.listController = controller;
    this.update({
      refreshing: true,
      ...(options.pendingMessage ? { message: options.pendingMessage } : {}),
    });
    try {
      const items = await this.transport.list(controller.signal);
      if (!this.isCurrent(requestGeneration, requestLifecycle, requestOwnerId)) return;
      this.update({
        items,
        loadState: 'ready',
        message: options.message ?? '',
        refreshing: false,
        staleList: false,
      });
    } catch {
      if (!this.isCurrent(requestGeneration, requestLifecycle, requestOwnerId)) return;
      const hadSnapshot = this.state.loadState === 'ready';
      this.update({
        loadState: hadSnapshot ? 'ready' : 'unavailable',
        message: options.failureMessage ?? 'Security reviews could not be refreshed. Try again.',
        refreshing: false,
        staleList: hadSnapshot,
      });
    } finally {
      if (this.isCurrent(requestGeneration, requestLifecycle, requestOwnerId))
        this.listController = null;
    }
  }

  async decide(
    item: OwnerSecurityReviewItem,
    disposition: 'expected' | 'dismissed',
  ): Promise<void> {
    if (this.disposed || this.mutationInFlight) return;
    this.mutationInFlight = true;
    const requestLifecycle = this.lifecycle;
    const requestOwnerId = this.ownerId;
    const controller = new AbortController();
    this.mutationController = controller;
    this.update({ pendingId: item.incidentId, message: '' });
    let result: SecurityReviewDecisionResult = 'uncertain';
    try {
      try {
        result = await this.transport.decide(
          item.incidentId,
          {
            expectedRevision: item.revision,
            disposition,
            reason:
              disposition === 'expected'
                ? 'Owner marked this activity as expected.'
                : 'Owner dismissed this notice.',
          },
          controller.signal,
        );
      } catch {
        result = 'uncertain';
      }
      if (!this.isCurrentLifecycle(requestLifecycle, requestOwnerId)) return;
      const options =
        result === 'saved'
          ? {
              message: 'Decision saved.',
              pendingMessage: 'Decision saved. Refreshing the review list…',
              failureMessage:
                'Decision saved. The displayed review list may be out of date; refresh to confirm the latest state.',
            }
          : result === 'stale'
            ? {
                message: 'This review changed. The latest version is now loaded.',
                pendingMessage: 'Checking the latest review…',
                failureMessage:
                  'This review changed, but the latest version could not be loaded. Refresh before deciding again.',
              }
            : {
                message:
                  'The decision response was unclear. The current review list has been reloaded; check its state before trying again.',
                pendingMessage: 'Checking the current review list…',
                failureMessage:
                  'The decision response was unclear and the list could not be refreshed. Review it before trying again.',
              };
      await this.refresh(options);
    } finally {
      if (this.isCurrentLifecycle(requestLifecycle, requestOwnerId)) {
        this.mutationController = null;
        this.mutationInFlight = false;
        this.update({ pendingId: null });
      }
    }
  }

  private isCurrent(generation: number, lifecycle: number, ownerId: string): boolean {
    return (
      !this.disposed &&
      this.generation === generation &&
      this.isCurrentLifecycle(lifecycle, ownerId)
    );
  }

  private isCurrentLifecycle(lifecycle: number, ownerId: string): boolean {
    return !this.disposed && this.lifecycle === lifecycle && this.ownerId === ownerId;
  }
}
