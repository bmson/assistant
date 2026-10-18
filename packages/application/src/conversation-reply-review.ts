import type { ModelRouter } from '@assistant/core/model-router';
import { verifyFinalOutput } from '@assistant/core/workflow/output-verification';
import {
  extractOwnerIntent,
  needsConversationReasoning,
} from '@assistant/core/workflow/owner-intent';
import type { ReadIntentMessage } from '@assistant/core/workflow/read-intent';

export function requestedReplyWordLimit(request: string): number | undefined {
  const authored = request.replace(/[“"][^“”"]*[”"]/g, '');
  const match =
    /\b(under|fewer than|less than|at most|no more than|max(?:imum)?(?: of)?)\s+(\d{1,4})\s+words\b/i.exec(
      authored,
    );
  if (!match) return undefined;
  const maximum =
    Number(match[2]) - (/^(?:under|fewer than|less than)$/i.test(match[1] ?? '') ? 1 : 0);
  return maximum > 0 ? maximum : undefined;
}

export function replyWordCount(text: string): number {
  return (
    text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_#|]/g, ' ')
      .match(/\S+/g)?.length ?? 0
  );
}

/** The two consumers share this promise: one review, one durable and visible answer. */
export async function reviewConversationReply(input: {
  router: Pick<ModelRouter, 'object'>;
  taskId: string;
  request: string;
  draft: string;
  context: ReadonlyArray<ReadIntentMessage>;
  guard: (text: string) => { corrected: boolean; text: string };
}): Promise<{ corrected: boolean; text: string; incomplete?: boolean }> {
  let candidate = input.draft;
  const maximum = requestedReplyWordLimit(input.request);
  const authored = extractOwnerIntent({ text: input.request, trust: 'owner' }).ownerAuthoredText;
  const reasoningReview = needsConversationReasoning(authored);
  for (let pass = 0; pass < 2; pass += 1) {
    const guarded = input.guard(candidate);
    const words = replyWordCount(candidate);
    const findings = [
      ...(maximum !== undefined && words > maximum
        ? [
            `The proposed response has ${words} display words; the explicit maximum is ${maximum}. Revise below the limit without losing requested answer units.`,
          ]
        : []),
      ...(guarded.corrected
        ? [
            'The deterministic contract rejected the draft as unsupported or unperformed work. Answer the supplied scenario as analysis or explicitly proposed text; do not claim real actions were completed.',
            'For fictional confirmation examples, describe conditionally in third person what can be confirmed before and after verification. Avoid first-person completion receipts or promises that read as actions performed in this turn; preserve the requested decision and preparation instead of a generic failure.',
          ]
        : []),
    ];
    if (pass > 0 && findings.length === 0) break;
    const review = await verifyFinalOutput(input.router, {
      taskId: input.taskId,
      request: input.request,
      draft: candidate,
      evidence: [],
      context: input.context,
      findings,
      critical: true,
      reasoningReview,
    });
    candidate = review.text;
    if (review.unavailable) break;
  }
  if (maximum !== undefined && replyWordCount(candidate) > maximum)
    return {
      corrected: false,
      incomplete: true,
      text:
        maximum >= 11 ? 'I couldn’t fit a complete answer within your word limit.' : 'Incomplete.',
    };
  return input.guard(candidate);
}
