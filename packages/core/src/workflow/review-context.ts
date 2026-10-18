import { type ReadIntentMessage, readIntentText } from './read-intent.js';

const REQUEST_LIMIT = 4_000;
const CONTEXT_LIMIT = 4_000;

/** Preserve the end too: corrections and restrictions commonly follow the setup. */
function excerpt(text: string, limit: number): string {
  const marker = '\n[...omitted...]\n';
  if (text.length <= limit) return text;
  const head = Math.floor((limit - marker.length) / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(limit - marker.length - head))}`;
}

/**
 * Budget owner context separately so assistant prose cannot evict corrections.
 * Keep JSON complete, chronological and visibly partial. This is context, not
 * action authority, retrieval, or evidence of an earlier assistant's claims.
 */
export function buildReviewContext(request: string, context: readonly ReadIntentMessage[] = []) {
  const owner = context.filter((message) => message.role === 'user');
  const assistant = context.filter((message) => message.role === 'assistant');
  const take = (messages: readonly ReadIntentMessage[], count: number, limit: number) =>
    messages.slice(-count).map((message) => {
      const raw = readIntentText(message);
      return { text: excerpt(raw, limit), truncated: raw.length > limit };
    });
  const ownerTurns = take(owner, 6, 900);
  const assistantTurns = take(assistant, 2, 250);
  const snapshot = () => ({
    ownerTurns,
    assistantTurns,
    omittedOwnerTurns: owner.length - ownerTurns.length,
    omittedAssistantTurns: assistant.length - assistantTurns.length,
  });
  // Newest owner facts take priority over older owner turns and assistant offers.
  while (JSON.stringify(snapshot()).length > CONTEXT_LIMIT) {
    if (assistantTurns.length) assistantTurns.shift();
    else if (ownerTurns.length > 1) ownerTurns.shift();
    else {
      const latest = ownerTurns[0];
      if (!latest) break;
      latest.text = excerpt(latest.text, Math.floor(latest.text.length / 2));
      latest.truncated = true;
    }
  }
  const boundedRequest = excerpt(request, REQUEST_LIMIT);
  return {
    request: boundedRequest,
    contextJson: JSON.stringify(snapshot()),
    // Deterministic source checks must use exactly the same owner excerpts.
    ownerFacts: [...ownerTurns.map((turn) => turn.text), boundedRequest].join('\n'),
  };
}
