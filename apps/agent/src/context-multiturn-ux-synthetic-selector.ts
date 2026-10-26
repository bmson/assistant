/** Deterministic synthetic extract model used by the contextual UX harness. */
export function selectSyntheticExtractQuotes(prompt: unknown): {
  selections: Array<{ sourceKey: string; quote: string }>;
} | null {
  if (typeof prompt !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const request = (parsed as { request?: unknown }).request;
  const sources = (parsed as { sources?: unknown }).sources;
  if (typeof request !== 'string' || !Array.isArray(sources)) return null;

  const stopWords = new Set([
    'about',
    'did',
    'for',
    'from',
    'i',
    'its',
    'said',
    'tell',
    'the',
    'what',
    'you',
  ]);
  const terms = new Set(
    (request.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (term) => term.length > 1 && !stopWords.has(term),
    ),
  );
  if (terms.size === 0) return { selections: [] };
  const ownerHistoryRequest = /\bwhat\s+did\s+i\s+(?:tell|say)\s+you\b/iu.test(request);
  const minimumMatches = Math.min(2, terms.size);
  const selections: Array<{ sourceKey: string; quote: string }> = [];
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = raw as { key?: unknown; body?: unknown; speaker?: unknown };
    if (
      typeof source.key !== 'string' ||
      typeof source.body !== 'string' ||
      typeof source.speaker !== 'string' ||
      !['Recorded owner message', 'Saved fact marked owner-confirmed'].includes(source.speaker) ||
      (ownerHistoryRequest && source.speaker !== 'Recorded owner message')
    )
      continue;
    const quote = source.body
      .split(/(?<=[.!?])\s+|\n+/u)
      .map((sentence) => sentence.trim())
      .find((sentence) => {
        if (sentence.length === 0 || sentence.length > 800) return false;
        const bodyTerms = new Set(
          sentence.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [],
        );
        return [...terms].filter((term) => bodyTerms.has(term)).length >= minimumMatches;
      });
    if (quote) selections.push({ sourceKey: source.key, quote });
  }
  return { selections: selections.slice(0, 8) };
}
