import {
  isOwnerTaskMemoryEphemeral,
  ownerTurnRequestsEphemeralMemory,
  unquotePersonRecordLabels,
} from '@assistant/persistence';
import { extractOwnerIntent } from '../workflow/owner-intent.js';

/** Identity writes can use a direct owner statement with a literal quoted record label. */
export function directOwnerPersonEvidenceText(text: string, trigger?: unknown): string | undefined {
  if (isOwnerTaskMemoryEphemeral(trigger) || ownerTurnRequestsEphemeralMemory(text))
    return undefined;
  const intent = extractOwnerIntent({
    text: unquotePersonRecordLabels(text),
    trust: 'owner',
    trigger,
  });
  return intent.sourceActor === 'owner' && intent.separation === 'none' ? text : undefined;
}
