import { createHash } from 'node:crypto';
import type {
  ApplicationConfirmationAmbiguousInput,
  ApplicationConfirmationAmbiguousResult,
} from './application-confirmation-ambiguous.js';
import { isValidEmailContentProvenanceSnapshot } from './email-sync.js';
import type { EmailObserverEffectFence } from './generated-cards.js';
import type { Records } from './records.js';
import type { TaskCreateInput, TaskCreateResult } from './task-creation.js';

export type ApplicationConfirmationRecord = Records['applicationConfirmations'];

export interface ApplicationConfirmationHandoff {
  record: ApplicationConfirmationRecord;
  task: TaskCreateResult['task'];
  created: boolean;
}

export interface CreateApplicationWatchInput {
  agentId: string;
  sourceTaskId: string;
  /** The follow-up chat; when null a new owner chat titled `newConversationTitle` is created. */
  conversationId: string | null;
  newConversationTitle: string;
  company: string;
  role: string;
  expectedSenderEmails: string[];
  confirmationTokenHash: string;
  confirmationTokenHint: string;
  trackerUpdate: unknown;
  documentUpdate: unknown;
  actionState: unknown;
  expiresAt: Date;
}

export type ApplicationConfirmationClaimInput = {
  confirmationMessageId: string;
  confirmationFrom: string;
  now: Date;
} & (
  | { emailObserverEffectFence?: undefined; confirmationTokenHash?: undefined }
  | {
      emailObserverEffectFence: EmailObserverEffectFence;
      confirmationTokenHash: string;
      sourceDigest: string;
    }
);

export function applicationConfirmationSourceDigest(input: {
  confirmationMessageId: string;
  confirmationFrom: string;
  subject: string;
  body: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.confirmationMessageId,
        input.confirmationFrom.trim().toLowerCase(),
        input.subject,
        input.body,
      ]),
    )
    .digest('hex');
}

export type ApplicationExternalEffectAction = 'sheet' | 'document';

/** Stable content digest for the exact frozen args authorized for one action. */
export function applicationExternalEffectArgsDigest(
  action: ApplicationExternalEffectAction,
  args: unknown,
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify([action, canonical(args)]))
    .digest('hex');
}

export function applicationExternalEffectToolIdentity(
  action: ApplicationExternalEffectAction,
  applicationId: string,
): { toolName: string; idempotencyKey: string } {
  return action === 'sheet'
    ? {
        toolName: 'applications.apply_confirmation',
        idempotencyKey: `application-confirmation-apply-${applicationId}`,
      }
    : {
        toolName: 'applications.append_confirmation_doc',
        idempotencyKey: `application-confirmation-doc-${applicationId}`,
      };
}

export interface ApplicationExternalEffectClaimInput {
  agentId: string;
  applicationId: string;
  action: ApplicationExternalEffectAction;
  expectedProducerPrivacyGeneration: string | null;
  taskId: string;
  taskLeaseToken: string;
  toolCallId: string;
  toolName: string;
  idempotencyKey: string;
  argsDigest: string;
  now: Date;
}

export type ApplicationExternalEffectClaimResult =
  | {
      status: 'claimed';
      claimToken: string;
      record: ApplicationConfirmationRecord;
    }
  | { status: 'blocked' };

export interface ApplicationExternalEffectSettlementInput {
  agentId: string;
  applicationId: string;
  action: ApplicationExternalEffectAction;
  claimToken: string;
  status: 'succeeded' | 'failed';
  error?: string | null;
  now: Date;
}

