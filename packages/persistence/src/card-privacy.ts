/** Shared classification for generated and deterministic card projections. */
const PRIVATE_LABEL =
  /\b(?:password|secret|token|credential|reference|pin|code|account|ticket number)\b/i;
const SECRET_MATERIAL =
  /\b(?:password|pin|(?:door|access|security|booking|reservation|confirmation|account)\s*(?:code|number|id)|reference)\s*(?:is\s+|[:#=]\s*)?[A-Za-z0-9][A-Za-z0-9_-]{2,}\b|https?:\/\/\S*[?&](?:token|access_token|key|secret|signature|code)=/i;
const BEARER_LINK = /\bbearer\s+(?:link|url)\s*(?:is\s+|[:#=]\s*)?https?:\/\/\S+/i;

export function containsCardSecret(value: string): boolean {
  return SECRET_MATERIAL.test(value) || BEARER_LINK.test(value);
}

export function isSensitiveCardFact(fact: {
  id: string;
  label?: string;
  value: string;
  sensitive?: boolean;
}): boolean {
  return (
    fact.sensitive === true ||
    PRIVATE_LABEL.test(`${fact.id} ${fact.label ?? ''}`) ||
    containsCardSecret(fact.value)
  );
}

export function publicCardText(
  value: string | undefined,
  privateValues: readonly string[],
): string | undefined {
  if (!value) return value;
  if (containsCardSecret(value)) return '[hidden]';
  return privateValues.reduce(
    (safe, secret) => (secret ? safe.split(secret).join('[hidden]') : safe),
    value,
  );
}
