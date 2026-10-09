import { GenerativeCardSpecV1Schema } from '@assistant/core/generative-card';
import { generatedSpecBlockCapability } from '@assistant/persistence/card-capabilities';
import { isSensitiveCardFact, publicCardText } from '@assistant/persistence/card-privacy';

type MessagePartProjection = { type?: unknown; data?: unknown };
type MessageProjection = { text?: unknown; parts?: unknown };
type ChatProjection = Record<string, unknown> & { messages?: unknown };

const CURRENT_NATIVE_CARD_SCHEMA = '1';
const FALLBACK_MAX_CHARS = 3_000;

function generatedCardData(part: unknown): Record<string, unknown> | null {
  if (!part || typeof part !== 'object') return null;
  const candidate = part as MessagePartProjection;
  if (candidate.type !== 'data-card' || !candidate.data || typeof candidate.data !== 'object')
    return null;
  const data = candidate.data as Record<string, unknown>;
  return data.kind === 'generated-card' ? data : null;
}

function boundedSpecFallback(value: unknown): string | undefined {
  const parsed = GenerativeCardSpecV1Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const privateValues = parsed.data.facts.filter(isSensitiveCardFact).map((fact) => fact.value);
  const publicText = (text: string) => publicCardText(text, privateValues) ?? '';
  const lines = [publicText(parsed.data.title)];
  for (const fact of parsed.data.facts) {
    if (isSensitiveCardFact(fact)) continue;
    const value = publicText(fact.value);
    if (value) lines.push(`${publicText(fact.label ?? 'Detail')}: ${value}`);
  }
  const text = lines.filter(Boolean).join('\n').trim();
  if (!text) return undefined;
  if (text.length <= FALLBACK_MAX_CHARS) return text;
  const prefix = text.slice(0, FALLBACK_MAX_CHARS - 1);
  const boundary = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('. '));
  return `${prefix.slice(0, boundary > 0 ? boundary + 1 : prefix.length).trimEnd()}…`;
}

function projectMessage(
  message: unknown,
  schema: string | null,
  formRendererAvailable: boolean,
): unknown {
  if (!message || typeof message !== 'object') return message;
  const row = message as MessageProjection;
  if (!Array.isArray(row.parts)) return message;
  const generated = row.parts
    .map((part) => ({ part, data: generatedCardData(part) }))
    .filter((item): item is { part: unknown; data: Record<string, unknown> } => item.data !== null);
  if (generated.length === 0) return message;

  const unsupported = generated.filter(({ data }) => {
    const parsed =
      data.spec && typeof data.spec === 'object'
        ? GenerativeCardSpecV1Schema.safeParse(data.spec)
        : null;
    return (
      schema !== CURRENT_NATIVE_CARD_SCHEMA ||
      !parsed?.success ||
      !generatedSpecBlockCapability(data.spec, 'native', { formRendererAvailable }).full
    );
  });
  if (unsupported.length === 0) return message;

  const remaining = row.parts.filter((part) => !unsupported.some((item) => item.part === part));
  const currentText = typeof row.text === 'string' ? row.text.trim() : '';
  const fallback =
    currentText ||
    unsupported
      .map(({ data }) => boundedSpecFallback(data.spec))
      .filter((text): text is string => Boolean(text))
      .join('\n\n');
  // Retain the opaque card and its stable revision for a newer client. Give
  // older clients an accessible recovery message without guessing at private
  // facts or executing any card action.
  if (!fallback) {
    const textParts = remaining
      .flatMap((part) => {
        if (!part || typeof part !== 'object') return [];
        const item = part as { type?: unknown; text?: unknown };
        return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
      })
      .join('\n')
      .trim();
    return {
      ...(message as Record<string, unknown>),
      text:
        textParts ||
        'This saved response cannot be displayed here. Ask the assistant to show it as text.',
    };
  }
  return {
    ...(message as Record<string, unknown>),
    text: currentText || fallback,
    parts: remaining,
  };
}

/** Project generated cards to a mobile client's declared native schema. */
export function projectMobileCardCapabilities<T>(value: T, request: Request): T {
  if (!value || typeof value !== 'object') return value;
  const projection = value as ChatProjection;
  const schema = request.headers.get('x-assistant-card-schema');
  // Form specs carry a fixed owner-chat submit action and are exposed only
  // after the native client has installed both its renderer and encrypted
  // session. Schema-one support alone does not negotiate form capability.
  const formRendererAvailable = request.headers.get('x-assistant-card-forms') === 'card-form-v1';
  const projectList = (items: unknown) =>
    Array.isArray(items)
      ? items.map((item) => projectMessage(item, schema, formRendererAvailable))
      : items;
  const projected = { ...projection };
  for (const key of ['messages', 'refreshed', 'supersededMessages']) {
    if (key in projected) projected[key] = projectList(projected[key]);
  }
  // Bootstrap nests its conversation view under this property.
  if (projected.conversation && typeof projected.conversation === 'object') {
    projected.conversation = projectMobileCardCapabilities(projected.conversation, request);
  }
  return projected as T;
}