const CONFIRMATION_TOKEN_PATTERN = /[a-zA-Z0-9][a-zA-Z0-9_-]{5,99}/g;
const INVISIBLE_TOKEN_BREAK =
  /\u00AD|\u200B|\u200C|\u200D|\u2060|\uFEFF|&(?:shy|zwnj|zwj|#0*(?:173|8203|8204|8205|8288|65279)|#x0*(?:ad|200b|200c|200d|2060|feff));?/gi;
const MAX_TOKEN_CANDIDATES = 1_000;

function confirmationTokenHashes(text: string): Set<string> {
  const result = new Set<string>();
  const addFrom = (source: string) => {
    for (const match of source.matchAll(CONFIRMATION_TOKEN_PATTERN)) {
      if (result.size >= MAX_TOKEN_CANDIDATES) return;
      result.add(createHash('sha256').update(match[0].trim().toUpperCase()).digest('hex'));
    }
  };
  addFrom(text);
  const dejoined = text.replace(INVISIBLE_TOKEN_BREAK, '');
  if (dejoined !== text) addFrom(dejoined);
  return result;
}

/**
 * Independently bind a selected watch token to the canonical message at the
 * persistence boundary. Only authenticated sender-authored spans may satisfy
 * the token; quoted/forwarded or unknown spans cannot authorize a watch.
 */
export function applicationConfirmationTokenInSource(input: {
  tokenHash: string;
  subject: string;
  body: string;
  provenance: unknown;
}): boolean {
  const provenance = input.provenance;
  if (
    !isValidEmailContentProvenanceSnapshot(provenance) ||
    provenance.mode !== 'direct' ||
    !provenance.authenticated ||
    provenance.storedLength !== input.body.length ||
    provenance.bodyHash !==
      createHash('sha256').update('assistant-email-content-v1\0').update(input.body).digest('hex')
  )
    return false;

  let cursor = 0;
  const authored: string[] = [];
  for (const span of provenance.spans) {
    if (span.start !== cursor || span.end <= span.start || span.end > input.body.length)
      return false;
    if (span.author === 'sender') authored.push(input.body.slice(span.start, span.end));
    cursor = span.end;
  }
  if (cursor !== input.body.length) return false;

  const hashes = confirmationTokenHashes(authored.join('\n'));
  // Subject lines have no body-span provenance. Use one only when ingress
  // recorded no quote, forwarding, or unknown-content evidence.
  if (!provenance.hasExternalOrUnknown) {
    for (const hash of confirmationTokenHashes(input.subject)) hashes.add(hash);
  }
  return hashes.has(input.tokenHash);
}

export function applicationConfirmationTaskInput(input: {
  agentId: string;
  applicationId: string;
  confirmationMessageId: string;
  conversationId: string | null;
  subject: string;
  producerPrivacyGeneration: string | null;
}): TaskCreateInput {
  const title = input.subject.replace(/\s+/g, ' ').trim();
  return {
    agentId: input.agentId,
    type: 'adhoc',
    trust: 'assistant',
    title: title ? (title.length > 80 ? `${title.slice(0, 79)}…` : title) : undefined,
    conversationId: input.conversationId ?? undefined,
    externalEventId: `application-confirmation:${input.confirmationMessageId}`,
    maxSteps: 2,
    trigger: {
      source: 'internal',
      externalEventId: `application-confirmation:${input.confirmationMessageId}`,
      agentId: input.agentId,
      conversationId: input.conversationId ?? undefined,
      trust: 'assistant',
      payload: {
        kind: 'application_confirmation',
        applicationId: input.applicationId,
        confirmationMessageId: input.confirmationMessageId,
        producerPrivacyGeneration: input.producerPrivacyGeneration,
      },
    },
  };
}

/**
 * Owner-approved application confirmation watches (the `applications.*`
 * tools and the email match that completes them). Every status transition is
 * guarded on the status it leaves, so a replayed email or a racing cancel
 * changes a record at most once.
 */
export interface ApplicationConfirmationRepository {
  readonly kind: 'application-confirmation-repository';
  /**
   * Create a watch, refusing when an active watch already uses the token.
   * Throws 'an active confirmation watch already uses this token'.
   */
  createWatch(input: CreateApplicationWatchInput): Promise<ApplicationConfirmationRecord>;
  /** The owner's 100 newest watches, optionally of one status. */
  list(agentId: string, status?: string): Promise<ApplicationConfirmationRecord[]>;
  /** Cancel a watch still awaiting its email; otherwise report its current status. */
  cancel(
    agentId: string,
    id: string,
    now: Date,
  ): Promise<{ id: string; status: string; cancelled: boolean } | null>;
  get(id: string): Promise<ApplicationConfirmationRecord | null>;
  /**
   * Replace the per-action state. With `requireStatus`, only while the record
   * still has that status; returns the updated record or null.
   */
  updateActionState(
    id: string,
    input: {
      actionState: unknown;
      lastError?: string | null;
      status?: string;
      requireStatus?: string;
      now: Date;
    },
  ): Promise<ApplicationConfirmationRecord | null>;
  /**
   * Atomically accept one frozen provider action with the owner privacy fence.
   * The durable action state is set to unknown before dispatch, so replay can
   * never issue a second provider request after a crash or ambiguous outcome.
   */
  claimExternalEffect(
    input: ApplicationExternalEffectClaimInput,
  ): Promise<ApplicationExternalEffectClaimResult>;
  /** Settle only the action receipt created by the matching claim token. */
  settleExternalEffect(
    input: ApplicationExternalEffectSettlementInput,
  ): Promise<ApplicationConfirmationRecord | null>;
  /** Expire watches still awaiting an email past `expiresAt`; returns the rows it moved. */
  expireDue(now: Date, agentId?: string): Promise<ApplicationConfirmationRecord[]>;
  byConfirmationMessage(
    agentId: string,
    confirmationMessageId: string,
  ): Promise<ApplicationConfirmationRecord | null>;
  /** Watches awaiting an email from `from` that have not expired. */
  awaitingFrom(agentId: string, from: string, now: Date): Promise<ApplicationConfirmationRecord[]>;
  /** Claim a watch for one email, only while it is still awaiting and unexpired. */
  claim(
    id: string,
    input: ApplicationConfirmationClaimInput,
  ): Promise<ApplicationConfirmationRecord | null>;
  /** Atomically claim the watch and commit its immutable internal task. */
  claimAndEnqueue(
    id: string,
    input: ApplicationConfirmationClaimInput & {
      emailObserverEffectFence: EmailObserverEffectFence;
      confirmationTokenHash: string;
      sourceDigest: string;
    },
  ): Promise<ApplicationConfirmationHandoff | null>;
  /** Atomically revalidate and record ambiguous durable-email matches, task, and chat notices. */
  recordAmbiguousObserver(
    input: ApplicationConfirmationAmbiguousInput,
  ): Promise<ApplicationConfirmationAmbiguousResult>;
  /** Fresh owner-generation check used immediately before each delayed Google write. */
  isPrivacyGenerationCurrent(agentId: string, expected: string | null): Promise<boolean>;
  /** The status of the tool call holding an idempotency key, if any. */
  toolCallStatus(idempotencyKey: string): Promise<string | null>;
  /**
   * Settle a still-executing tool call whose side effect the record already
   * shows as succeeded, so the ledger never keeps a phantom in-flight call.
   */
  settleExecutingToolCall(
    taskId: string,
    toolName: string,
    result: unknown,
    now: Date,
  ): Promise<void>;
}
