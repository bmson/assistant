import {
  type CardFormSubmission,
  CardFormSubmissionSchema,
} from '@assistant/persistence/card-form';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCardFormChatRequest(value: unknown): CardFormSubmission | null {
  const body = object(value);
  const parsed = CardFormSubmissionSchema.safeParse(body?.cardFormSubmission);
  if (!body || !parsed.success) return null;
  const submission = parsed.data;
  if (
    body.conversationId !== submission.conversationId ||
    body.clientOperationId !== submission.operationId ||
    !UUID_RE.test(submission.operationId) ||
    (body.autonomous !== undefined && body.autonomous !== false) ||
    (body.force !== undefined && body.force !== false)
  )
    return null;
  const messages = body.messages;
  const latest = Array.isArray(messages) && messages.length === 1 ? object(messages[0]) : null;
  const parts = latest && Array.isArray(latest.parts) ? latest.parts : [];
  const onlyPart = parts.length === 1 ? object(parts[0]) : null;
  if (
    latest?.role !== 'user' ||
    latest.id !== submission.operationId ||
    onlyPart?.type !== 'text' ||
    onlyPart.text !== submission.ownerMessageText
  )
    return null;
  return submission;
}
