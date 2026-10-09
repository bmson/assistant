import { randomUUID } from 'node:crypto';
import type {
  EmailObserverBudgetInput,
  EmailObserverClaim,
  EmailObserverIdentity,
  EmailObserverTransitionInput,
} from '@assistant/persistence';
import type { ModuleServices } from './platform.js';

/** One bounded observer drain. Provider effects are never retried by this loop. */
export interface EmailObserverDrainResult {
  claimed: number;
  completed: number;
  noOp: number;
  failed: number;
  unknown: number;
  skippedBudget: number;
}

const EMPTY: EmailObserverDrainResult = {
  claimed: 0,
  completed: 0,
  noOp: 0,
  failed: 0,
  unknown: 0,
  skippedBudget: 0,
};

function registryKey(identity: EmailObserverIdentity): string {
  return `${identity.key}\u0000${identity.version}\u0000${identity.workClass}`;
}

function budgetFor(
  services: ModuleServices,
  observer: EmailObserverIdentity,
  now: Date,
): EmailObserverBudgetInput | undefined {
  if (observer.workClass !== 'paid_ambiguous') return undefined;
  const limit = services.config.EMAIL_OBSERVER_MAX_PAID_PER_DAY;
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return undefined;
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    budgetKey: observer.key,
    observerKey: observer.key,
    limit,
    windowStart,
    windowEnd: new Date(windowStart.getTime() + 24 * 60 * 60 * 1000),
  };
}

function transitionFor(claim: EmailObserverClaim, now: Date): EmailObserverTransitionInput {
  return {
    id: claim.id,
    agentId: claim.agentId,
    claimToken: claim.claimToken,
    claimGeneration: claim.claimGeneration,
    expectedPrivacyGeneration: claim.privacyGeneration,
    now,
  };
}

function safeErrorCode(value: string): string {
  return /^[a-z0-9_.-]{1,64}$/.test(value) ? value : 'observer_failed';
}

/**
 * Claims due work by its stable persisted identity. A prepared result is
 * applied without recomposition; an ambiguous paid/provider failure is held
 * as unknown and never retried by this runner.
 */
