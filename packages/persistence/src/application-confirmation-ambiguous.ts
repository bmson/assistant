import type { EmailObserverEffectFence } from './generated-cards.js';
import type { TaskCreateInput } from './task-creation.js';

export interface ApplicationConfirmationAmbiguousWatch {
  id: string;
  conversationId: string | null;
  confirmationTokenHint: string;
}

/** Result of atomically recording a source-verified ambiguous watch match. */
export type ApplicationConfirmationAmbiguousResult =
  | { kind: 'recorded' | 'replay'; taskId: string; from: string; applicationIds: string[] }
  | { kind: 'not_ambiguous' };

/**
 * The repository derives the source, sender, matching watches, task, and
 * dashboard notices from persisted records. Callers cannot provide a watch ID
 * or a rendered task/message payload.
 */
export interface ApplicationConfirmationAmbiguousInput {
  emailObserverEffectFence: EmailObserverEffectFence;
}

export function applicationConfirmationAmbiguousTaskInput(input: {
  agentId: string;
  confirmationMessageId: string;
  from: string;
  matches: ApplicationConfirmationAmbiguousWatch[];
}): TaskCreateInput {
  const conversationId =
    input.matches.find((match) => match.conversationId)?.conversationId ?? null;
  const applicationIds = input.matches.map((match) => match.id);
  const externalEventId = `application-confirmation:${input.confirmationMessageId}:ambiguous`;
  return {
    agentId: input.agentId,
    type: 'adhoc',
    trust: 'assistant',
    conversationId: conversationId ?? undefined,
    externalEventId,
    trigger: {
      source: 'internal',
      externalEventId,
      agentId: input.agentId,
      conversationId: conversationId ?? undefined,
      trust: 'assistant',
      payload: {
        kind: 'application_confirmation_ambiguous',
        applicationIds,
        from: input.from,
        matchCount: applicationIds.length,
      },
    },
  };
}

export function applicationConfirmationAmbiguousProgress(from: string, count: number): string {
  return `Authenticated confirmation from ${from} matched ${count} active applications; no Sheet or Doc was changed.`;
}

export function applicationConfirmationAmbiguousNotice(input: {
  from: string;
  matches: ApplicationConfirmationAmbiguousWatch[];
}): string {
  return `I received an authenticated email from ${input.from}, but it matched more than one active application watch. I did not update any Sheet or Doc. Review the application references ending in ${input.matches.map((candidate) => candidate.confirmationTokenHint).join(', ')}.`;
}
