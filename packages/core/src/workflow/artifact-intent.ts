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

export interface ConditionalArtifactIntent extends ArtifactIntent {
  /** Exact provider title parsed from an explicit quoted title; absence fails closed. */
  exactTitle?: string;
  /** The owner explicitly limited access to themselves. */
  ownerOnly: boolean;
}

const CONDITIONAL_CREATE =
  /\b(?:if|unless)\b[^.!?;\n]{0,160}\b(?:exact[- ](?:title|name)|title|name|(?:google\s+)?doc(?:ument)?|spreadsheet|sheet|presentation|slide\s+deck|file)\b[^.!?;\n]{0,80}\b(?:already\s+exists|exists|is\s+found|was\s+found)|(?:do\s+not|don['’]?t|never)\s+(?:duplicate|overwrite)|avoid\s+duplicat(?:e|ing|ion)|do\s+not\s+replace\s+(?:an?\s+)?existing\b/i;

/**
 * Explicit no-duplicate clauses are a write precondition, not planner advice.
 * Require a quoted title so the runtime can bind its authenticated lookup to
 * the owner's requested name rather than a model-invented search query.
 */
export function requestedConditionalArtifactIntent(
  text: string,
  titleSource = text,
): ConditionalArtifactIntent | undefined {
  const unquoted = text.replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”/g, '');
  if (!CONDITIONAL_CREATE.test(unquoted)) return undefined;
  const actionText = unquoted
    .replace(
      /\b(?:if|unless)\b[^.!?;\n]{0,240}\b(?:already\s+exists|exists|is\s+found|was\s+found)\b[^.!?;\n]*/gi,
      ' ',
    )
    .replace(/\b(?:do\s+not|don['’]?t|never)\s+(?:duplicate|overwrite|replace)\b[^.!?;\n]*/gi, ' ')
    .replace(/\bavoid\s+duplicat(?:e|ing|ion)\b[^.!?;\n]*/gi, ' ');
  const artifact = requestedArtifactIntent(actionText);
  if (!artifact) return undefined;
  const titleMatch = titleSource.match(/\b(?:titled|named)\s+["“]([^"”\n]{1,200})["”]/i);
  const exactTitle = titleMatch?.[1]?.trim();
  return {
    ...artifact,
    ...(exactTitle ? { exactTitle } : {}),
    ownerOnly:
      /\b(?:private|only\s+(?:(?:accessible|available|shared|to|with|by)\s+)*(?:me|myself|my\s+account)|no\s+one\s+else|not\s+shared\s+with\s+anyone\s+else|(?:do\s+not|don['’]?t|never)\s+share\b[^.!?;\n]{0,50}\banyone\s+else)\b/i.test(
        unquoted,
      ),
  };
}

export interface ConditionalArtifactEvidence {
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
  error?: string | null;
  fromCurrentTask?: boolean;
}

export type ConditionalArtifactPreflight =
  | { status: 'not_started' }
  | { status: 'absent' }
  | { status: 'exists'; fileId: string; url?: string }
  | { status: 'blocked'; reason: string };

/** Only a complete, successful, current-task exact-name lookup can clear the write gate. */
export function conditionalArtifactPreflight(
  intent: ConditionalArtifactIntent,
  evidence: ReadonlyArray<ConditionalArtifactEvidence>,
): ConditionalArtifactPreflight {
  if (!intent.exactTitle) return { status: 'blocked', reason: 'The exact title is unclear.' };
  const rows = evidence.filter(
    (row) => row.toolName === 'drive.search' && row.fromCurrentTask !== false,
  );
  const latest = rows.at(-1);
  if (!latest) return { status: 'not_started' };
  if (latest.status !== 'succeeded')
    return {
      status: 'blocked',
      reason: 'The Drive exact-title check did not complete successfully.',
    };
  const args = asRecord(latest.args);
  const result = asRecord(latest.result);
  if (
    args?.exactTitle !== intent.exactTitle ||
    args.query !== intent.exactTitle ||
    args.verifyOwnerOnly !== intent.ownerOnly ||
    result?.lookupMode !== 'exact-title' ||
    result.exactTitle !== intent.exactTitle ||
    result.coverage !== 'complete' ||
    !Array.isArray(result.files)
  ) {
    return {
      status: 'blocked',
      reason: 'Drive did not return complete evidence for the requested exact title.',
    };
  }
  const files = result.files.map(asRecord);
  if (
    files.some(
      (file) =>
        !file ||
        file.name !== intent.exactTitle ||
        typeof file.fileId !== 'string' ||
        !/^[A-Za-z0-9_-]{10,200}$/.test(file.fileId),
    )
  ) {
    return {
      status: 'blocked',
      reason: 'Drive returned ambiguous or incomplete exact-title matches.',
    };
  }
  if (files.length > 1)
    return { status: 'blocked', reason: 'More than one accessible file has that exact title.' };
  if (files.length === 0) return { status: 'absent' };
  if (intent.ownerOnly && result.sharingVerification !== 'verified_owner_only') {
    return {
      status: 'blocked',
      reason:
        result.sharingVerification === 'not_owner_only'
          ? 'The existing file is also accessible to another account or group.'
          : 'The existing file sharing permissions could not be verified.',
    };
  }
  const file = files[0];
  if (!file) return { status: 'blocked', reason: 'The exact-title match was incomplete.' };
  const url =
    typeof file.url === 'string' && /^https:\/\/(?:docs|drive)\.google\.com\//i.test(file.url)
      ? file.url
      : undefined;
  return { status: 'exists', fileId: file.fileId as string, ...(url ? { url } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function conditionalArtifactExistingResponse(
  intent: ConditionalArtifactIntent,
  preflight: Extract<ConditionalArtifactPreflight, { status: 'exists' }>,
): string {
  const link = ` [Open the existing file](https://drive.google.com/open?id=${encodeURIComponent(preflight.fileId)})`;
  const privacy = intent.ownerOnly
    ? ' Sharing access is limited to your account and the assistant account.'
    : '';
  return `An accessible file already has the exact title you requested. I did not create a duplicate.${privacy}${link}`;
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
  // Restrictions on other actions do not turn a new-artifact request into an
  // existing-file edit. Check creation prohibitions against the original text
  // below, while classifying the positively requested action separately.
  const positive = normalized.replace(/\b(?:do\s+not|don['’]?t|never)\b[^.!?;\n]*/gi, '');
  if (
    GOOGLE_ARTIFACT_URL.test(positive) ||
    UPDATE_VERB.test(positive) ||
    EXISTING_ARTIFACT.test(positive) ||
    WRITE_INTO_ARTIFACT.test(positive)
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
  if (DOC.test(positive)) matches.push({ toolName: 'docs.create', label: 'Google Doc' });
  if (SHEET.test(positive)) {
    matches.push({ toolName: 'sheets.create', label: 'Google Sheet' });
  }
  if (SLIDES.test(positive)) {
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

/** Do not claim an owner-only result unless the provider ACL read proved it. */
export function artifactSharingVerificationFailure(
  intent: ConditionalArtifactIntent,
  evidence: ArtifactToolEvidence[],
): string | undefined {
  if (!intent.ownerOnly) return undefined;
  const row = [...evidence].reverse().find((item) => item.toolName === intent.toolName);
  if (!row || !completed(row)) return undefined;
  const result = asRecord(row.result);
  if (result?.sharingVerification === 'verified_owner_only') return undefined;
  const detail =
    result?.sharingVerification === 'not_owner_only'
      ? 'Google reports at least one other active permission.'
      : 'Google did not provide complete permission evidence.';
  const link =
    typeof result?.url === 'string' && /^https:\/\/(?:docs|drive)\.google\.com\//i.test(result.url)
      ? ` ${result.url}`
      : '';
  return `The ${intent.label} was created and shared with your configured account, but I could not confirm that access is limited to you. ${detail}${link}`;
}

/** Whether a model result needs the single constrained retry. */
export function needsArtifactToolRetry(
  intent: ArtifactIntent,
  toolCalls: Array<{ toolName: string }>,
): boolean {
  return !toolCalls.some((toolCall) => toolCall.toolName === intent.toolName);
}
