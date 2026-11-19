import type { PersonalReadRequest } from '@assistant/core/workflow/read-intent';
import {
  type ActionEvidence,
  enforceResponseContract,
} from '@assistant/core/workflow/response-contract';

/**
 * Honesty check for the tool-less streaming chat path. The executor runs
 * enforceResponseContract before publishing; this path streams straight to the
 * client, so by the time the full draft exists the text has already been seen.
 *
 * The contract owns the durable answer: a flagged draft persists as the
 * replacement, and the caller streams that same replacement to the client so
 * the live reply and the stored one never disagree. An `off-course` marker
 * rides alongside it, and the chat renders a compact card offering to rerun
 * the request through the real executor.
 *
 * `urlCorpus` is the caller's to supply, and omitting it skips the link rule
 * entirely. This path's tool ledger is NOT a usable corpus on its own: it
 * holds no owner turns, so a link the owner pasted themselves — or one the
 * model wrote from its own knowledge in a turn that ran no tools at all —
 * reads as fabricated and is stripped out of an otherwise fine reply.
 */
export function guardDraft(
  text: string,
  evidence: ActionEvidence[],
  opts?: { readRequest?: PersonalReadRequest | null; urlCorpus?: string; requestText?: string },
): { corrected: boolean; text: string } {
  const checked = enforceResponseContract(text, evidence, {
    requestText: opts?.requestText,
    admittedMutationText: opts?.requestText,
    readRequest: opts?.readRequest,
    ...(opts?.urlCorpus === undefined ? {} : { urlCorpus: opts.urlCorpus }),
  });
  return { corrected: checked.blocked || checked.text !== text, text: checked.text };
}
