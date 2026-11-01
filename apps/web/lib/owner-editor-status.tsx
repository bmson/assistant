import type { OwnerEditorFormGrant } from '@assistant/persistence/owner-editor';
import {
  type OwnerEditorOperationState,
  ownerEditorOutcomeMessage,
} from './owner-editor-operation';

/** The form the owner opened, not a newly issued grant from background readback. */
export type OwnerEditorDisplayScope = Readonly<
  Pick<OwnerEditorFormGrant, 'command' | 'operationId'> & { targetId: string | null }
>;

export function ownerEditorDialogMessage(
  state: OwnerEditorOperationState,
  displayed: OwnerEditorDisplayScope | null,
): string {
  const reply = state.reply;
  // Only the exact ordinary completion text is scoped away. A pending original,
  // storage warning, conflict or current validation error must stay visible.
  if (
    (state.phase === 'ready' || state.phase === 'resolved') &&
    !state.marker &&
    !state.reviewRequired &&
    reply?.authority === 'operation_receipt' &&
    (reply.outcome === 'saved' || reply.outcome === 'unchanged') &&
    state.message === ownerEditorOutcomeMessage(reply) &&
    (!displayed ||
      displayed.command !== reply.command ||
      displayed.operationId !== reply.operationId ||
      displayed.targetId !== state.reviewTargetId)
  )
    return '';
  return state.message;
}

export function OwnerEditorDialogStatus({
  state,
  displayed,
}: {
  state: OwnerEditorOperationState;
  displayed: OwnerEditorDisplayScope | null;
}) {
  const message = ownerEditorDialogMessage(state, displayed);
  return message ? (
    <p role="status" className="text-sm">
      {message}
    </p>
  ) : null;
}