export async function drainEmailObservers(
  services: ModuleServices,
  agentId: string,
  options: { now?: Date; limit?: number; shouldContinue?: () => Promise<boolean> | boolean } = {},
): Promise<EmailObserverDrainResult> {
  const repository = services.persistence.emailSync;
  if (!repository) throw new Error('email observer persistence is unavailable');
  if (!repository.privacyObservationFence)
    throw new Error('email observer privacy fence is unavailable');
  const canContinue = async () =>
    (!options.shouldContinue || (await options.shouldContinue())) &&
    (!services.operationalReady || (await services.operationalReady()));
  if (!(await canContinue())) return { ...EMPTY };
  const nowForAttempt = () => (options.now ? new Date(options.now) : new Date());
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
  const privacyGeneration = await repository.privacyObservationFence(agentId);
  const listedAt = nowForAttempt();
  const handlers = new Map(
    services.durableEmailObservers.map((handler) => [registryKey(handler.identity), handler]),
  );
  const excludedObserverIdentities: EmailObserverIdentity[] = [];
  for (const handler of handlers.values()) {
    if (handler.shouldRun && !(await handler.shouldRun(services))) {
      excludedObserverIdentities.push(handler.identity);
    }
  }
  const due = await repository.listDueEmailObservers(
    agentId,
    listedAt,
    limit,
    excludedObserverIdentities,
  );
  const result = { ...EMPTY };

  for (const work of due) {
    if (work.agentId !== agentId) continue;
    if (!(await canContinue())) break;
    const identity: EmailObserverIdentity = {
      key: work.observerKey,
      version: work.observerVersion,
      workClass: work.workClass,
    };
    const handler = handlers.get(registryKey(identity));
    if (handler?.shouldRun && !(await handler.shouldRun(services))) continue;
    const claimNow = nowForAttempt();
    const paidBudget =
      work.workClass === 'paid_ambiguous' ? budgetFor(services, identity, claimNow) : undefined;
    if (handler?.identity.workClass === 'paid_ambiguous' && !paidBudget) {
      // This row is not claimed because the budget is required to make a paid
      // admission. Report it and keep it due for an operator-visible fix.
      result.failed++;
      continue;
    }
    const claimResult = await repository.claimEmailObserver({
      id: work.id,
      agentId,
      token: randomUUID(),
      now: claimNow,
      leaseMs: 60_000,
      expectedPrivacyGeneration: privacyGeneration,
      ...(paidBudget ? { paidBudget } : {}),
    });
    if (claimResult.kind === 'none') continue;
    if (claimResult.kind === 'skipped_budget') {
      result.skippedBudget++;
      continue;
    }
    const claim = claimResult.claim;
    result.claimed++;
    const shouldRun = async () =>
      (await canContinue()) && (!handler?.shouldRun || (await handler.shouldRun(services)));
    const pauseClaim = async (prepared: boolean) => {
      const common = {
        ...transitionFor(claim, new Date()),
        errorCode: 'observer_paused',
      };
      // A paid reservation is released only when no provider composition ran.
      // A checkpointed result keeps its reservation so it can resume without
      // paying again when the feature is enabled.
      const unusedPaidAttempt =
        claim.workClass === 'paid_ambiguous' && !prepared && claim.preparedResult == null;
      await repository.failEmailObserver({
        ...common,
        outcome: unusedPaidAttempt ? 'budget_blocked' : 'retryable_failed',
      });
    };
    if (!(await shouldRun())) {
      await pauseClaim(claim.status === 'prepared' || claim.preparedResult != null);
      if (!(await canContinue())) break;
      continue;
    }
    if (!handler) {
      await repository.failEmailObserver({
        id: claim.id,
        agentId,
        claimToken: claim.claimToken,
        claimGeneration: claim.claimGeneration,
        expectedPrivacyGeneration: claim.privacyGeneration,
        now: new Date(),
        outcome: 'unknown',
        errorCode: 'observer_handler_missing',
      });
      result.unknown++;
      continue;
    }

    try {
      const source = await repository.loadEmailObserverSource(claim);
      if (!source) {
        await repository.failEmailObserver({
          ...transitionFor(claim, new Date()),
          outcome: 'unknown',
          errorCode: 'email_source_missing',
        });
        result.unknown++;
        continue;
      }

      let preparedResult = claim.preparedResult;
      if (claim.status !== 'prepared') {
        if (!(await shouldRun())) {
          await pauseClaim(false);
          if (!(await canContinue())) break;
          continue;
        }
        const prepared = await handler.prepare(services, source, claim);
        if (prepared.kind === 'no_op') {
          await repository.failEmailObserver({
            ...transitionFor(claim, new Date()),
            outcome: 'no_op',
          });
          result.noOp++;
          continue;
        }
        if (prepared.kind === 'unknown') {
          await repository.failEmailObserver({
            ...transitionFor(claim, new Date()),
            outcome: 'unknown',
            errorCode: safeErrorCode(prepared.errorCode),
          });
          result.unknown++;
          continue;
        }
        if (prepared.kind === 'budget_blocked') {
          await repository.failEmailObserver({
            ...transitionFor(claim, new Date()),
            outcome: 'budget_blocked',
            errorCode: 'observer_budget_blocked',
          });
          result.skippedBudget++;
          continue;
        }
        const persisted = await repository.prepareEmailObserver({
          ...transitionFor(claim, new Date()),
          result: prepared.result,
        });
        if (!persisted) {
          result.failed++;
          continue;
        }
        preparedResult = prepared.result;
      }

      if (!(await shouldRun())) {
        await pauseClaim(preparedResult != null);
        if (!(await canContinue())) break;
        continue;
      }
      const effect = await handler.apply(services, source, claim, preparedResult);
      const transition = transitionFor(claim, new Date());
      if (effect.kind === 'complete') {
        if (await repository.completeEmailObserver(transition)) result.completed++;
        else result.failed++;
      } else if (effect.kind === 'no_op') {
        if (await repository.failEmailObserver({ ...transition, outcome: 'no_op' })) result.noOp++;
        else result.failed++;
      } else if (effect.kind === 'retryable_failed') {
        if (
          await repository.failEmailObserver({
            ...transition,
            outcome: 'retryable_failed',
            errorCode: safeErrorCode(effect.errorCode),
          })
        )
          result.failed++;
        else result.failed++;
      } else {
        await repository.failEmailObserver({
          ...transition,
          outcome: 'unknown',
          errorCode: safeErrorCode(effect.errorCode),
        });
        result.unknown++;
      }
    } catch {
      // A thrown handler may have crossed an external-effect boundary. Do not
      // log email text or retry it as if acceptance were known.
      await repository.failEmailObserver({
        ...transitionFor(claim, new Date()),
        outcome: 'unknown',
        errorCode: 'observer_threw',
      });
      result.unknown++;
    }
  }
  return result;
}

/** Validate duplicate keys at composition time, before any mail is admitted. */
export function validateEmailObserverRegistry(
  handlers: readonly { identity: EmailObserverIdentity }[],
): void {
  const seen = new Map<string, EmailObserverIdentity>();
  for (const handler of handlers) {
    const { key, version, workClass } = handler.identity;
    if (
      !/^[a-z][a-z0-9_.:-]{2,100}$/.test(key) ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !['idempotent_db', 'paid_ambiguous', 'external_provider'].includes(workClass)
    )
      throw new Error('invalid inbound email observer identity');
    const identity = { key, version, workClass };
    const encoded = `${key}\u0000${version}`;
    const prior = seen.get(encoded);
    if (prior) {
      if (prior.workClass !== workClass)
        throw new Error(`conflicting inbound email observer work class ${key}@${version}`);
      throw new Error(`duplicate inbound email observer ${key}@${version}`);
    }
    seen.set(encoded, identity);
  }
}

/** The shared paid-work policy is independent of the forwarded triage cap. */
export const EMAIL_OBSERVER_PAID_WORK_DEFAULT = 20;
