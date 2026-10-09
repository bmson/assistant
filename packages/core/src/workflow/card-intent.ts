/**
 * A card is the one artifact the model cannot create with a tool: the runtime
 * composes it from verified tool results so nothing on it can be invented. That
 * makes an explicit "make that into a card" invisible to the ordinary tool
 * loop — the model, told to finish creation requests with a real artifact and
 * offered only docs/sheets/slides, reaches for a Google Doc instead. Detecting
 * the request here lets the finalizer run the grounded compiler on purpose.
 */
const CREATION_VERB =
  /\b(?:create|creating|make|making|generate|generating|build|building|turn|turning|save|saving|keep|keeping|add|adding|put|putting|pin|pinning)\b/i;
const CARD = /\bcards?\b/i;
/**
 * A card in the owner's wallet is the SUBJECT of a request, never the artifact
 * being asked for. Stripped rather than rejected, so "save my boarding card as
 * a card" still reads as a card request.
 */
const PHYSICAL_CARD =
  /\b(?:credit|debit|gift|sim|id|business|library|key|loyalty|membership|boarding|birthday|greeting|holiday|christmas|post)\s+cards?\b/gi;

/**
 * Whether the owner explicitly asked for a saved card. Capability questions
 * ("can it make cards?") and refusals stay model-directed, matching the
 * exclusions requestedArtifactIntent already applies.
 */
export function requestedCardIntent(text: string): boolean {
  const normalized = text.trim().replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”/g, '');
  if (!CREATION_VERB.test(normalized)) return false;
  if (/^\s*(?:how|why|what|where|when)\b/i.test(normalized)) return false;
  // "can it make cards?" asks about the capability; "can you make a card out of
  // this?" is a polite imperative. Mirrors requestedArtifactIntent's split.
  if (/^\s*can\s+it\b/i.test(normalized)) return false;
  if (
    /\b(?:do\s+not|don't|dont)\s+(?:create|make|generate|build|save|keep|turn|add)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return CARD.test(normalized.replace(PHYSICAL_CARD, ' '));
}

/**
 * Stated when the owner asked for a card and the grounded compiler could not
 * build one. Silence here is what let a Google Doc stand in for the card.
 */
export const CARD_NOT_BUILT =
  "I couldn't create and save this card. The request is still incomplete.";
