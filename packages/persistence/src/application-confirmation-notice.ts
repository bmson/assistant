/**
 * A notice emitted by the delayed task created from an authenticated email.
 * The lease is checked when the notice is first appended/prepared; outbox
 * delivery later checks the immutable task and owner privacy generation.
 */
export interface ApplicationConfirmationNoticeFence {
  agentId: string;
  taskId: string;
  taskLeaseToken: string;
  taskQueueGeneration: number;
  applicationId: string;
  confirmationMessageId: string;
  producerPrivacyGeneration: string | null;
}

export function matchesApplicationConfirmationNoticeLineage(
  task: {
    id: string;
    agentId: string;
    type?: string;
    externalEventId?: string | null;
    trigger: unknown;
    leaseToken?: string | null;
    queueGeneration?: number;
    lockedUntil?: Date | null;
  } | null,
  application: {
    id: string;
    agentId: string;
    confirmationMessageId: string | null;
    producerPrivacyGeneration: string | null;
  } | null,
  fence: Pick<
    ApplicationConfirmationNoticeFence,
    'agentId' | 'taskId' | 'applicationId' | 'confirmationMessageId' | 'producerPrivacyGeneration'
  > &
    Partial<Pick<ApplicationConfirmationNoticeFence, 'taskLeaseToken' | 'taskQueueGeneration'>>,
  input: { now: Date; requireLiveTaskLease: boolean },
): boolean {
  if (!task || !application) return false;
  const trigger = task.trigger as { source?: unknown; payload?: unknown } | null;
  const payload = trigger?.payload as Record<string, unknown> | null;
  if (
    task.id !== fence.taskId ||
    task.agentId !== fence.agentId ||
    task.type !== 'adhoc' ||
    task.externalEventId !== `application-confirmation:${fence.confirmationMessageId}` ||
    trigger?.source !== 'internal' ||
    payload?.kind !== 'application_confirmation' ||
    payload.applicationId !== fence.applicationId ||
    payload.confirmationMessageId !== fence.confirmationMessageId ||
    !Object.hasOwn(payload, 'producerPrivacyGeneration') ||
    payload.producerPrivacyGeneration !== fence.producerPrivacyGeneration ||
    application.id !== fence.applicationId ||
    application.agentId !== fence.agentId ||
    application.confirmationMessageId !== fence.confirmationMessageId ||
    application.producerPrivacyGeneration !== fence.producerPrivacyGeneration
  )
    return false;
  if (!input.requireLiveTaskLease) return true;
  return Boolean(
    fence.taskLeaseToken &&
      typeof fence.taskQueueGeneration === 'number' &&
      task.leaseToken === fence.taskLeaseToken &&
      task.queueGeneration === fence.taskQueueGeneration &&
      task.lockedUntil &&
      task.lockedUntil.getTime() > input.now.getTime(),
  );
}
