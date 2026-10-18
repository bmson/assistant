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

export function requestedReplySentenceLimit(request: string): number | undefined {
  const authored = extractOwnerIntent({ text: request, trust: 'owner' }).ownerAuthoredText;
  return /\b(?:in|with|using|use|only|exactly)\s+(?:one|a single|1)\s+(?:short\s+)?sentence\b/i.test(
    authored,
  ) &&
    !/\b(?:not|never|avoid)\s+(?:(?:reply|answer|respond)(?:ing)?\s+)?(?:in|with|using)\s+(?:one|a single|1)\s+sentence\b/i.test(
      authored,
    )
    ? 1
    : undefined;
}

export function replySentenceCount(text: string): number {
  const display = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr)\.(?=\s+\p{Lu})/gu, '$1');
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(display)].filter(
    (part) => /[\p{L}\p{N}]/u.test(part.segment),
  ).length;
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
  let incomplete = false;
  const maximum = requestedReplyWordLimit(input.request);
  const sentences = requestedReplySentenceLimit(input.request);
  const authored = extractOwnerIntent({ text: input.request, trust: 'owner' }).ownerAuthoredText;
  const reasoningReview = needsConversationReasoning(authored);
  let reasoningReviewed = false;
  for (let pass = 0; pass < 2; pass += 1) {
    const guarded = input.guard(candidate);
    const words = replyWordCount(candidate);
    const formatFindings = [
      ...(maximum !== undefined && words > maximum
        ? [
            `The proposed response has ${words} display words; the explicit maximum is ${maximum}. Revise below the limit without losing requested answer units.`,
          ]
        : []),
      ...(sentences !== undefined && replySentenceCount(candidate) > sentences
        ? [
            `The explicit response limit is one sentence; the proposed response has ${replySentenceCount(candidate)}. Combine the requested answer units into one complete sentence without dropping facts.`,
          ]
        : []),
    ];
    const findings = [
      ...formatFindings,
      ...(guarded.corrected
        ? [
            'The deterministic contract rejected the draft as unsupported or unperformed work. Answer the supplied scenario as analysis or explicitly proposed text; do not claim real actions were completed.',
            'For fictional confirmation examples, describe conditionally in third person what can be confirmed before and after verification. Avoid first-person completion receipts or promises that read as actions performed in this turn; preserve the requested decision and preparation instead of a generic failure.',
          ]
        : []),
    ];
    if (pass > 0 && findings.length === 0 && (!reasoningReview || reasoningReviewed)) break;
    // A short formatting repair should not spend its output budget on a full
    // constraint audit. Keep the same two-pass bound and audit the result once
    // its shape fits, or repair a later audit's length overrun on the last pass.
    const auditReasoning = reasoningReview && (formatFindings.length === 0 || guarded.corrected);
    const review = await verifyFinalOutput(input.router, {
      taskId: input.taskId,
      request: input.request,
      draft: candidate,
      evidence: [],
      context: input.context,
      findings,
      critical: true,
      reasoningReview: auditReasoning,
    });
    if (auditReasoning && !review.unavailable) reasoningReviewed = true;
    candidate = review.text;
    incomplete =
      review.incomplete === true || (incomplete && (!review.revised || review.unavailable));
    if (review.unavailable) break;
  }
  if (
    (maximum !== undefined && replyWordCount(candidate) > maximum) ||
    (sentences !== undefined && replySentenceCount(candidate) > sentences)
  )
    return {
      corrected: false,
      incomplete: true,
      text:
        maximum !== undefined
          ? maximum >= 11
            ? 'I couldn’t fit a complete answer within your word limit.'
            : 'Incomplete.'
          : 'I couldn’t fit a complete answer into one sentence.',
    };
  const finalGuard = input.guard(candidate);
  // A reviewer cannot publish a draft the deterministic contract still rejects.
  return {
    ...finalGuard,
    ...(incomplete || finalGuard.corrected ? { incomplete: true } : {}),
  };
}
