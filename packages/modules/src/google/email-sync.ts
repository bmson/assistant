import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type Config, isModuleEnabled } from '@assistant/config';
import type { ModelRouter, Trust } from '@assistant/core';
import {
  buildEmailContentProvenance,
  type EmailContentProvenance,
  emailHtmlQuoteStart,
  enqueueTask,
  extractorFor,
  getQueueNotifier,
  quotesExternalContent,
  startDocumentIngest,
  TaskRateLimitError,
} from '@assistant/core';
import { collapseWhitespace, truncateAtBoundary } from '@assistant/core/owner-text';
import type { Db } from '@assistant/db';
import type {
  EmailAttachmentManifestEntry,
  EmailAttachmentPreparedResult,
  EmailObserverClaim,
  EmailObserverIdentity,
  EmailObserverSource,
  EmailSyncLease,
  EmailSyncRepository,
  ExecutionPersistence,
  PreparedEmailScore,
  Records,
  RecoverableDirectIngest,
} from '@assistant/persistence';
import { emailAttachmentManifestDigest } from '@assistant/persistence';
import {
  collectGmailAttachments,
  extractGmailText,
  type GmailPayload,
  gmailHeader,
} from '@assistant/tools';
import type { GoogleClient } from '@assistant/tools/modules/google';
import {
  immutableArtifactPath,
  requireEmailAttachmentCustodyStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';
import { z } from 'zod';
import type { InboundEmailEvent, ModuleServices, OwnerNotifier } from '../platform.js';
import {
  applicationPersistence,
  routeApplicationConfirmation,
} from './application-confirmations.js';
import { bulkByHeaders, scoreEmailImportanceOutcome } from './email-importance.js';
import { emailIngestForwarded, gmailSyncEnabled } from './runtime.js';

/**
 * What mail sync consumes. The client comes from the module's own create()
 * closure; the notifier and observer fan-out are platform ports, so this file
 * needs neither the sms module nor the agent's dependency graph.
 */
export interface EmailSyncDeps {
  config: Config;
  persistence: ExecutionPersistence;
  /** PostgreSQL only: attachments are catalogued through SQL when the bundle has no catalog. */
  db?: Db;
  router: ModelRouter;
  workspace: WorkspaceStore;
  googleClient: GoogleClient;
  notifyOwner: OwnerNotifier['notifyOwner'];
  /** Legacy event fan-out used only until that ingress path moves to atomic admission. */
  observeInboundEmail: (event: InboundEmailEvent) => Promise<void>;
  /** Frozen identities written with atomic forwarded admission; handler work stays paused until effects are fenced. */
  durableEmailObservers?: readonly { identity: EmailObserverIdentity }[];
  /** Rechecks the installation activation fence before provider work or writes. */
  operationalReady?: () => Promise<boolean>;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HISTORY_PAGE_SIZE = 25;
const MAX_MESSAGES_PER_SYNC = 10;
const MAX_PAGES_PER_SYNC = 2;
const MAX_SYNC_WALL_MS = 90_000;
const MAX_DIRECT_RECOVERY_PER_SYNC = 10;
const MAX_DIRECT_RECOVERY_WALL_MS = 30_000;
const MESSAGE_FETCH_TIMEOUT_MS = 30_000;
const CLASSIFY_TIMEOUT_MS = 20_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;

export function preparedEmailAttachmentManifest(payload: GmailPayload | undefined): {
  entries: EmailAttachmentManifestEntry[];
  digest: string;
} {
  const entries = collectGmailAttachments(payload)
    .filter((item) => extractorFor(item.mimeType, item.filename) !== 'unsupported')
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    .map((item, ordinal) => ({
      providerAttachmentId: item.attachmentId,
      ordinal,
      filename: item.filename.slice(0, 300),
      mime: item.mimeType.slice(0, 200),
      advertisedBytes: Number.isSafeInteger(item.size) ? Math.max(0, item.size) : 0,
    }));
  if (new Set(entries.map((item) => item.providerAttachmentId)).size !== entries.length)
    throw new Error('attachment_manifest_duplicate_id');
  const digest = emailAttachmentManifestDigest(entries);
  if (!digest) throw new Error('attachment_manifest_invalid');
  return { entries, digest };
}
const DIRECT_ROUTING_OBSERVER = {
  key: 'google.direct-email-routing',
  version: 1,
  workClass: 'idempotent_db' as const,
};
const APPLICATION_CONFIRMATION_OBSERVER_KEY = 'google.application-confirmation';

function directObserverIdentities(deps: EmailSyncDeps): EmailObserverIdentity[] {
  const registered = (deps.durableEmailObservers ?? []).map(({ identity }) => identity);
  if (
    !registered.some(
      (identity) =>
        identity.key === DIRECT_ROUTING_OBSERVER.key &&
        identity.version === DIRECT_ROUTING_OBSERVER.version,
    )
  )
    throw new Error('Direct email routing observer is not registered');
  return registered.filter((identity) => identity.key !== APPLICATION_CONFIRMATION_OBSERVER_KEY);
}

const AutomatedSchema = z.object({
  automated: z
    .boolean()
    .describe('true for newsletters, notifications, receipts, no-reply senders, marketing'),
});

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

function gmailReceivedAt(message: GmailMessage): Date | null {
  if (!message.internalDate || !/^\d{1,16}$/u.test(message.internalDate)) return null;
  const receivedAt = new Date(Number(message.internalDate));
  return Number.isFinite(receivedAt.getTime()) ? receivedAt : null;
}

export interface MailboxSyncResult {
  processed: number;
  /** A durable cursor remains; the scheduler or next push should continue it. */
  morePending?: boolean;
}

const GmailPendingPageSchema = z.object({
  messageIds: z.array(z.string().min(1).max(256)).max(20_000),
  index: z.number().int().nonnegative(),
  nextPageToken: z.string().max(4096).optional(),
});
const GmailCursorPageFields = {
  targetHistoryId: z.string().regex(/^\d+$/),
  pageToken: z.string().max(4096).optional(),
  pending: GmailPendingPageSchema.optional(),
};
const GmailDrainCursorSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('history'),
      startHistoryId: z.string().regex(/^\d+$/),
      ...GmailCursorPageFields,
    })
    .strict(),
  z.object({ mode: z.literal('inbox'), ...GmailCursorPageFields }).strict(),
]);
type GmailDrainCursor = z.infer<typeof GmailDrainCursorSchema>;

/**
 * Coalesce concurrent sync pokes without losing one that arrived mid-flight.
 * Every caller awaits the same drain; a dirty notification forces one more
 * pass after the active pass reaches its durable history checkpoint.
 */
export class MailboxSyncCoordinator {
  private running: Promise<MailboxSyncResult> | undefined;
  private dirty = false;

  constructor(private readonly runOnce: () => Promise<MailboxSyncResult>) {}

  sync(): Promise<MailboxSyncResult> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drain(): Promise<MailboxSyncResult> {
    let processed = 0;
    let morePending = false;
    do {
      this.dirty = false;
      const result = await this.runOnce();
      processed += result.processed;
      morePending = result.morePending === true;
    } while (this.dirty);
    return morePending ? { processed, morePending: true } : { processed };
  }
}

function parseSenderEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match?.[1] ?? fromHeader).trim().toLowerCase();
}

/**
 * The display-name portion of a `From` header, e.g. "Hyundai Motor Finance"
 * out of `"Hyundai Motor Finance <hmfusa@servicing.hmfusa.com>"`. This used to
 * be discarded entirely at ingest — `parseSenderEmail` kept only the bracketed
 * address — so every digest and card rendered a bare machine address instead
 * of the name a person would recognize.
 *
 * Only the literal text before `<...>` is taken, with a wrapping pair of
 * double quotes stripped. RFC 2047 encoded-words (`=?UTF-8?Q?...?=`) are left
 * exactly as they arrive rather than decoded here — decoding wrong is worse
 * than not decoding, and the header is meant to be stored, not displayed raw
 * by this function's caller alone. Returns undefined when there is no
 * bracketed address to split on, when the name is empty, or when it is just
 * the address again (`<addr> <addr>`-style headers with no real name).
 */
export function parseSenderName(fromHeader: string): string | undefined {
  const match = fromHeader.match(/^(.*)<([^>]+)>/);
  if (!match) return undefined;
  const namePart = match[1] as string;
  const addressPart = (match[2] as string).trim();
  const trimmed = namePart.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
      ? trimmed.slice(1, -1)
      : trimmed;
  if (!unquoted) return undefined;
  if (unquoted.toLowerCase() === addressPart.toLowerCase()) return undefined;
  return unquoted;
}

function normalizedAuthDomain(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^[@<"']+|[>"'),]+$/g, '')
    .toLowerCase();
  return (cleaned.includes('@') ? cleaned.split('@').pop() : cleaned) ?? '';
}

/**
 * Alignment between the From domain and the domain a pass clause authenticated.
 * DMARC is always strict (its header.from IS the alignment result). DKIM/SPF
 * additionally allow relaxed organizational alignment, but ONLY as a genuine
 * subdomain relationship on a dot boundary (mail.example.com ~ example.com), so
 * two different orgs under a shared public suffix never align (a.co.uk is not a
 * subdomain of b.co.uk) and nothing aligns to a bare TLD. This is conservative
 * on purpose: DKIM/SPF pass semantics already make a bare public-suffix signer
 * impossible, and a missed alignment only downgrades to "unauthenticated"
 * (never a spoof).
 */
function authDomainAligned(fromDomain: string, propertyDomain: string, relaxed: boolean): boolean {
  if (!propertyDomain) return false;
  if (propertyDomain === fromDomain) return true;
  if (!relaxed) return false;
  const hasParent = (domain: string) => domain.split('.').length >= 2;
  if (fromDomain.endsWith(`.${propertyDomain}`) && hasParent(propertyDomain)) return true;
  if (propertyDomain.endsWith(`.${fromDomain}`) && hasParent(fromDomain)) return true;
  return false;
}

/**
 * A Workspace domain with no custom DKIM key still gets every outbound message
 * signed by Google, using a per-tenant default key under gappssmtp.com whose
 * first label is the domain with dots rewritten as hyphens
 * (bmson.com → bmson-com.20251104.gappssmtp.com). Plain domain alignment can
 * never match that, so without this a domain that has not published its own
 * DKIM/SPF/DMARC records is permanently unauthenticatable.
 *
 * Accepting it is not a weakening: only Google can sign under gappssmtp.com,
 * the tenant label is derived from the domain rather than chosen by the sender,
 * and the shape is pinned to exactly <domain-as-hyphens>.<selector>.gappssmtp.com.
 *
 * BUT the domain→label map (dots→hyphens) is lossy: `mail.example.com` and the
 * registrable sibling `mail-example.com` both produce `mail-example-com`, so an
 * attacker who registers a hyphenated sibling of a victim domain and onboards
 * Workspace is issued an identical tenant label. The label alone cannot
 * disambiguate them. The exemption is therefore restricted to the ONE shape
 * whose label reverses unambiguously — a registrable domain with exactly one
 * dot and no hyphen (`example.com` → `example-com`, and no valid registrable
 * domain other than `example.com` maps to that label). Subdomains and
 * hyphenated domains must publish real SPF/DKIM/DMARC, or align to their org
 * domain via the relaxed rule. Publishing real records remains strictly better.
 */
function googleDefaultDkimAligned(fromDomain: string, propertyDomain: string): boolean {
  const suffix = '.gappssmtp.com';
  if (!fromDomain || !propertyDomain.endsWith(suffix)) return false;
  // Only a hyphen-free, single-dot registrable domain has an unambiguous label.
  if (fromDomain.includes('-') || fromDomain.split('.').length !== 2) return false;
  const labels = propertyDomain.slice(0, -suffix.length).split('.');
  if (labels.length !== 2 || !labels[1]) return false;
  return labels[0] === fromDomain.replaceAll('.', '-');
}

/**
 * A matching From header is identity only when Gmail's own receiver reports
 * aligned SPF, DKIM, or DMARC. Sender-supplied Authentication-Results headers
 * are ignored by requiring Google's authserv-id.
 *
 * Only the TOP-MOST Authentication-Results header is trusted. Gmail prepends
 * its own at delivery, so the receiver's verdict is always first; a sender can
 * inject `Authentication-Results: mx.google.com; dkim=pass ...` deeper in the
 * list, and scanning every header would accept that forgery the moment the
 * ingestion path changes (raw-MIME import, an ARC/forwarder hop, or a
 * non-Gmail receiver that does not strip the sender's copies). Reading only
 * the first header keeps this pinned to the receiver's own line.
 */
/**
 * Strip RFC-5322 comments `( ... )` (which nest) and quoted strings `"..."`
 * from a structured header value before it is split on `;`.
 *
 * Gmail echoes the sender's envelope-from into the SPF clause — both inside a
 * `(google.com: domain of <addr> ...)` comment and in `smtp.mailfrom=<addr>`.
 * An attacker using an RFC-5321-legal quoted local part can smuggle a `;` and a
 * synthetic `dkim=pass header.d=<owner>` clause through the naive split, forging
 * authentication for the owner's domain. Dropping comments and quoted spans
 * first removes every sender-controlled span that could carry a delimiter.
 */
function stripCommentsAndQuotes(value: string): string {
  let out = '';
  let commentDepth = 0;
  let inQuote = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\') {
      // A backslash escapes the next char inside a comment or quoted string.
      if (inQuote || commentDepth > 0) i += 1;
      else out += ch;
      continue;
    }
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (commentDepth > 0) {
      if (ch === '(') commentDepth += 1;
      else if (ch === ')') commentDepth -= 1;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === '(') commentDepth += 1;
    else out += ch;
  }
  return out;
}

