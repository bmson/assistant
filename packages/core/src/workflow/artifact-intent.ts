/**
 * Explicit owner requests for a durable Google Workspace artifact are not
 * ordinary chat replies. Once the matching tool is available, the executor
 * must ask the model for that exact tool call instead of merely hoping it
 * chooses one.
 */
import { requestedCardIntent } from './card-intent.js';

export type ArtifactToolName = 'docs.create' | 'sheets.create' | 'slides.create';

export interface ArtifactIntent {
  toolName: ArtifactToolName;
  label: 'Google Doc' | 'Google Sheet' | 'Google Slides presentation';
}

/** A Google Doc URL directly supplied by the owner is an explicit read request. */
export interface DocumentReadIntent {
  toolName: 'docs.get';
  documentId: string;
}

const CREATION_VERB =
  /\b(?:create|creating|make|making|generate|generating|write|writing|draft|drafting|build|building|prepare|preparing)\b/i;
const DOC = /\b(?:google\s+)?docs?\b|\bdocument\b/i;
const SHEET = /\b(?:google\s+)?sheets?\b|\bspreadsheet\b/i;
const SLIDES = /\b(?:google\s+)?slides?\b|\b(?:slide deck|presentation)\b/i;
const GOOGLE_DOC_URL =
  /https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{10,200})(?:[/?#][^\s]*)?/i;
const GOOGLE_ARTIFACT_URL =
  /https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\//i;
const UPDATE_VERB =
  /\b(?:edit|editing|update|updating|revise|revising|append|appending|add|adding|insert|inserting|replace|replacing|fill|filling|populate|populating)\b/i;
const EXISTING_ARTIFACT =
  /\b(?:existing|current|shared|linked|attached)\s+(?:google\s+)?(?:doc(?:ument)?|sheet|spreadsheet|slides?|slide deck|presentation)s?\b/i;
const WRITE_INTO_ARTIFACT =
  /\b(?:write|writing|draft|drafting|prepare|preparing)\b[\s\S]{0,100}\b(?:into|onto|to|in)\s+(?:(?:the|this|that)\s+(?:(?:existing|current|shared)\s+)?|(?:an?\s+)?(?:existing|current|shared)\s+)(?:google\s+)?(?:doc(?:ument)?|sheet|spreadsheet|slides?|slide deck|presentation)s?\b/i;

/**
 * Finds a direct request to make one durable artifact. Capability questions
 * ("can it create docs?") and multi-artifact requests stay model-directed;
 * forcing one arbitrary tool in either case would be surprising.
 */
export function requestedArtifactIntent(text: string): ArtifactIntent | undefined {
  const normalized = text.trim();
  if (!CREATION_VERB.test(normalized)) return undefined;
  if (
    GOOGLE_ARTIFACT_URL.test(normalized) ||
    UPDATE_VERB.test(normalized) ||
    EXISTING_ARTIFACT.test(normalized) ||
    WRITE_INTO_ARTIFACT.test(normalized)
  ) {
    return undefined;
  }
  if (/^\s*(?:how|why)\b/i.test(normalized)) return undefined;
  if (/^\s*can\s+it\b/i.test(normalized)) return undefined;
  // A requested CARD is composed by the runtime, not by a Google tool. Forcing
  // docs.create here is how "make that into a card" became a Google Doc.
  if (requestedCardIntent(normalized)) return undefined;
  if (
    /\b(?:do\s+not|don't|dont)\s+(?:create|make|generate|write|draft|build|prepare)\b/i.test(
      normalized,
    )
  ) {
    return undefined;
  }

  const matches: ArtifactIntent[] = [];
  if (DOC.test(normalized)) matches.push({ toolName: 'docs.create', label: 'Google Doc' });
  if (SHEET.test(normalized)) {
    matches.push({ toolName: 'sheets.create', label: 'Google Sheet' });
  }
  if (SLIDES.test(normalized)) {
    matches.push({ toolName: 'slides.create', label: 'Google Slides presentation' });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * A bare Google Doc URL from the owner is enough authorization to read that
 * document. The executor makes this deterministic so a model cannot merely
 * promise to review a CV and then reply without attempting docs.get.
 */
export function requestedDocumentReadIntent(text: string): DocumentReadIntent | undefined {
  // Deterministic routing must not turn an example, quotation, or prohibition
  // into authorization. Ambiguous multi-document requests stay with planning.
  if (
    /\b(?:do\s+not|don['’]?t|never|without)\b[^.!?;\n]{0,70}\b(?:read|open|access|fetch|review)\b/i.test(
      text,
    ) ||
    /\b(?:example|hypothetical|translate|translation|what\s+(?:a|this)\s+google\s+doc\s+url|url\s+(?:looks|format))\b/i.test(
      text,
    )
  )
    return undefined;
  const matches = [...text.matchAll(new RegExp(GOOGLE_DOC_URL.source, 'gi'))];
  if (matches.length !== 1) return undefined;
  const outsideQuoted = text.replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”/g, '');
  if (
    !GOOGLE_DOC_URL.test(outsideQuoted) &&
    !/\b(?:read|open|access|fetch|review)\b/i.test(outsideQuoted)
  )
    return undefined;
  const documentId = matches[0]?.[1];
  return documentId ? { toolName: 'docs.get', documentId } : undefined;
}

export function documentReadDispatchFailure(intent: DocumentReadIntent, reason: string): string {
  return [
    "I couldn't read the shared Google Doc.",
    `${intent.toolName} did not complete: ${reason.replace(/\s+/g, ' ').slice(0, 500)}.`,
    'I cannot confirm that the document was accessed.',
  ].join(' ');
}

export function artifactRoutingFailure(intent: ArtifactIntent): string {
  return [
    `I couldn't start the requested ${intent.label} because the action router did not invoke ${intent.toolName}.`,
    `No request was sent to Google and no ${intent.label} was created.`,
  ].join(' ');
}

export function artifactToolUnavailable(intent: ArtifactIntent): string {
  return [
    `I can't create the requested ${intent.label} because ${intent.toolName} is not available to this task.`,
    `No request was sent to Google and no ${intent.label} was created.`,
  ].join(' ');
}

interface ArtifactToolEvidence {
  toolName: string;
  status: string;
  result: unknown;
  error?: string | null;
}

function completed(evidence: ArtifactToolEvidence): boolean {
  if (evidence.status !== 'succeeded') return false;
  if (!evidence.result || typeof evidence.result !== 'object') return true;
  const result = evidence.result as Record<string, unknown>;
  return (
    result.ok !== false &&
    !(typeof result.status === 'number' && result.status >= 400) &&
    result.deliveryStatus !== 'unknown'
  );
}

/** Return a source-of-truth error instead of relying on a model paraphrase. */
export function artifactExecutionFailure(
  intent: ArtifactIntent,
  evidence: ArtifactToolEvidence[],
): string | undefined {
  const latest = [...evidence].reverse().find((item) => item.toolName === intent.toolName);
  if (!latest || completed(latest)) return undefined;
  const detail =
    latest.error?.replace(/\s+/g, ' ').slice(0, 500) ||
    'the tool did not return a successful result';
  return [
    `I couldn't create the requested ${intent.label}.`,
    `${intent.toolName} did not complete: ${detail}.`,
    `I cannot confirm that a ${intent.label} was created.`,
  ].join(' ');
}

/** Whether a model result needs the single constrained retry. */
export function needsArtifactToolRetry(
  intent: ArtifactIntent,
  toolCalls: Array<{ toolName: string }>,
): boolean {
  return !toolCalls.some((toolCall) => toolCall.toolName === intent.toolName);
}
