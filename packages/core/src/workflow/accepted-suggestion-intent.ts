import type { Records, SuggestionRecord } from '@assistant/persistence';
import type { OwnerIntent } from './owner-intent.js';

type TaskRecord = Records['tasks'];

/**
 * Derive the narrow authority created by the owner's acceptance of a saved
 * known-sender reply proposal. The caller must fetch the row with an
 * owner/acceptedTaskId scoped repository lookup before using this function.
 */
export function acceptedKnownSenderReplyIntent(input: {
  task: Pick<TaskRecord, 'id' | 'agentId' | 'trust' | 'trigger' | 'type'>;
  proposal: Pick<
    SuggestionRecord,
    'id' | 'agentId' | 'acceptedTaskId' | 'status' | 'origin' | 'sourceRef' | 'proposedAction'
  > | null;
}): OwnerIntent | null {
  const { task, proposal } = input;
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { suggestionId?: unknown; instruction?: unknown; taintedOrigin?: unknown };
  } | null;
  const payload = trigger?.payload;
  if (
    !proposal ||
    task.type !== 'adhoc' ||
    task.trust !== 'owner' ||
    trigger?.source !== 'internal' ||
    payload?.taintedOrigin !== true ||
    proposal.status !== 'accepted' ||
    proposal.acceptedTaskId !== task.id ||
    proposal.agentId !== task.agentId ||
    proposal.origin !== 'known_sender_reply' ||
    !proposal.sourceRef.startsWith('known-sender-reply:') ||
    payload.suggestionId !== proposal.id ||
    payload.instruction !== proposal.proposedAction
  )
    return null;

  return {
    sourceActor: 'owner',
    requestKind: 'new_request',
    // The scope comes from the durable acceptance receipt; the exact proposal
    // remains in the model window and is separately marked tainted.
    ownerAuthoredText: 'The owner accepted the saved known-sender reply proposal.',
    externalText: proposal.proposedAction,
    authorizedScopes: ['external_send'],
    separation: 'clear',
  };
}