export function gmailSenderAuthenticated(
  payload: GmailPayload | undefined,
  fromEmail: string,
): boolean {
  const fromDomain = normalizedAuthDomain(fromEmail);
  if (!fromDomain) return false;
  const topmost = (payload?.headers ?? []).find(
    (header) => header.name.toLowerCase() === 'authentication-results',
  )?.value;
  if (!topmost) return false;

  const clauses = stripCommentsAndQuotes(topmost)
    .split(';')
    .map((clause) => clause.trim());
  // The receiver's Authentication-Results must carry Google's authserv-id. If
  // the top header is a sender-supplied one with a different authserv-id, we do
  // not fall through to a lower header — that lower header is untrusted too.
  if (clauses.shift()?.toLowerCase() !== 'mx.google.com') return false;
  for (const clause of clauses) {
    const method = clause.match(/^(dmarc|dkim|spf)=pass\b/i)?.[1]?.toLowerCase();
    if (!method) continue;
    const property =
      method === 'dmarc'
        ? clause.match(/\bheader\.from=([^\s;]+)/i)?.[1]
        : method === 'dkim'
          ? clause.match(/\bheader\.(?:d|i)=([^\s;]+)/i)?.[1]
          : clause.match(/\bsmtp\.mailfrom=([^\s;]+)/i)?.[1];
    const propertyDomain = property ? normalizedAuthDomain(property) : '';
    if (!propertyDomain) continue;
    if (
      authDomainAligned(fromDomain, propertyDomain, method !== 'dmarc') ||
      (method === 'dkim' && googleDefaultDkimAligned(fromDomain, propertyDomain))
    ) {
      return true;
    }
  }
  return false;
}

type ContactTrustByEmail = ReadonlyMap<string, 'owner' | 'known'>;

/**
 * Sender trust for forwarded ingest, with nothing dropped.
 *
 * `classifySender` answers two questions at once — who is this, and is it worth
 * bothering with — and drops the message when the second answer is no. In
 * forwarded mode only the first question belongs here: the owner pointed their
 * whole inbox at the assistant, so "worth bothering with" is the importance
 * scorer's job, and it needs the message to still exist to score it.
 *
 * An unauthenticated sender is downgraded to `unknown` rather than dropped.
 * Forwarding breaks SPF by construction (the forwarding host is not in the
 * original sender's SPF record), so dropping on failed authentication would
 * silently discard a large share of genuinely forwarded mail. The trust value
 * still carries the verdict onward, and every outward action stays gated.
 *
 * Deliberately model-free: forwarded mode pays for one importance call per
 * message, and adding an automated/human call on top would double that for an
 * answer the importance score already subsumes.
 */
function ingestContentTrust(
  contactTrustByEmail: ContactTrustByEmail,
  fromEmail: string,
  authenticated: boolean,
): Trust {
  if (!authenticated) return 'unknown';
  return contactTrustByEmail.get(fromEmail) ?? 'unknown';
}

/**
 * Have we already spent today's allowance of deep triage tasks?
 *
 * The platform's flood backstop (`underExternalTaskLimit`) counts only
 * `known`/`unknown` root tasks, because those are what a third party can create
 * by sending mail. Ingest tasks run at OWNER trust — the owner's forwarding rule
 * is what created them — so they slip past it entirely. Without this brake a
 * single busy day, or one sender looping, could burn a month of model budget.
 *
 * Counted over a rolling 24 hours rather than a calendar day so a burst at
 * midnight cannot spend two days' allowance in two minutes.
 */
async function underIngestTriageLimit(deps: EmailSyncDeps, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const triaged = await syncStore(deps).triagedSince(new Date(Date.now() - 24 * 3600_000));
  return triaged < limit;
}

function missingCatalog(): never {
  throw new Error('email-sync: persistence has no document catalog');
}

