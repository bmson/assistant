import { buildEmailContentProvenance } from '@assistant/core';
import type { EmailObserverClaim, EmailObserverSource } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleServices } from '../platform.js';
import { googleDurableEmailObservers } from './durable-email-observers.js';

function routingObserver() {
  const observer = googleDurableEmailObservers({} as never).find(
    ({ identity }) => identity.key === 'google.direct-email-routing',
  );
  if (!observer) throw new Error('direct routing observer is not registered');
  return observer;
}

function source(route: 'application_confirmation' | 'email_triage'): EmailObserverSource {
  return {
    agentId: 'owner-id',
    messageId: 'source-message-uuid',
    sourceId: 'source-message-uuid',
    from: 'hr@company.example',
    subject: 'Offer confirmed',
    body: 'Offer confirmed REF-12345',
    emailContentProvenance: buildEmailContentProvenance({
      subject: 'Offer confirmed',
      fullBody: 'Offer confirmed REF-12345',
      storedBody: 'Offer confirmed REF-12345',
      messagePrefix: '',
      authenticated: true,
      mode: 'direct',
      parts: [],
    }),
    authenticated: true,
    origin: 'known_contact',
    contentTrust: 'known',
    ingestMode: 'direct',
    sourceVerification: 'authenticated',
    hasExternalOrUnknown: false,
    directRouting: route,
  } as EmailObserverSource;
}

function claim(route: 'application_confirmation' | 'email_triage'): EmailObserverClaim {
  return {
    id: 'observer-id',
    agentId: 'owner-id',
    sourceKey: 'gmail:provider-id',
    channelMessageId: 'gmail:provider-id',
    sourceKind: 'message',
    observerKey: 'google.direct-email-routing',
    observerVersion: 1,
    workClass: 'idempotent_db',
    status: 'prepared',
    attemptCount: 1,
    claimToken: 'claim-token',
    claimGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    privacyGeneration: null,
    budgetKey: null,
    budgetWindowStart: null,
    budgetReserved: false,
    preparedResult: { route },
    deliveryKey: null,
    lastErrorCode: null,
    claimedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function taskRepository() {
  return {
    kind: 'task-lease-repository',
    createTask: vi.fn(async (input: Record<string, unknown>) => ({
      created: false,
      task: {
        id: 'already-created-task',
        status: 'pending',
        queueGeneration: 1,
        ...input,
      },
    })),
  };
}

function admittedIngest(route: 'application_confirmation' | 'email_triage') {
  return {
    id: 'ingest-id',
    agentId: 'owner-id',
    ingestMode: 'direct',
    directRouting: route,
    admittedSourceKind: 'message',
    admittedSourceId: 'source-message-uuid',
    providerMessageId: 'provider-id',
    providerThreadId: 'thread-id',
    sourceMessageId: '<rfc@example.test>',
    emailContentProvenance: { version: 1 },
    preparedClassification: { automated: false },
    conversationId: 'conversation-id',
    importance: 3,
    category: 'work',
  };
}

describe('durable direct email routing', () => {
  it('persists the route selected by atomic admission as the observer preparation', async () => {
    await expect(
      routingObserver().prepare(
        {} as ModuleServices,
        source('email_triage'),
        claim('email_triage'),
      ),
    ).resolves.toEqual({
      kind: 'prepared',
      result: { route: 'email_triage' },
    });
  });

  it('enqueues exactly one ordinary triage task from the frozen triage disposition', async () => {
    const tasks = taskRepository();
    const ingest = admittedIngest('email_triage');
    const emailSync = { ingestRecord: vi.fn().mockResolvedValue(ingest) };
    const services = {
      persistence: { tasks, emailSync },
      ownerNotifier: { notifyOwner: vi.fn() },
    } as unknown as ModuleServices;
    const observer = routingObserver();

    await expect(
      observer.apply(services, source('email_triage'), claim('email_triage'), {
        route: 'email_triage',
      }),
    ).resolves.toEqual({ kind: 'complete' });
    expect(tasks.createTask).toHaveBeenCalledTimes(1);
    expect(tasks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'email_triage',
        externalEventId: 'gmail:provider-id',
        conversationId: 'conversation-id',
      }),
    );
  });

  it('enqueues only the application confirmation task for the frozen application disposition', async () => {
    const tasks = taskRepository();
    const ingest = admittedIngest('application_confirmation');
    const applications = {
      expireDue: vi.fn().mockResolvedValue([]),
      byConfirmationMessage: vi.fn().mockResolvedValue({
        id: 'application-id',
        agentId: 'owner-id',
        conversationId: 'conversation-id',
        status: 'confirmation_received',
        trackerUpdate: { amount: 12 },
        documentUpdate: null,
      }),
      awaitingFrom: vi.fn(),
      claimAndEnqueue: vi.fn().mockResolvedValue({
        record: { id: 'application-id', status: 'confirmation_received' },
        task: { id: 'atomic-application-task', status: 'pending', queueGeneration: 1 },
        created: false,
      }),
    };
    const emailSync = { ingestRecord: vi.fn().mockResolvedValue(ingest) };
    const services = {
      persistence: { tasks, applications, emailSync },
      ownerNotifier: { notifyOwner: vi.fn() },
    } as unknown as ModuleServices;
    const observer = routingObserver();

    await expect(
      observer.apply(
        services,
        source('application_confirmation'),
        claim('application_confirmation'),
        { route: 'application_confirmation' },
      ),
    ).resolves.toEqual({ kind: 'complete' });
    expect(tasks.createTask).not.toHaveBeenCalled();
    expect(applications.claimAndEnqueue).toHaveBeenCalledTimes(1);
    expect(applications.claimAndEnqueue).toHaveBeenCalledWith(
      'application-id',
      expect.objectContaining({
        confirmationMessageId: 'gmail:provider-id',
        confirmationFrom: 'hr@company.example',
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        emailObserverEffectFence: {
          id: 'observer-id',
          agentId: 'owner-id',
          claimToken: 'claim-token',
          claimGeneration: 1,
          expectedPrivacyGeneration: null,
        },
      }),
    );
    expect(applications.awaitingFrom).not.toHaveBeenCalled();
  });

  it('does not fall through to generic triage if a frozen application route no longer matches', async () => {
    const tasks = taskRepository();
    const ingest = admittedIngest('application_confirmation');
    const applications = {
      expireDue: vi.fn().mockResolvedValue([]),
      byConfirmationMessage: vi.fn().mockResolvedValue(null),
      awaitingFrom: vi.fn().mockResolvedValue([]),
    };
    const services = {
      persistence: {
        tasks,
        applications,
        emailSync: { ingestRecord: vi.fn().mockResolvedValue(ingest) },
      },
      ownerNotifier: { notifyOwner: vi.fn() },
    } as unknown as ModuleServices;

    await expect(
      routingObserver().apply(
        services,
        source('application_confirmation'),
        claim('application_confirmation'),
        { route: 'application_confirmation' },
      ),
    ).resolves.toEqual({ kind: 'unknown', errorCode: 'application_route_no_longer_matches' });
    expect(tasks.createTask).not.toHaveBeenCalled();
  });
});