/** Gmail sync's own state, from the persistence bundle of either driver. */
function syncStore(deps: EmailSyncDeps): EmailSyncRepository {
  const store = deps.persistence.emailSync;
  if (!store) throw new Error('email-sync: persistence has no Gmail sync repository');
  const writes = new Set<keyof EmailSyncRepository>([
    'raiseBaseline',
    'saveCursor',
    'completeDrain',
    'setWatchExpiration',
    'conversationForThread',
    'recordIngest',
    'markTriaged',
    'beginForwardedIngest',
    'beginDirectEmailIngest',
    'claimIngestClassification',
    'prepareIngestClassification',
    'markIngestClassificationUnknown',
    'claimIngestScore',
    'markIngestScoreBudgetBlocked',
    'markIngestScoreUnknown',
    'prepareIngestScore',
    'prepareIngestScoreFallbackUnknown',
    'prepareIngestScoreDeterministic',
    'commitEmailAdmission',
    'markIngestMessagePersisted',
    'completeForwardedIngest',
    'markDirectIngestRecoveryUnavailable',
  ]);
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'withLock') {
        return async <T>(run: (lease: EmailSyncLease) => Promise<T>) => {
          await assertGmailSyncEnabled(deps);
          await assertOperationalReady(deps);
          return (value as EmailSyncRepository['withLock']).call(target, run);
        };
      }
      if (writes.has(property as keyof EmailSyncRepository)) {
        return async (...args: unknown[]) => {
          await assertGmailSyncEnabled(deps);
          await assertOperationalReady(deps);
          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

async function assertOperationalReady(deps: EmailSyncDeps): Promise<void> {
  await assertGmailSyncEnabled(deps);
  if (deps.operationalReady && !(await deps.operationalReady())) {
    throw new Error('Firestore installation is not operationally ready');
  }
}

async function assertGmailSyncEnabled(deps: EmailSyncDeps): Promise<void> {
  if (!gmailSyncEnabled(deps.config)) throw new Error('Gmail sync disabled');
}

async function gmailSyncApi<T>(deps: EmailSyncDeps, path: string, init?: RequestInit): Promise<T> {
  await assertGmailSyncEnabled(deps);
  const result = await deps.googleClient.api<T>(path, init);
  // A setting can change while a provider request is in flight. Do not let its
  // response trigger another request or a durable checkpoint after disable.
  await assertGmailSyncEnabled(deps);
  return result;
}

/**
 * Dropping mail that claims a trusted identity is the signal that the domain's
 * SPF/DKIM/DMARC records are wrong — the failure mode this exists to surface.
 * The From value is spoofable, so anyone can provoke this: the notice is
 * throttled per address to keep it a signal rather than an amplifier, and the
 * log line always stands on its own for alerting.
 */
const OWNER_SPOOF_NOTICE_INTERVAL_MS = 60 * 60 * 1000;
const lastUnauthenticatedNoticeAt = new Map<string, number>();

async function reportUnauthenticatedTrustedSender(
  deps: EmailSyncDeps,
  fromEmail: string,
  subject: string,
  lease?: EmailSyncLease,
): Promise<void> {
  await lease?.assertCurrent();
  const now = Date.now();
  const previous = lastUnauthenticatedNoticeAt.get(fromEmail);
  if (previous !== undefined && now - previous < OWNER_SPOOF_NOTICE_INTERVAL_MS) return;
  lastUnauthenticatedNoticeAt.set(fromEmail, now);
  await deps
    .notifyOwner({
      text:
        `Dropped an email claiming to be from ${fromEmail} ("${subject.slice(0, 60)}") — ` +
        'it failed SPF/DKIM/DMARC checks. If you sent it, that domain is missing email ' +
        'authentication records and the assistant cannot accept its mail.',
    })
    .catch((err) => console.error('unauthenticated-sender notice failed', err));
}

/**
 * One arrival alert per sender per window. A sender that mails in bursts (a
 * bank confirming three steps of one transfer, a recruiter's scheduler sending
 * each invite separately) would otherwise buzz the phone once per message for
 * what the owner experiences as one thing. Best-effort and per-instance, like
 * the spoof notice above: a second instance can repeat one alert, which is the
 * failure mode worth having over a lost one.
 */
const ARRIVAL_ALERT_SENDER_INTERVAL_MS = 2 * 60 * 60 * 1000;
const lastArrivalAlertAt = new Map<string, number>();

function arrivalAlertedRecently(fromEmail: string, now = Date.now()): boolean {
  const previous = lastArrivalAlertAt.get(fromEmail);
  return previous !== undefined && now - previous < ARRIVAL_ALERT_SENDER_INTERVAL_MS;
}

/** Recorded only once an alert went out, so a notifier outage suppresses nothing. */
function recordArrivalAlert(fromEmail: string, now = Date.now()): void {
  if (lastArrivalAlertAt.size >= 500) {
    for (const [sender, at] of lastArrivalAlertAt) {
      if (now - at >= ARRIVAL_ALERT_SENDER_INTERVAL_MS) lastArrivalAlertAt.delete(sender);
    }
  }
  lastArrivalAlertAt.set(fromEmail, now);
}

function conversationForThread(
  deps: EmailSyncDeps,
  agentId: string,
  threadId: string,
  trust: Trust,
  subject: string,
  expectedPrivacyGeneration: string | null,
): Promise<string> {
  return syncStore(deps).conversationForThread(agentId, threadId, trust, subject, {
    expectedPrivacyGeneration,
  });
}

/**
 * Auto-file the attachments of an authenticated message from someone we know
 * as searchable documents (Phase 11). Best-effort and fail-open: a fetch or
 * store error on one attachment is logged and skipped, and the whole pass is
 * wrapped by the caller — attachment filing never blocks or fails triage.
 * Dedup is by content hash, so a Gmail history replay re-files nothing.
 */
export async function fileMessageAttachments(
  deps: EmailSyncDeps,
  input: { agentId: string; message: GmailMessage; trust: Trust },
  options: { throwOnFailure?: boolean } = {},
): Promise<void> {
  if (!isModuleEnabled(deps.config, 'documents')) return;
  const attachments = collectGmailAttachments(input.message.payload).slice(
    0,
    MAX_ATTACHMENTS_PER_MESSAGE,
  );
  let failed = false;
  for (const att of attachments) {
    try {
      // Skip formats we can neither read in-process nor hand to the processor.
      if (extractorFor(att.mimeType, att.filename) === 'unsupported') continue;
      if (att.size > MAX_ATTACHMENT_BYTES) continue;
      const res = await gmailSyncApi<{ data?: string }>(
        deps,
        `${GMAIL}/messages/${input.message.id}/attachments/${att.attachmentId}`,
        { signal: AbortSignal.timeout(MESSAGE_FETCH_TIMEOUT_MS) },
      );
      const bytes = res.data ? Buffer.from(res.data, 'base64url') : Buffer.alloc(0);
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
      const cleanName =
        att.filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
      const digest = createHash('sha256').update(bytes).digest('hex');
      const scopeHash = createHash('sha256')
        .update(JSON.stringify([input.agentId, input.message.id, att.attachmentId]))
        .digest('hex');
      const workspacePath = immutableArtifactPath('documents/email/', scopeHash, digest, cleanName);
      await deps.workspace.writeBytes(workspacePath, bytes, att.mimeType);
      await startDocumentIngest(deps.persistence.documentCatalog ?? deps.db ?? missingCatalog(), {
        agentId: input.agentId,
        title: att.filename.slice(0, 300),
        workspacePath,
        mime: att.mimeType,
        bytes: bytes.length,
        sha256: digest,
        source: 'email',
        sourceRef: `gmail:${input.message.id}`,
        trust: input.trust,
      });
      // A duplicate may reference this same immutable key. Never delete it
      // without a generation-fenced orphan check against the catalog.
    } catch (err) {
      if (options.throwOnFailure) failed = true;
      else console.error(`email-sync: failed to file attachment ${att.filename}`, err);
    }
  }
  if (failed) throw new Error('attachment_ingest_failed');
}

export async function fileEmailAttachmentsForObserver(
  services: Pick<ModuleServices, 'config' | 'persistence' | 'router' | 'workspace' | 'db'>,
  googleClient: GoogleClient,
  source: EmailObserverSource,
  claim: EmailObserverClaim,
  prepared: EmailAttachmentPreparedResult,
): Promise<void> {
  if (!services.persistence.emailAttachmentCustody)
    throw new Error('email_attachment_custody_unavailable');
  const custody = services.persistence.emailAttachmentCustody;
  const objectStore = requireEmailAttachmentCustodyStore(services.workspace);
  if (claim.agentId !== source.agentId) throw new Error('email_attachment_source_mismatch');
  const messageId = claim.channelMessageId.startsWith('gmail:')
    ? claim.channelMessageId.slice(6)
    : null;
  if (!messageId || messageId !== prepared.messageId)
    throw new Error('email_attachment_id_mismatch');
  const deps: EmailSyncDeps = {
    ...services,
    googleClient,
    notifyOwner: async () => undefined,
    observeInboundEmail: async () => undefined,
  };
  const message = await gmailSyncApi<{ payload?: GmailPayload }>(
    deps,
    `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full&fields=id,threadId,internalDate,labelIds,snippet,payload`,
    { signal: AbortSignal.timeout(MESSAGE_FETCH_TIMEOUT_MS) },
  );
  const currentManifest = preparedEmailAttachmentManifest(message.payload);
  if (
    currentManifest.digest !== prepared.manifestDigest ||
    currentManifest.entries.length !== prepared.entries.length
  )
    throw new Error('email_attachment_manifest_changed');
  if (prepared.entries.length === 0) return;
  const attachmentRefs = collectGmailAttachments(message.payload);
  const attachmentById = new Map(attachmentRefs.map((item) => [item.attachmentId, item]));
  const trust: Trust =
    source.ingestMode === 'forwarded'
      ? 'unknown'
      : source.contentTrust === 'owner'
        ? 'owner'
        : source.contentTrust === 'known'
          ? 'known'
          : 'unknown';

  for (let index = 0; index < prepared.entries.length; index += 1) {
    const entry = prepared.entries[index];
    const currentEntry = currentManifest.entries[index];
    if (!entry || !currentEntry || !isDeepStrictEqual(entry, currentEntry))
      throw new Error('email_attachment_manifest_changed');
    if (entry.advertisedBytes > MAX_ATTACHMENT_BYTES) continue;
    const ref = attachmentById.get(entry.providerAttachmentId);
    if (
      !ref ||
      ref.filename.slice(0, 300) !== entry.filename ||
      ref.mimeType.slice(0, 200) !== entry.mime
    )
      throw new Error('email_attachment_manifest_changed');
    const payload = await gmailSyncApi<{ data?: string }>(
      deps,
      `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(entry.providerAttachmentId)}`,
      { signal: AbortSignal.timeout(MESSAGE_FETCH_TIMEOUT_MS) },
    );
    const bytes = payload.data ? Buffer.from(payload.data, 'base64url') : Buffer.alloc(0);
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const custodyId = randomUUID();
    const workspacePath = `email-attachments/custody/${custodyId}`;
    const fence = {
      id: claim.id,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      claimGeneration: claim.claimGeneration,
      expectedPrivacyGeneration: claim.privacyGeneration,
    };
    const intent = await custody.beginEmailAttachmentCustody({
      fence,
      observerWorkId: claim.id,
      channelMessageId: claim.channelMessageId,
      providerMessageId: messageId,
      manifestDigest: prepared.manifestDigest,
      entry,
      actualBytes: bytes.length,
      sha256,
      custodyId,
      workspacePath,
    });
    if (
      intent.duplicateDocumentId &&
      ['cleanup_pending', 'duplicate_cleaned'].includes(intent.status)
    )
      continue;
    if (intent.status === 'erased' || intent.status === 'cleanup_pending')
      throw new Error('email_attachment_custody_not_publishable');
    const ownedCustodyId = intent.id;
    const ownedWorkspacePath = intent.workspacePath;

    let marker = await objectStore.inspectEmailAttachmentObject(ownedCustodyId);
    if (!marker) {
      try {
        const created = await objectStore.createEmailAttachmentMarker(ownedCustodyId);
        marker = {
          generation: created.generation,
          custodyId: ownedCustodyId,
          state: 'marker',
          sha256: null,
        };
      } catch {
        // A lost marker response is recoverable only from the exact opaque
        // custody metadata; never adopt an unmarked object at this path.
        marker = await objectStore.inspectEmailAttachmentObject(ownedCustodyId);
        if (!marker || marker.custodyId !== ownedCustodyId)
          throw new Error('email_attachment_marker_unknown');
      }
    }
    if (marker.custodyId !== ownedCustodyId) throw new Error('email_attachment_marker_changed');
    let objectGeneration = marker.generation;
    if (marker.state === 'content') {
      if (marker.sha256 !== sha256) throw new Error('email_attachment_object_conflict');
      if (
        !(await custody.recordEmailAttachmentObject({
          agentId: claim.agentId,
          custodyId: ownedCustodyId,
          generation: marker.generation,
          bytes: bytes.length,
          sha256,
        }))
      )
        throw new Error('email_attachment_object_record_failed');
    } else {
      if (
        !(await custody.recordEmailAttachmentMarker({
          agentId: claim.agentId,
          custodyId: ownedCustodyId,
          generation: marker.generation,
        }))
      )
        throw new Error('email_attachment_marker_record_failed');
      if (
        !(await custody.authorizeEmailAttachmentContent({
          fence,
          custodyId: ownedCustodyId,
          markerGeneration: marker.generation,
          actualBytes: bytes.length,
          sha256,
          mime: entry.mime,
        }))
      )
        throw new Error('email_attachment_content_not_authorized');
      let object: { generation: string };
      try {
        object = await objectStore.replaceEmailAttachmentMarker({
          custodyId: ownedCustodyId,
          markerGeneration: marker.generation,
          content: bytes,
          contentType: entry.mime,
          sha256,
        });
      } catch {
        const recovered = await objectStore.inspectEmailAttachmentObject(ownedCustodyId);
        if (
          !recovered ||
          recovered.custodyId !== ownedCustodyId ||
          recovered.state !== 'content' ||
          recovered.sha256 !== sha256
        )
          throw new Error('email_attachment_content_unknown');
        object = { generation: recovered.generation };
      }
      objectGeneration = object.generation;
      if (
        !(await custody.recordEmailAttachmentObject({
          agentId: claim.agentId,
          custodyId: ownedCustodyId,
          generation: object.generation,
          bytes: bytes.length,
          sha256,
        }))
      )
        throw new Error('email_attachment_object_record_failed');
    }

    const now = new Date();
    const file: Records['files'] = {
      id: randomUUID(),
      createdAt: now,
      agentId: source.agentId,
      taskId: null,
      workspacePath: ownedWorkspacePath,
      mime: entry.mime,
      bytes: bytes.length,
      sha256,
      objectGeneration,
      emailAttachmentCustodyId: ownedCustodyId,
    };
    const extractor = extractorFor(entry.mime, entry.filename);
    const document: Records['documents'] = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      agentId: source.agentId,
      title: entry.filename,
      fileId: file.id,
      mime: entry.mime,
      source: 'email',
      sourceRef: `gmail:${messageId}`,
      trust,
      sha256,
      status: extractor === 'unsupported' ? 'unsupported' : 'pending',
      extractor,
      chunkCount: 0,
      charCount: 0,
      error: null,
      processorTokenHash: null,
      processorStartedAt: null,
      processorAttempts: 0,
      processedTextPath: null,
      extractionMetadata: null,
    };
    const finalized = await custody.finalizeEmailAttachmentCatalog({
      fence,
      custodyId: ownedCustodyId,
      file,
      document,
    });
    if (!finalized.published) {
      if (!finalized.duplicate) throw new Error('email_attachment_catalog_publication_rejected');
      const object = await objectStore.inspectEmailAttachmentObject(ownedCustodyId);
      if (object?.custodyId === ownedCustodyId) {
        const removed = await objectStore.deleteOwnedEmailAttachment({
          custodyId: ownedCustodyId,
          expectedGeneration: object.generation,
          ...(object.state === 'content' ? { expectedSha256: sha256 } : {}),
        });
        if (removed === 'deleted' || removed === 'missing')
          await custody.markEmailAttachmentCustodyErased({
            agentId: claim.agentId,
            custodyId: ownedCustodyId,
            deletedGeneration: object.generation,
          });
      }
      continue;
    }
    if (finalized.task)
      getQueueNotifier().notify(finalized.task.id, finalized.task.queueGeneration);
  }
}

interface ForwardedIngestInput {
  agentId: string;
  message: GmailMessage;
  from: string;
  subject: string;
  text: string;
  /** Untruncated source text used only for provenance detection. */
  fullText?: string;
  rfcMessageId: string;
  providerReceivedAt?: Date | null;
  observationFence?: string | null;
  hasExternalOrUnknown?: boolean;
  authenticated: boolean;
  contactTrustByEmail: ContactTrustByEmail;
  channelMessageId: string;
  lease?: EmailSyncLease;
}

/**
 * Inspect source structure before Gmail HTML-to-text conversion and before the
 * bounded body prefix used for planning/storage. A missing/unknown attribution
 * signal remains tainted when any quote or reply evidence is present.
 */
export function emailQuotesExternalContent(
  payload: GmailPayload | undefined,
  subject: string,
  fullBody: string,
): boolean {
  const html: string[] = [];
  let hasReplyHeaders = false;
  const visit = (part: GmailPayload) => {
    for (const header of part.headers ?? []) {
      const name = header.name.toLowerCase();
      if ((name === 'in-reply-to' || name === 'references') && header.value.trim())
        hasReplyHeaders = true;
    }
    if (part.mimeType?.toLowerCase() === 'text/html' && part.body?.data) {
      html.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
    }
    for (const child of part.parts ?? []) visit(child);
  };
  if (payload) visit(payload);
  return quotesExternalContent({ subject, body: fullBody, html, hasReplyHeaders });
}

/** Preserve MIME structure as bounded metadata and bind spans to stored text. */
export function emailContentProvenance(
  payload: GmailPayload | undefined,
  input: Omit<Parameters<typeof buildEmailContentProvenance>[0], 'parts'>,
): EmailContentProvenance {
  const parts: EmailContentProvenance['parts'] = [];
  let overflow = false;
  const visit = (part: GmailPayload, path: string) => {
    const mimeType = part.mimeType?.toLowerCase() ?? 'unknown';
    const html =
      mimeType === 'text/html' && part.body?.data
        ? Buffer.from(part.body.data, 'base64url').toString('utf8')
        : null;
    const rawBoundary = html === null ? null : emailHtmlQuoteStart(html);
    const quoteMarkup = rawBoundary !== null;
    let bodyQuoteStart: number | undefined;
    if (html !== null && rawBoundary !== null && extractGmailText(part) === input.fullBody) {
      const prefix = extractGmailText({
        mimeType: 'text/html',
        body: { data: Buffer.from(html.slice(0, rawBoundary)).toString('base64url') },
      });
      if (input.fullBody.startsWith(prefix)) bodyQuoteStart = prefix.length;
    }
    const replyHeaders = (part.headers ?? []).some(
      (header) =>
        ['in-reply-to', 'references'].includes(header.name.toLowerCase()) &&
        Boolean(header.value.trim()),
    );
    if (parts.length < 256)
      parts.push({
        path,
        mimeType,
        quoteMarkup,
        replyHeaders,
        ...(bodyQuoteStart === undefined ? {} : { bodyQuoteStart }),
      });
    else overflow = true;
    for (const [index, child] of (part.parts ?? []).entries()) visit(child, `${path}.${index}`);
  };
  if (payload) visit(payload, '0');
  // Unknown/unrecorded topology cannot supply evidence of a clean sender body.
  if (!payload || overflow)
    parts.push({ path: 'unknown', mimeType: 'unknown', quoteMarkup: true, replyHeaders: false });
  return buildEmailContentProvenance({ ...input, parts });
}

/**
 * The deterministic heads-up for important mail, composed to read fine as both
 * a chat bubble and an SMS: at most three short lines, no markdown structure.
 *
 * It leads with who and what, then what the owner needs to do. The old
 * "Important email from …" headline said the same thing about a wire
 * confirmation and a recruiter waiting on an answer, which left the owner to
 * open every one to find out which kind it was.
 */
export function importantEmailNotice(
  from: string,
  subject: string,
  score: {
    category: string;
    importance: number;
    reason: string;
    nextStep?: string;
    dates: { iso: string; what: string }[];
  },
): string {
  // Scoring rationale is an operator diagnostic, not a summary for the reader.
  const sender = truncateAtBoundary(from, 120) || 'Unknown sender';
  const title = truncateAtBoundary(subject, 200) || '(no subject)';
  const lines = [`Email from ${sender}: “${title}”`];
  const step = truncateAtBoundary(score.nextStep ?? '', 80);
  if (step) lines.push(`Next: ${step}`);
  const dates = score.dates.slice(0, 3);
  if (dates.length > 0) {
    lines.push(
      `Dates: ${dates.map((d) => `${truncateAtBoundary(d.what, 80)} (${collapseWhitespace(d.iso)})`).join('; ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * Handle one message in forwarded-ingest mode: keep everything, score it, and
 * spend a triage task only on what earned one.
 *
 * The trust split is the whole point of this function. The task is enqueued at
 * OWNER trust because the owner's standing forwarding rule is what asked for
 * this work — that is what gives it access to the owner's own calendar, files,
 * memory and notifications, none of which a `known`/`unknown` task can reach
 * (`ToolRegistry.toolsForTask` strips them). It is simultaneously marked as
 * quoting external content, which forces `shouldTaintContext` to taint the
 * session, so every outward-facing, network, or memory-writing call still needs
 * the owner to approve it. Direction and authorship are different axes, and the
 * sender only ever decides the second one.
 */
// Exported for tests; the sync loop reaches it through processMessage.
export async function processForwardedIngest(
  deps: EmailSyncDeps,
  input: ForwardedIngestInput,
): Promise<'triaged' | 'skipped'> {
  await input.lease?.assertCurrent();
  await assertOperationalReady(deps);
  const { agentId, message: msg, from, subject, text, channelMessageId } = input;
  const threshold = deps.config.EMAIL_INGEST_IMPORTANCE_THRESHOLD;
  const contentTrust = ingestContentTrust(input.contactTrustByEmail, from, input.authenticated);
  const sync = syncStore(deps);
  const observationFence = Object.hasOwn(input, 'observationFence')
    ? (input.observationFence ?? null)
    : ((await sync.privacyObservationFence?.(agentId)) ?? null);
  const mailbox = await sync.mailbox();
  if (mailbox.agentId !== agentId) throw new Error('Email ingest is outside the configured owner');
  let record = await sync.ingestRecord(channelMessageId);
  let conversationId = record?.conversationId ?? null;
  if (!conversationId) {
    // The conversation carries SENDER trust for memory quarantine; the task
    // trust later remains OWNER because the forwarding rule directed this work.
    conversationId = await conversationForThread(
      deps,
      agentId,
      msg.threadId,
      contentTrust,
      subject,
      observationFence,
    );
  }
  if (!record) {
    record = await sync.beginForwardedIngest(
      {
        agentId,
        mailbox: mailbox.email.toLowerCase(),
        providerMessageId: msg.id,
        sourceMessageId: input.rfcMessageId || null,
        providerThreadId: msg.threadId,
        providerReceivedAt: gmailReceivedAt(msg),
        conversationId,
        channelMessageId,
        fromEmail: from,
        fromName: parseSenderName(gmailHeader(msg.payload, 'From')) ?? null,
        subject: subject.slice(0, 500),
        contentTrust,
        authenticated: input.authenticated,
        category: 'other',
        importance: 1,
        actionable: false,
        reason: '',
        dates: [],
      },
      {
        expectedPrivacyGeneration: observationFence,
        ...(input.lease ? { lease: input.lease } : {}),
      },
    );
  }

  // A completed source is idempotently done. An in-flight scorer is ambiguous:
  // it may have reached the provider before the process died, so never charge
  // again without a durable prepared verdict.
  if (record.pipelineStage === 'complete') return record.triaged ? 'triaged' : 'skipped';
  if (record.scoreStatus === 'in_progress') {
    const leasePrefix = `${input.lease?.holder ?? 'unfenced'}:${input.lease?.generation ?? 0}:`;
    if (!input.lease || !record.scoreClaimToken?.startsWith(leasePrefix)) {
      if (record.scoreClaimToken)
        await sync.markIngestScoreUnknown(
          agentId,
          record.id,
          record.scoreClaimToken,
          observationFence,
          input.lease,
        );
      console.warn(`email-sync: scoring outcome unknown for ${channelMessageId}; held for review`);
    }
    return 'skipped';
  }

  if (record.scoreStatus === 'pending') {
    const token = `${input.lease?.holder ?? 'unfenced'}:${input.lease?.generation ?? 0}:${randomUUID()}`;
    const deterministicNoModel = bulkByHeaders(msg.payload);
    const claimed = await sync.claimIngestScore(
      agentId,
      record.id,
      token,
      observationFence,
      input.lease,
      deterministicNoModel ? 'deterministic_no_model' : 'model_prepared',
    );
    if (claimed) {
      await input.lease?.assertCurrent();
      const outcome = await scoreEmailImportanceOutcome(deps.router, {
        from,
        subject,
        body: text,
        ...(msg.payload ? { payload: msg.payload } : {}),
        contentTrust,
        authenticated: input.authenticated,
      });
      await input.lease?.assertCurrent();
      if (outcome.kind === 'budget_blocked') {
        await sync.markIngestScoreBudgetBlocked(
          agentId,
          record.id,
          token,
          observationFence,
          input.lease,
        );
        return 'skipped';
      }
      const prepared = outcome.score;
      const preparedScore = {
        category: prepared.category,
        importance: prepared.importance,
        actionable: prepared.actionable,
        reason: truncateAtBoundary(prepared.reason, 300),
        dates: prepared.dates,
        cardCandidate: prepared.cardCandidate === true,
        nextStep: prepared.nextStep ?? null,
        securityEvidence: prepared.securityEvidence ?? null,
      };
      if (outcome.kind === 'fallback_unknown') {
        await sync.prepareIngestScoreFallbackUnknown(
          agentId,
          record.id,
          token,
          preparedScore,
          observationFence,
          input.lease,
        );
      } else if (outcome.outcome === 'deterministic_no_model') {
        await sync.prepareIngestScoreDeterministic(
          agentId,
          record.id,
          token,
          preparedScore,
          observationFence,
          input.lease,
        );
      } else {
        await sync.prepareIngestScore(
          agentId,
          record.id,
          token,
          preparedScore,
          observationFence,
          input.lease,
        );
      }
      record = (await sync.ingestRecord(channelMessageId)) ?? record;
    } else {
      record = (await sync.ingestRecord(channelMessageId)) ?? record;
      if (record.scoreStatus !== 'prepared') return 'skipped';
    }
  }
  const scoreIsCommittable =
    record.scoreStatus === 'prepared' ||
    (record.scoreStatus === 'unknown' && record.scoreOutcome === 'fallback_committed_unknown');
  if (!scoreIsCommittable) return 'skipped';

  const score = {
    category: record.category,
    importance: record.importance,
    actionable: record.actionable,
    reason: record.reason,
    dates: Array.isArray(record.dates)
      ? (record.dates as Array<{ iso: string; what: string }>)
      : [],
    cardCandidate: record.cardCandidate,
    ...(record.nextStep ? { nextStep: record.nextStep } : {}),
  };
  if (!record.messagePersisted) {
    await input.lease?.assertCurrent();
    await assertOperationalReady(deps);
    const scoreClaimToken = record.scoreClaimToken;
    if (!scoreClaimToken) throw new Error('Prepared forwarded email is missing its score claim');
    const observers = (deps.durableEmailObservers ?? []).map((observer) => observer.identity);
    await sync.commitEmailAdmission({
      agentId,
      ingestId: record.id,
      scoreClaimToken,
      source: {
        kind: 'message',
        message: {
          conversationId: conversationId as string,
          role: 'user',
          origin:
            contentTrust === 'owner'
              ? 'owner'
              : contentTrust === 'known'
                ? 'known_contact'
                : 'unknown',
          parts: [{ type: 'text', text }],
          text: `From: ${from}\nSubject: ${subject}\n\n${text}`,
          channelMessageId,
        },
      },
      finalizedIngest: {
        agentId,
        mailbox: mailbox.email.toLowerCase(),
        providerMessageId: msg.id,
        sourceMessageId: input.rfcMessageId || null,
        providerThreadId: msg.threadId,
        providerReceivedAt: input.providerReceivedAt ?? gmailReceivedAt(msg),
        conversationId,
        channelMessageId,
        fromEmail: from,
        fromName: parseSenderName(gmailHeader(msg.payload, 'From')) ?? null,
        subject: subject.slice(0, 500),
        contentTrust,
        authenticated: input.authenticated,
        category: score.category,
        importance: score.importance,
        actionable: score.actionable,
        reason: record.reason,
        dates: score.dates,
        cardCandidate: record.cardCandidate,
        nextStep: record.nextStep ?? null,
        securityEvidence: record.securityEvidence ?? null,
        pipelineStage: 'message_persisted',
        scoreStatus: record.scoreStatus,
        scoreOutcome: record.scoreOutcome,
        scoreClaimToken,
        messagePersisted: true,
        ingestMode: 'forwarded',
        hasExternalOrUnknown: input.hasExternalOrUnknown ?? true,
      },
      observers,
      expectedPrivacyGeneration: observationFence,
      ...(input.lease ? { lease: input.lease } : {}),
    });
    await input.lease?.assertCurrent();
    await assertOperationalReady(deps);
    record = (await sync.ingestRecord(channelMessageId)) ?? record;
  }
  if (!conversationId) conversationId = record.conversationId;
  if (!conversationId) return 'skipped';
  const ingestId = record.id;

  let securityObservation: Awaited<ReturnType<typeof sync.observeSecurityIncident>> | null = null;
  if (score.category === 'security') {
    await input.lease?.assertCurrent();
    await assertOperationalReady(deps);
    securityObservation = await sync.observeSecurityIncident({
      agentId: input.agentId,
      channelMessageId: input.channelMessageId,
      sourceMessageId: input.rfcMessageId || null,
      mailbox: mailbox.email,
      authenticated: input.authenticated,
      evidence: record.securityEvidence ?? null,
      sourceText: input.text.slice(0, 20_000),
      observedAt: input.providerReceivedAt ?? new Date(),
      observationFence,
    });
  }

  // Forwarded-mode source content never enters the owner's writing corpus.

  // File attachments from everything except bulk marketing, so the owner's mail
  // becomes a searchable document archive. Dedupe is by content hash, so a
  // replay re-files nothing.
  // Attachment work is represented by the frozen observer row. Its worker is
  // intentionally paused until every external effect in that registry is fenced.

  // Deterministic heads-up: important mail interrupts the owner on arrival
  // rather than only when the triage task later judges it worth a ping — and
  // it still fires when the daily triage ceiling holds the task back, which is
  // exactly the busy day the owner most needs to hear about. Best-effort: a
  // notifier outage must not stall the history cursor. A crash between here
  // and the task's enqueue can replay into a second ping; that rare duplicate
  // beats a silent loss.
  let alerted = false;
  let securityClaimed = false;
  const highConfidenceSecurity = Boolean(
    securityObservation && securityObservation.incident.confidence !== 'separate-source',
  );
  const securityNeedsAttention =
    highConfidenceSecurity || score.importance >= deps.config.EMAIL_INGEST_NOTIFY_THRESHOLD;
  if (securityObservation && securityNeedsAttention) {
    securityClaimed = await sync.claimSecurityAttention({
      agentId: input.agentId,
      incidentId: securityObservation.incident.id,
      revision: securityObservation.incident.revision,
      producer: 'arrival',
      now: new Date(),
    });
  }
  if (
    (score.importance >= deps.config.EMAIL_INGEST_NOTIFY_THRESHOLD || highConfidenceSecurity) &&
    (!securityObservation || securityClaimed)
  ) {
    if (!securityClaimed && arrivalAlertedRecently(from)) {
      // The owner was just told about this sender; the triage task is told
      // so too, which keeps it from pinging about the follow-up either.
      alerted = true;
    } else {
      await input.lease?.assertCurrent();
      // Ambient urgency: it still lands the moment it arrives, but quiet hours
      // and the daily cap govern whether the phone buzzes for it.
      const sender = parseSenderName(gmailHeader(msg.payload, 'From')) ?? from;
      alerted = await deps
        .notifyOwner({ text: importantEmailNotice(sender, subject, score), urgency: 'ambient' })
        .then(() => {
          if (!securityClaimed) recordArrivalAlert(from);
          return true;
        })
        .catch((err) => {
          console.error('email-sync: importance alert failed', err);
          return false;
        });
      if (securityClaimed && securityObservation) {
        await sync.completeSecurityAttention({
          agentId: input.agentId,
          incidentId: securityObservation.incident.id,
          revision: securityObservation.incident.revision,
          deliveryStatus: alerted ? 'accepted' : 'unknown',
          now: new Date(),
        });
      }
      await input.lease?.assertCurrent();
    }
  }

  if (
    score.importance < threshold &&
    !(deps.config.PROACTIVE_CARDS_ENABLED && score.cardCandidate)
  ) {
    console.log(
      `email-sync: ingested ${from} ("${subject.slice(0, 40)}") at importance ${score.importance} — stored without triage`,
    );
    await sync.completeForwardedIngest(ingestId, { triaged: false, now: new Date() }, input.lease);
    return 'skipped';
  }

  const enqueued = await enqueueIngestTriage(deps, {
    ...input,
    conversationId,
    contentTrust,
    importance: score.importance,
    category: score.category,
    ingestId,
    ownerAlerted: alerted,
  });
  return enqueued ? 'triaged' : 'skipped';
}

/**
 * Enqueue the deep triage task for an ingested message, subject to the daily
 * ceiling. Returns whether a task was created.
 */
async function enqueueIngestTriage(
  deps: EmailSyncDeps,
  input: ForwardedIngestInput & {
    conversationId: string;
    contentTrust: Trust;
    importance: number;
    category: string;
    ingestId: string;
    ownerAlerted?: boolean;
  },
): Promise<boolean> {
  if (!(await underIngestTriageLimit(deps, deps.config.EMAIL_INGEST_MAX_TRIAGE_PER_DAY))) {
    console.warn(
      `email-sync: daily ingest triage ceiling reached; storing ${input.from} without triage`,
    );
    return false;
  }

  await input.lease?.assertCurrent();
  await assertOperationalReady(deps);
  const { task, created } = await enqueueTask(deps.persistence.tasks, {
    type: 'email_triage',
    maxSteps: 16,
    // 16 steps on the reason role does not fit the default $0.50 cap: the soft
    // fallback threshold trips around step 6 and the hard cap around step 10,
    // leaving the tail unrunnable. This is a ceiling, not typical spend.
    budgetUsdLimit: '1.20',
    event: {
      source: 'email',
      externalEventId: input.channelMessageId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      // The OWNER directed this ingest; see processForwardedIngest.
      trust: 'owner',
      payload: {
        threadId: input.message.threadId,
        messageId: input.message.id,
        rfcMessageId: input.rfcMessageId,
        from: input.from,
        subject: input.subject,
        // Always true for ingest: the body is a third party's words arriving
        // through the owner's pipe, so the session must run tainted.
        quotesExternalContent: true,
        emailProvenance: emailContentProvenance(input.message.payload, {
          subject: input.subject,
          fullBody: input.fullText ?? input.text,
          storedBody: input.text,
          messagePrefix: `From: ${input.from}\nSubject: ${input.subject}\n\n`,
          authenticated: input.authenticated,
          mode: 'forwarded',
        }),
        ingest: {
          forwarded: true,
          contentTrust: input.contentTrust,
          authenticated: input.authenticated,
          importance: input.importance,
          category: input.category,
          ownerAlerted: input.ownerAlerted === true,
        },
      },
    },
  });

  if (created) {
    console.log(
      `email-sync: triaging ${input.from} ("${input.subject.slice(0, 40)}") — ${input.category}, importance ${input.importance}`,
    );
  }
  // The task repository returns the idempotent existing task when a prior
  // process committed the enqueue but died before this receipt was written.
  // Persist the task receipt either way so replay cannot leave the stage open.
  await input.lease?.assertCurrent();
  await syncStore(deps).completeForwardedIngest(
    input.ingestId,
    {
      triaged: true,
      taskId: task.id,
      now: new Date(),
    },
    input.lease,
  );
  return true;
}

interface DirectIngestInput {
  agentId: string;
  message: GmailMessage;
  from: string;
  subject: string;
  text: string;
  rfcMessageId: string;
  authenticated: boolean;
  contactTrustByEmail: ContactTrustByEmail;
  channelMessageId: string;
  observationFence: string | null;
  provenance: EmailContentProvenance;
  /** Reused only by the bounded recovery scan; first admission computes it once. */
  frozenDirectRouting?: 'application_confirmation' | 'email_triage';
  lease?: EmailSyncLease;
}

async function processDirectAdmission(
  deps: EmailSyncDeps,
  input: DirectIngestInput,
): Promise<'triaged' | 'skipped'> {
  const sync = syncStore(deps);
  const mailbox = await sync.mailbox();
  let record = await sync.ingestRecord(input.channelMessageId);
  if (!record) {
    // Freeze the read-only routing decision and body-free provenance before
    // classification/scoring can be interrupted. Recovery reuses this input.
    const initialDirectRouting =
      input.frozenDirectRouting ??
      (await routeApplicationConfirmation(
        { persistence: applicationPersistence(deps.persistence), notifyOwner: deps.notifyOwner },
        {
          agentId: input.agentId,
          messageId: input.message.id,
          from: input.from,
          subject: input.subject,
          body: input.text,
          authenticated: input.authenticated,
          emailContentProvenance: input.provenance,
        },
      ));
    record = await sync.beginDirectEmailIngest(
      {
        agentId: input.agentId,
        mailbox: mailbox.email.toLowerCase(),
        providerMessageId: input.message.id,
        sourceMessageId: input.rfcMessageId || null,
        providerThreadId: input.message.threadId,
        providerReceivedAt: gmailReceivedAt(input.message),
        conversationId: null,
        channelMessageId: input.channelMessageId,
        fromEmail: input.from,
        fromName: parseSenderName(gmailHeader(input.message.payload, 'From')) ?? null,
        subject: input.subject.slice(0, 500),
        contentTrust: ingestContentTrust(
          input.contactTrustByEmail,
          input.from,
          input.authenticated,
        ),
        authenticated: input.authenticated,
        category: 'other',
        importance: 1,
        actionable: false,
        reason: '',
        dates: [],
        ingestMode: 'direct',
        hasExternalOrUnknown: input.provenance.hasExternalOrUnknown,
        directRouting: initialDirectRouting,
        emailContentProvenance: input.provenance,
      },
      {
        expectedPrivacyGeneration: input.observationFence,
        ...(input.lease ? { lease: input.lease } : {}),
      },
    );
  }

  // A durable classification claim precedes the model call. If another drain
  // owns an in-flight claim, or an interrupted claim has no safe stored result,
  // leave the source untouched for explicit recovery rather than asking twice.
  let classification = record.preparedClassification as { automated: boolean } | null;
  if (record.classificationStatus === 'pending') {
    const token = `${input.lease?.holder ?? 'unfenced'}:${input.lease?.generation ?? 0}:${randomUUID()}`;
    const claimed = await sync.claimIngestClassification(
      input.agentId,
      record.id,
      token,
      input.observationFence,
      input.lease,
    );
    if (claimed) {
      const contactTrust = input.contactTrustByEmail.get(input.from);
      let verdict: { automated: boolean } | null = null;
      let definitive = false;
      if (contactTrust === 'owner' || contactTrust === 'known') {
        verdict = { automated: false };
        definitive = true;
      } else if (/no-?reply|notifications?@|newsletter|mailer|donotreply/i.test(input.from)) {
        verdict = { automated: true };
        definitive = true;
      } else {
        try {
          const result = await deps.router.object<z.infer<typeof AutomatedSchema>>('classify', {
            schema: AutomatedSchema,
            system:
              'Classify whether this email is automated (newsletter/notification/receipt/marketing) or written by a human.',
            prompt: `From: ${input.from}\nSubject: ${input.subject}\nSnippet: ${input.message.snippet ?? ''}`,
            abortSignal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
          });
          if (result.ok) {
            verdict = { automated: result.object.automated };
            definitive = true;
          } else if (result.attempts?.length) verdict = { automated: false };
        } catch {
          // Preserve the historical fail-open sender classification, but store
          // it as an ambiguous fallback so this provider call is never repeated.
          verdict = { automated: false };
        }
      }
      await input.lease?.assertCurrent();
      if (verdict && definitive) {
        await sync.prepareIngestClassification(
          input.agentId,
          record.id,
          token,
          verdict,
          input.observationFence,
          input.lease,
        );
      } else {
        await sync.markIngestClassificationUnknown(
          input.agentId,
          record.id,
          token,
          verdict,
          input.observationFence,
          input.lease,
        );
      }
      record = (await sync.ingestRecord(input.channelMessageId)) ?? record;
    } else {
      record = (await sync.ingestRecord(input.channelMessageId)) ?? record;
    }
    classification = record.preparedClassification as { automated: boolean } | null;
  }
  if (!classification || !['prepared', 'unknown'].includes(record.classificationStatus))
    return 'skipped';

  const contentTrust = ingestContentTrust(
    input.contactTrustByEmail,
    input.from,
    input.authenticated,
  );
  if (record.scoreStatus === 'in_progress') {
    if (record.scoreClaimToken)
      await sync.markIngestScoreUnknown(
        input.agentId,
        record.id,
        record.scoreClaimToken,
        input.observationFence,
        input.lease,
      );
    return 'skipped';
  }
  if (record.scoreStatus === 'pending') {
    const token = `${input.lease?.holder ?? 'unfenced'}:${input.lease?.generation ?? 0}:${randomUUID()}`;
    const deterministicNoModel = bulkByHeaders(input.message.payload);
    const claimed = await sync.claimIngestScore(
      input.agentId,
      record.id,
      token,
      input.observationFence,
      input.lease,
      deterministicNoModel ? 'deterministic_no_model' : 'model_prepared',
    );
    if (!claimed) {
      record = (await sync.ingestRecord(input.channelMessageId)) ?? record;
    } else {
      await input.lease?.assertCurrent();
      const outcome = await scoreEmailImportanceOutcome(deps.router, {
        from: input.from,
        subject: input.subject,
        body: input.text,
        ...(input.message.payload ? { payload: input.message.payload } : {}),
        contentTrust,
        authenticated: input.authenticated,
      });
      await input.lease?.assertCurrent();
      if (outcome.kind === 'budget_blocked') {
        await sync.markIngestScoreBudgetBlocked(
          input.agentId,
          record.id,
          token,
          input.observationFence,
          input.lease,
        );
        return 'skipped';
      }
      const score = {
        category: outcome.score.category,
        importance: outcome.score.importance,
        actionable: outcome.score.actionable,
        reason: truncateAtBoundary(outcome.score.reason, 300),
        dates: outcome.score.dates,
        cardCandidate: outcome.score.cardCandidate === true,
        nextStep: outcome.score.nextStep ?? null,
        securityEvidence: outcome.score.securityEvidence ?? null,
      } satisfies PreparedEmailScore;
      if (outcome.kind === 'fallback_unknown') {
        await sync.prepareIngestScoreFallbackUnknown(
          input.agentId,
          record.id,
          token,
          score,
          input.observationFence,
          input.lease,
        );
      } else if (outcome.outcome === 'deterministic_no_model') {
        await sync.prepareIngestScoreDeterministic(
          input.agentId,
          record.id,
          token,
          score,
          input.observationFence,
          input.lease,
        );
      } else {
        await sync.prepareIngestScore(
          input.agentId,
          record.id,
          token,
          score,
          input.observationFence,
          input.lease,
        );
      }
      record = (await sync.ingestRecord(input.channelMessageId)) ?? record;
    }
  }

  const scoreReady =
    record.scoreStatus === 'prepared' ||
    (record.scoreStatus === 'unknown' && record.scoreOutcome === 'fallback_committed_unknown');
  if (!scoreReady || !record.scoreClaimToken) return 'skipped';

  const automated = classification.automated;
  const directRouting =
    input.frozenDirectRouting ??
    (record.directRouting === 'application_confirmation' || record.directRouting === 'email_triage'
      ? record.directRouting
      : undefined) ??
    (await routeApplicationConfirmation(
      {
        persistence: applicationPersistence(deps.persistence),
        notifyOwner: deps.notifyOwner,
      },
      {
        agentId: input.agentId,
        messageId: input.message.id,
        from: input.from,
        subject: input.subject,
        body: input.text,
        authenticated: input.authenticated,
        emailContentProvenance: input.provenance,
      },
    ));
  const conversationId = automated
    ? null
    : await conversationForThread(
        deps,
        input.agentId,
        input.message.threadId,
        contentTrust,
        input.subject,
        input.observationFence,
      );
  if (!automated && !conversationId) throw new Error('email_conversation_unavailable');
  await input.lease?.assertCurrent();
  await assertOperationalReady(deps);
  const source = automated
    ? { kind: 'automated_source' as const, body: input.text }
    : {
        kind: 'message' as const,
        message: {
          conversationId: conversationId as string,
          role: 'user' as const,
          origin:
            contentTrust === 'owner'
              ? ('owner' as const)
              : contentTrust === 'known'
                ? ('known_contact' as const)
                : ('unknown' as const),
          parts: [{ type: 'text' as const, text: input.text }],
          text: `From: ${input.from}\nSubject: ${input.subject}\n\n${input.text}`,
          channelMessageId: input.channelMessageId,
        },
      };
  await sync.commitEmailAdmission({
    agentId: input.agentId,
    ingestId: record.id,
    scoreClaimToken: record.scoreClaimToken,
    source,
    finalizedIngest: {
      agentId: input.agentId,
      mailbox: mailbox.email.toLowerCase(),
      providerMessageId: input.message.id,
      sourceMessageId: input.rfcMessageId || null,
      providerThreadId: input.message.threadId,
      providerReceivedAt: gmailReceivedAt(input.message),
      conversationId,
      channelMessageId: input.channelMessageId,
      fromEmail: input.from,
      fromName: parseSenderName(gmailHeader(input.message.payload, 'From')) ?? null,
      subject: input.subject.slice(0, 500),
      contentTrust,
      authenticated: input.authenticated,
      category: record.category,
      importance: record.importance,
      actionable: record.actionable,
      reason: record.reason,
      dates: Array.isArray(record.dates) ? (record.dates as PreparedEmailScore['dates']) : [],
      cardCandidate: record.cardCandidate,
      nextStep: record.nextStep,
      securityEvidence: record.securityEvidence,
      pipelineStage: 'score_prepared',
      scoreStatus: record.scoreStatus,
      scoreOutcome: record.scoreOutcome,
      scoreClaimToken: record.scoreClaimToken,
      messagePersisted: false,
      ingestMode: 'direct',
      hasExternalOrUnknown: input.provenance.hasExternalOrUnknown,
      directRouting,
      emailContentProvenance: input.provenance,
      classificationStatus: record.classificationStatus,
      classificationClaimToken: record.classificationClaimToken,
      preparedClassification: classification,
    },
    observers: directObserverIdentities(deps),
    expectedPrivacyGeneration: input.observationFence,
    ...(input.lease ? { lease: input.lease } : {}),
  });

  if (record.category === 'security') {
    try {
      await sync.observeSecurityIncident({
        agentId: input.agentId,
        channelMessageId: input.channelMessageId,
        sourceMessageId: input.rfcMessageId || null,
        mailbox: mailbox.email,
        authenticated: input.authenticated,
        evidence: record.securityEvidence ?? null,
        sourceText: input.text,
        observedAt: gmailReceivedAt(input.message) ?? new Date(),
        observationFence: input.observationFence,
      });
    } catch {
      // This legacy security index is separate from observer admission and is
      // idempotent by channel ID; a later security backfill can repair it.
    }
  }

  if (automated) return 'skipped';
  return directRouting === 'email_triage' ? 'triaged' : 'skipped';
}

export async function processMessage(
  deps: EmailSyncDeps,
  agentId: string,
  botEmail: string,
  contactTrustByEmail: ContactTrustByEmail,
  messageId: string,
  lease?: EmailSyncLease,
  passedObservationFence?: string | null,
): Promise<'triaged' | 'skipped'> {
  await lease?.assertCurrent();
  await assertOperationalReady(deps);
  const channelMessageId = `gmail:${messageId}`;
  const sync = syncStore(deps);
  const observationFence =
    passedObservationFence !== undefined
      ? passedObservationFence
      : ((await sync.privacyObservationFence?.(agentId)) ?? null);
  const [existing, existingTask] = await Promise.all([
    sync.inboundMessage(channelMessageId),
    sync.hasTaskForEvent(channelMessageId),
  ]);
  // History replays are normal after a partial page failure. Fetch current
  // metadata again, but avoid paying to classify a message already persisted.
  if (existingTask && !emailIngestForwarded(deps.config)) return 'skipped';
  if (existing && !emailIngestForwarded(deps.config)) {
    const admitted = await sync.ingestRecord(channelMessageId);
    // New durable sources retain their frozen observer set and route on replay;
    // the legacy task-repair path below belongs only to pre-admission messages.
    if (admitted?.admittedSourceKind != null) return 'skipped';
  }

  const msg = await gmailSyncApi<GmailMessage>(
    deps,
    `${GMAIL}/messages/${messageId}?format=full&fields=id,threadId,internalDate,labelIds,snippet,payload`,
    { signal: AbortSignal.timeout(MESSAGE_FETCH_TIMEOUT_MS) },
  );
  await lease?.assertCurrent();
  const from = parseSenderEmail(gmailHeader(msg.payload, 'From'));
  const subject = gmailHeader(msg.payload, 'Subject');
  // RFC-822 Message-ID header (distinct from msg.id, the Gmail internal id).
  // Captured here from the format=full payload so the reply path can thread
  // (In-Reply-To/References) without a second per-send metadata fetch.
  const rfcMessageId = gmailHeader(msg.payload, 'Message-ID');

  // Never triage the bot's own outbound mail.
  if (from === botEmail.toLowerCase()) return 'skipped';
  if (!msg.labelIds?.includes('INBOX')) return 'skipped';

  const fullText = extractGmailText(msg.payload);
  const text = fullText.slice(0, 20000);
  const authenticated = gmailSenderAuthenticated(msg.payload, from);
  const provenance = emailContentProvenance(msg.payload, {
    subject,
    fullBody: fullText,
    storedBody: text,
    messagePrefix: `From: ${from}\nSubject: ${subject}\n\n`,
    authenticated,
    mode: 'direct',
  });
  const hasQuotedContent = provenance.hasExternalOrUnknown;
  // Direct ingress must reject unauthenticated source facts before paid card
  // composition or any observer gets a chance to persist/notify. Forwarded
  // ingestion has a separate owner-configured policy and keeps its source trust.
  if (!emailIngestForwarded(deps.config) && !authenticated) {
    if (contactTrustByEmail.has(from))
      await reportUnauthenticatedTrustedSender(deps, from, subject, lease);
    return 'skipped';
  }

  // A persisted direct-mode message is already beyond the observer boundary.
  // Recover only its missing task on replay; don't pay to compose its card or
  // run application confirmation again. This is a replay guard, not a durable
  // observer outbox: a crash after the first persist and before observer
  // delivery can still leave that observer unapplied.
  if (!emailIngestForwarded(deps.config) && existing) {
    const persistedTrust: Trust =
      existing.origin === 'owner'
        ? 'owner'
        : existing.origin === 'known_contact'
          ? 'known'
          : 'unknown';
    let created = false;
    try {
      await lease?.assertCurrent();
      await assertOperationalReady(deps);
      ({ created } = await enqueueTask(deps.persistence.tasks, {
        type: 'email_triage',
        maxSteps: 16,
        budgetUsdLimit: '1.20',
        event: {
          source: 'email',
          externalEventId: channelMessageId,
          agentId,
          conversationId: existing.conversationId,
          trust: persistedTrust,
          payload: {
            threadId: msg.threadId,
            messageId: msg.id,
            rfcMessageId,
            from,
            subject,
            quotesExternalContent: hasQuotedContent,
            emailProvenance: provenance,
          },
        },
      }));
    } catch (error) {
      if (error instanceof TaskRateLimitError) {
        console.warn(`email-sync: task rate limit reached; skipping triage for ${from}`);
        return 'skipped';
      }
      throw error;
    }
    return created ? 'triaged' : 'skipped';
  }

  // Unknown authenticated senders can still reach the classification model,
  // application watcher and paid email-card observers. Admit them against the
  // existing daily ingest ceiling before any of those operations. Known
  // contacts and the owner keep their existing delivery path.
  if (
    !emailIngestForwarded(deps.config) &&
    !contactTrustByEmail.has(from) &&
    !(await underIngestTriageLimit(deps, deps.config.EMAIL_INGEST_MAX_TRIAGE_PER_DAY))
  ) {
    console.warn(
      `email-sync: daily ingest triage ceiling reached; skipping untrusted sender ${from}`,
    );
    return 'skipped';
  }

  await assertOperationalReady(deps);
  await lease?.assertCurrent();
  // Application confirmations are included in the frozen observer snapshot
  // and applied from the admitted canonical source. Running the legacy inline
  // watcher here could mutate a Sheet before atomic admission, or duplicate its
  // task/notice after an admission retry.

  if (emailIngestForwarded(deps.config)) {
    // Forwarded mode keeps its separate owner-configured ingestion policy.
    // Atomic admission freezes the current observer set with the source. Do not
    // also fan this event out through legacy callbacks.
    const result = await processForwardedIngest(deps, {
      agentId,
      message: msg,
      from,
      subject,
      text,
      fullText,
      rfcMessageId,
      providerReceivedAt: gmailReceivedAt(msg),
      authenticated,
      contactTrustByEmail,
      channelMessageId,
      observationFence,
      hasExternalOrUnknown: hasQuotedContent,
      ...(lease ? { lease } : {}),
    });
    // The atomic admission contains the frozen registry and source pointer.
    // Do not also invoke legacy callbacks for this event.
    return result;
  }

  return processDirectAdmission(deps, {
    agentId,
    message: msg,
    from,
    subject,
    text,
    rfcMessageId,
    authenticated,
    contactTrustByEmail,
    channelMessageId,
    observationFence,
    provenance,
    ...(lease ? { lease } : {}),
  });
}

interface DirectRecoveryResult {
  processed: number;
  morePending: boolean;
}

async function markDirectRecoveryUnavailable(
  sync: EmailSyncRepository,
  deps: EmailSyncDeps,
  row: RecoverableDirectIngest,
  mailbox: string,
  observationFence: string | null,
  lease: EmailSyncLease,
  reason:
    | 'provider_message_missing'
    | 'provider_access_denied'
    | 'provider_temporarily_unavailable'
    | 'checkpoint_inconsistent',
): Promise<void> {
  await lease.assertCurrent();
  await assertOperationalReady(deps);
  await sync.markDirectIngestRecoveryUnavailable({
    agentId: row.agentId,
    mailbox,
    ingestId: row.id,
    expectedPrivacyGeneration: observationFence,
    lease,
    reason,
  });
}

/**
 * Resume bounded direct-ingress checkpoints independently of Gmail history.
 * It never retries a classification or score call whose durable claim was
 * interrupted: those rows are fenced unknown and left for owner attention.
 */
export async function recoverDirectIngests(
  deps: EmailSyncDeps,
  input: {
    agentId: string;
    mailbox: string;
    botEmail: string;
    contactTrustByEmail: ContactTrustByEmail;
    observationFence: string | null;
    lease: EmailSyncLease;
  },
): Promise<DirectRecoveryResult> {
  const sync = syncStore(deps);
  if (!sync.listRecoverableDirectIngests || !sync.markDirectIngestRecoveryUnavailable)
    return { processed: 0, morePending: false };

  const rows = await sync.listRecoverableDirectIngests({
    agentId: input.agentId,
    mailbox: input.mailbox.toLowerCase(),
    expectedPrivacyGeneration: input.observationFence,
    lease: input.lease,
    limit: MAX_DIRECT_RECOVERY_PER_SYNC,
  });
  const startedAt = Date.now();
  let processed = 0;
  let handled = 0;
  for (const row of rows) {
    if (
      handled >= MAX_DIRECT_RECOVERY_PER_SYNC ||
      (handled > 0 && Date.now() - startedAt >= MAX_DIRECT_RECOVERY_WALL_MS)
    )
      break;
    handled++;
    await input.lease.renew();
    await input.lease.assertCurrent();
    await assertOperationalReady(deps);

    const mailbox = input.mailbox.toLowerCase();
    const identityMatches =
      row.agentId === input.agentId &&
      row.mailbox.toLowerCase() === mailbox &&
      row.authenticated === true &&
      row.channelMessageId === `gmail:${row.providerMessageId ?? ''}` &&
      Boolean(row.providerMessageId) &&
      row.admittedSourceKind === null &&
      row.admittedSourceId === null &&
      row.messagePersisted === false;
    if (!identityMatches) {
      await markDirectRecoveryUnavailable(
        sync,
        deps,
        row,
        mailbox,
        input.observationFence,
        input.lease,
        'checkpoint_inconsistent',
      );
      continue;
    }

    // A previous process may have reached a paid provider before it died.
    // Mark its exact claim unknown and stop this row before any Gmail refetch.
    if (row.classificationStatus === 'in_progress') {
      if (row.classificationClaimToken) {
        await sync.markIngestClassificationUnknown(
          row.agentId,
          row.id,
          row.classificationClaimToken,
          row.preparedClassification,
          input.observationFence,
          input.lease,
        );
      } else {
        await markDirectRecoveryUnavailable(
          sync,
          deps,
          row,
          mailbox,
          input.observationFence,
          input.lease,
          'checkpoint_inconsistent',
        );
      }
      continue;
    }
    if (row.scoreStatus === 'in_progress') {
      if (row.scoreClaimToken) {
        await sync.markIngestScoreUnknown(
          row.agentId,
          row.id,
          row.scoreClaimToken,
          input.observationFence,
          input.lease,
        );
      } else {
        await markDirectRecoveryUnavailable(
          sync,
          deps,
          row,
          mailbox,
          input.observationFence,
          input.lease,
          'checkpoint_inconsistent',
        );
      }
      continue;
    }

    const reusableClassification =
      row.classificationStatus === 'pending' ||
      ((row.classificationStatus === 'prepared' || row.classificationStatus === 'unknown') &&
        row.preparedClassification !== null &&
        row.classificationClaimToken !== null);
    const reusableScore =
      row.scoreStatus === 'pending' ||
      (row.scoreStatus === 'prepared' && row.score !== null && row.scoreClaimToken !== null) ||
      (row.scoreStatus === 'unknown' &&
        row.scoreOutcome === 'fallback_committed_unknown' &&
        row.score !== null &&
        row.scoreClaimToken !== null);
    if (!reusableClassification || !reusableScore) {
      await markDirectRecoveryUnavailable(
        sync,
        deps,
        row,
        mailbox,
        input.observationFence,
        input.lease,
        'checkpoint_inconsistent',
      );
      continue;
    }
    if (
      !row.directRouting ||
      !['application_confirmation', 'email_triage'].includes(row.directRouting) ||
      !row.emailContentProvenance ||
      row.emailContentProvenance.hasExternalOrUnknown !== row.hasExternalOrUnknown
    ) {
      await markDirectRecoveryUnavailable(
        sync,
        deps,
        row,
        mailbox,
        input.observationFence,
        input.lease,
        'checkpoint_inconsistent',
      );
      continue;
    }

    let message: GmailMessage;
    try {
      message = await gmailSyncApi<GmailMessage>(
        deps,
        `${GMAIL}/messages/${row.providerMessageId}?format=full&fields=id,threadId,internalDate,labelIds,snippet,payload`,
        { signal: AbortSignal.timeout(MESSAGE_FETCH_TIMEOUT_MS) },
      );
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 404) {
        await markDirectRecoveryUnavailable(
          sync,
          deps,
          row,
          mailbox,
          input.observationFence,
          input.lease,
          'provider_message_missing',
        );
        continue;
      }
      if (status === 401 || status === 403) {
        await markDirectRecoveryUnavailable(
          sync,
          deps,
          row,
          mailbox,
          input.observationFence,
          input.lease,
          'provider_access_denied',
        );
        continue;
      }
      if (status === 429 || (typeof status === 'number' && status >= 500) || status === undefined) {
        await markDirectRecoveryUnavailable(
          sync,
          deps,
          row,
          mailbox,
          input.observationFence,
          input.lease,
          'provider_temporarily_unavailable',
        );
        continue;
      }
      throw error;
    }

    await input.lease.assertCurrent();
    await assertOperationalReady(deps);
    const from = parseSenderEmail(gmailHeader(message.payload, 'From'));
    const subject = gmailHeader(message.payload, 'Subject');
    const rfcMessageId = gmailHeader(message.payload, 'Message-ID');
    if (
      message.id !== row.providerMessageId ||
      message.threadId !== row.providerThreadId ||
      !message.labelIds?.includes('INBOX') ||
      from !== row.fromEmail.toLowerCase() ||
      subject.slice(0, 500) !== row.subject ||
      (rfcMessageId || null) !== row.sourceMessageId
    ) {
      await markDirectRecoveryUnavailable(
        sync,
        deps,
        row,
        mailbox,
        input.observationFence,
        input.lease,
        'checkpoint_inconsistent',
      );
      continue;
    }
    if (!gmailSenderAuthenticated(message.payload, from)) {
      await markDirectRecoveryUnavailable(
        sync,
        deps,
        row,
        mailbox,
        input.observationFence,
        input.lease,
        'provider_access_denied',
      );
      continue;
    }
    if (from === input.botEmail.toLowerCase()) {
      await markDirectRecoveryUnavailable(
        sync,
        deps,
        row,
        mailbox,
        input.observationFence,
        input.lease,
        'checkpoint_inconsistent',
      );
      continue;
    }

    const fullText = extractGmailText(message.payload);
    const text = fullText.slice(0, 20_000);
    const provenance = emailContentProvenance(message.payload, {
      subject,
      fullBody: fullText,
      storedBody: text,
      messagePrefix: `From: ${from}\nSubject: ${subject}\n\n`,
      authenticated: true,
      mode: 'direct',
    });
    if (
      !isDeepStrictEqual(provenance, row.emailContentProvenance) ||
      ingestContentTrust(input.contactTrustByEmail, from, true) !== row.contentTrust
    ) {
      await markDirectRecoveryUnavailable(
        sync,
        deps,
        row,
        mailbox,
        input.observationFence,
        input.lease,
        'checkpoint_inconsistent',
      );
      continue;
    }

    if (row.directRouting === 'needs_attention') continue;
    await processDirectAdmission(deps, {
      agentId: input.agentId,
      message,
      from,
      subject,
      text,
      rfcMessageId,
      authenticated: true,
      contactTrustByEmail: input.contactTrustByEmail,
      channelMessageId: row.channelMessageId,
      observationFence: input.observationFence,
      provenance,
      frozenDirectRouting: row.directRouting,
      lease: input.lease,
    });
    const admitted = await sync.ingestRecord(row.channelMessageId);
    if (admitted?.admittedSourceKind !== null && admitted?.admittedSourceKind !== undefined)
      processed++;
  }
  return { processed, morePending: rows.length >= MAX_DIRECT_RECOVERY_PER_SYNC };
}

/**
 * Incremental Gmail sync. Pub/Sub pushes and the local poll both land here —
 * the notification is only a poke; history.list is the source of truth.
 * Work is durably checkpointed within each page and bounded per invocation.
 * A stale history cursor falls back to a resumable current-inbox reconciliation
 * instead of silently advancing past messages we have never inspected.
 */
async function syncMailboxOnce(
  deps: EmailSyncDeps,
  lease: EmailSyncLease,
): Promise<MailboxSyncResult> {
  if (!gmailSyncEnabled(deps.config)) return { processed: 0 };
  if (!deps.googleClient.configured()) return { processed: 0 };
  const sync = syncStore(deps);
  const agent = await sync.mailbox();
  const observationFence = (await sync.privacyObservationFence?.(agent.agentId)) ?? null;
  await lease.renew();
  const botEmail = agent.email;

  const [state, profile, contactRows] = await Promise.all([
    sync.syncState(botEmail),
    gmailSyncApi<{ historyId: string }>(deps, `${GMAIL}/profile`),
    sync.contactTrust(),
  ]);
  await assertOperationalReady(deps);
  await lease.assertCurrent();
  const contactTrustByEmail = new Map<string, 'owner' | 'known'>();
  for (const contact of contactRows) contactTrustByEmail.set(contact.email, contact.trust);

  // Recover unadmitted direct checkpoints before a missing/finished Gmail
  // history cursor can return. The scan uses its own bound and never changes
  // the cursor.
  const directRecovery = emailIngestForwarded(deps.config)
    ? { processed: 0, morePending: false }
    : await recoverDirectIngests(deps, {
        agentId: agent.agentId,
        mailbox: botEmail,
        botEmail,
        contactTrustByEmail,
        observationFence,
        lease,
      });

  if (!state?.lastHistoryId) {
    await sync.raiseBaseline(botEmail, BigInt(profile.historyId), lease);
    console.log(`email-sync: baseline set at historyId ${profile.historyId}`);
    return { processed: directRecovery.processed, morePending: directRecovery.morePending };
  }

  const rawCursor = state.cursor as Record<string, unknown> | null;
  let cursor: GmailDrainCursor;
  if (rawCursor && Object.keys(rawCursor).length > 0) {
    cursor = GmailDrainCursorSchema.parse(rawCursor);
  } else {
    cursor = {
      mode: 'history',
      startHistoryId: String(state.lastHistoryId),
      targetHistoryId: profile.historyId,
    };
  }

  const saveCursor = () => sync.saveCursor(botEmail, cursor, lease);
  // Publish the fixed target before any page work. A crash therefore resumes
  // the same drain instead of moving the baseline to a newer mailbox state.
  if (!rawCursor || Object.keys(rawCursor).length === 0) await saveCursor();

  let processed = directRecovery.processed;
  let handled = 0;
  let pagesFetched = 0;
  const startedAt = Date.now();

  while (true) {
    if (!cursor.pending) {
      if (pagesFetched >= MAX_PAGES_PER_SYNC) return { processed, morePending: true };

      if (cursor.mode === 'history') {
        await lease.renew();
        const url = new URL(`${GMAIL}/history`);
        url.searchParams.set('startHistoryId', cursor.startHistoryId as string);
        url.searchParams.append('historyTypes', 'messageAdded');
        url.searchParams.append('historyTypes', 'labelAdded');
        url.searchParams.set('labelId', 'INBOX');
        url.searchParams.set('maxResults', String(HISTORY_PAGE_SIZE));
        if (cursor.pageToken) url.searchParams.set('pageToken', cursor.pageToken);
        try {
          const page = await gmailSyncApi<{
            history?: Array<{
              messagesAdded?: Array<{ message: { id: string } }>;
              labelsAdded?: Array<{ message: { id: string }; labelIds?: string[] }>;
            }>;
            nextPageToken?: string;
          }>(deps, url.toString());
          const ids = new Set<string>();
          for (const history of page.history ?? []) {
            for (const added of history.messagesAdded ?? []) ids.add(added.message.id);
            for (const labeled of history.labelsAdded ?? []) {
              if (labeled.labelIds?.includes('INBOX')) ids.add(labeled.message.id);
            }
          }
          cursor.pending = {
            messageIds: [...ids],
            index: 0,
            ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
          };
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          console.warn('email-sync: stale historyId, reconciling the current inbox');
          cursor = { mode: 'inbox', targetHistoryId: profile.historyId };
          await saveCursor();
          continue;
        }
      } else {
        await lease.renew();
        const url = new URL(`${GMAIL}/messages`);
        url.searchParams.append('labelIds', 'INBOX');
        url.searchParams.set('maxResults', String(HISTORY_PAGE_SIZE));
        if (cursor.pageToken) url.searchParams.set('pageToken', cursor.pageToken);
        const page = await gmailSyncApi<{
          messages?: Array<{ id: string }>;
          nextPageToken?: string;
        }>(deps, url.toString());
        cursor.pending = {
          messageIds: (page.messages ?? []).map((message) => message.id),
          index: 0,
          ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
        };
      }
      pagesFetched += 1;
      // Persist message ids before classification. Automated/ignored messages
      // therefore do not incur repeated model cost after a later-page crash.
      await saveCursor();
    }

    const pending = cursor.pending;
    while (pending.index < pending.messageIds.length) {
      if (
        handled >= MAX_MESSAGES_PER_SYNC ||
        (handled > 0 && Date.now() - startedAt >= MAX_SYNC_WALL_MS)
      ) {
        return { processed, morePending: true };
      }
      const messageId = pending.messageIds[pending.index] as string;
      try {
        await lease.renew();
        if (
          (await processMessage(
            deps,
            agent.agentId,
            botEmail,
            contactTrustByEmail,
            messageId,
            lease,
            observationFence,
          )) === 'triaged'
        ) {
          processed += 1;
        }
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        // Deleted between list and fetch: this id is durably consumed too.
      }
      pending.index += 1;
      handled += 1;
      await saveCursor();
    }

    const nextPageToken = pending.nextPageToken;
    cursor.pageToken = nextPageToken;
    cursor.pending = undefined;
    if (nextPageToken) {
      await saveCursor();
      continue;
    }

    await sync.completeDrain(botEmail, BigInt(cursor.targetHistoryId), lease);
    return { processed, morePending: directRecovery.morePending };
  }
}

/**
 * Cross-instance guard. The in-process coordinator handles concurrent routes
 * on one Cloud Run instance; this session advisory lock prevents two scaled
 * instances from both paying to classify the same not-yet-persisted message.
 */
export async function syncMailboxWithDistributedLock(
  deps: EmailSyncDeps,
): Promise<MailboxSyncResult> {
  if (!gmailSyncEnabled(deps.config)) return { processed: 0 };
  const held = await syncStore(deps).withLock((lease) => syncMailboxOnce(deps, lease));
  // Another instance is already draining the same durable cursor. That is
  // expected single-flight behavior, not a failed Scheduler execution; the
  // next push or minute tick will pick up anything still pending.
  return held ? held.value : { processed: 0, morePending: true };
}

/** Renew users.watch (Gmail push). Requires GMAIL_PUBSUB_TOPIC; expires in 7 days. */
export async function renewWatch(deps: EmailSyncDeps, topicName: string): Promise<Date> {
  await assertGmailSyncEnabled(deps);
  const res = await gmailSyncApi<{ historyId: string; expiration: string }>(
    deps,
    `${GMAIL}/watch`,
    {
      method: 'POST',
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
    },
  );
  const expiration = new Date(Number(res.expiration));
  const sync = syncStore(deps);
  await sync.setWatchExpiration((await sync.mailbox()).email, expiration);
  return expiration;
}
