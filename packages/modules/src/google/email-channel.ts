import { outboundEmailAllowed } from '@assistant/config';
import { appendSignature, isForwardedIngest } from '@assistant/core';
import {
  type EmailSyncRepository,
  type FinalChannelDeliveryResult,
  finalChannelDelivery,
  type Records,
  type VoiceContextRepository,
} from '@assistant/persistence';
import {
  buildRawEmail,
  type GmailPayload,
  gmailHeader,
  isAmbiguousGoogleMutationError,
  markdownToEmailHtml,
  markdownToPlainText,
} from '@assistant/tools';
import type { GoogleClient } from '@assistant/tools/modules/google';

type TaskRow = Records['tasks'];

/** What email delivery consumes: the mail state, the owner's voice, and the module's client. */
export interface EmailChannelDeps {
  persistence: { emailSync: EmailSyncRepository; voiceContext: VoiceContextRepository };
  googleClient: GoogleClient;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface EmailThreadTarget {
  threadId: string;
  to: string;
  subject: string;
  rfcMessageId: string;
}

/**
 * Resolve where an owner-trust task's final email reply should go. For an
 * email_triage task the thread/sender live on its own trigger payload. For a
 * follow-up task on the same email conversation (an adhoc/scheduled continuation)
 * they are recovered from the conversation's channel binding (threadId) and its
 * earliest email_triage task (the authenticated original sender) — so
 * email-originated follow-up work returns to the thread the owner started rather
 * than only the dashboard.
 */
async function resolveEmailThreadTarget(
  deps: EmailChannelDeps,
  task: TaskRow,
): Promise<EmailThreadTarget | null> {
  const ownPayload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const asStr = (v: unknown) => (typeof v === 'string' ? v : '');
  // Forwarded ingest runs at owner trust but its `from` is a third party, so
  // there is no address here that may be auto-replied to at all.
  if (isForwardedIngest(task)) return null;
  if (task.type === 'email_triage') {
    const threadId = asStr(ownPayload.threadId);
    const to = asStr(ownPayload.from);
    if (!threadId || !to) return null;
    return {
      threadId,
      to,
      subject: asStr(ownPayload.subject),
      rfcMessageId: asStr(ownPayload.rfcMessageId),
    };
  }
  if (!task.conversationId) return null;
  const thread = await deps.persistence.emailSync.replyThread(task.conversationId);
  if (!thread?.threadId) return null;
  // Resolve the recipient from the earliest OWNER-TRUST email_triage task only.
  // A conversation is bound to a Gmail threadId regardless of trust
  // (conversationForThread), so an authenticated stranger can seed the first
  // email_triage task on a thread the owner later joins. Without this filter a
  // follow-up owner task (a scheduled continuation, a mission session) would
  // email its final answer — and its parked-approval notices, with short codes
  // — to that stranger. No owner-trust origin means no auto-reply target: the
  // answer still lands on the dashboard via postConversationNotice.
  const origin = thread.ownerOriginTrigger ? { trigger: thread.ownerOriginTrigger } : undefined;
  // An ingest task is owner-trust with a third-party `from`, so it must never
  // become the reply target for a later follow-up on the same thread either.
  if (isForwardedIngest(origin)) return null;
  const originPayload =
    (origin?.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const to = asStr(originPayload.from);
  if (!to) return null;
  return {
    threadId: thread.threadId,
    to,
    subject: asStr(originPayload.subject),
    rfcMessageId: asStr(originPayload.rfcMessageId),
  };
}

/**
 * Is this address one the owner actually owns?
 *
 * Read from the contacts table rather than a config value so an owner with
 * several addresses works, and so the answer follows the same record the rest
 * of the trust system uses. `trust: 'owner'` is protected — `updateContactIdentity`
 * and `deleteContact` both refuse to touch owner rows — so this cannot be
 * widened by anything the model does.
 */
async function isOwnerAddress(deps: EmailChannelDeps, address: string): Promise<boolean> {
  const normalized = address.trim().toLowerCase();
  if (!normalized) return false;
  const contacts = await deps.persistence.emailSync.contactTrust();
  return contacts.some((row) => row.trust === 'owner' && row.email.trim() === normalized);
}

/**
 * Executor hook: a finished email_triage task's final text goes back as an
 * email reply on the SAME Gmail thread — a request that arrives by email is
 * answered by email, not just mirrored into the dashboard.
 *
 * Owner mail only: the auto-reply recipient is exactly the owner address that
 * triggered the task (the email twin of the sms.reply_to_owner policy).
 * Mail from anyone else never auto-sends — the triage model must go through
 * gmail.create_draft / gmail.send and their approval gates.
 */
export async function deliverEmailFinal(
  deps: EmailChannelDeps,
  task: TaskRow,
  text: string,
  attemptId = `email-final:${task.id}`,
): Promise<FinalChannelDeliveryResult> {
  if (task.trust !== 'owner')
    return finalChannelDelivery('email', 'not_applicable', attemptId, 'non-owner-task');
  if (task.type === 'chat_turn')
    return finalChannelDelivery('email', 'not_applicable', attemptId, 'dashboard-chat-turn');
  const requiredByType = task.type === 'email_triage';
  if (!task.conversationId) {
    return requiredByType
      ? finalChannelDelivery('email', 'rejected', attemptId, 'missing-conversation')
      : finalChannelDelivery('email', 'not_applicable', attemptId, 'no-conversation');
  }

  const conversation = await deps.persistence.emailSync.replyThread(task.conversationId);
  if (!requiredByType && conversation?.channel !== 'email')
    return finalChannelDelivery('email', 'not_applicable', attemptId, 'not-email-conversation');
  if (requiredByType && conversation?.channel !== 'email')
    return finalChannelDelivery('email', 'rejected', attemptId, 'email-thread-unavailable');
  if (!deps.googleClient.configured())
    return finalChannelDelivery('email', 'rejected', attemptId, 'provider-not-configured');

  const target = await resolveEmailThreadTarget(deps, task);
  if (!target) return finalChannelDelivery('email', 'rejected', attemptId, 'missing-owner-target');

  // Positive confirmation that the auto-reply recipient really is the owner.
  //
  // This used to be implied by `task.trust === 'owner'`, because owner trust was
  // only reachable when the OWNER was the sender. Forwarded ingest breaks that
  // equivalence — it is owner-directed mail from a third party — so the
  // invariant is now checked directly instead of inferred. Auto-sending is the
  // one path here with no approval card in front of it, so it fails closed: an
  // address that is not a known owner address is never written to.
  if (!(await isOwnerAddress(deps, target.to))) {
    console.warn(
      `email-channel: refusing to auto-reply to ${target.to} — not an owner address (task ${task.id})`,
    );
    return finalChannelDelivery('email', 'rejected', attemptId, 'recipient-not-owner');
  }
  if (!outboundEmailAllowed(target.to)) {
    console.warn(`email-channel: refusing to auto-reply to ${target.to} — outside allowed domains`);
    return finalChannelDelivery('email', 'rejected', attemptId, 'recipient-domain-not-allowed');
  }

  // RFC threading headers so the reply nests in ANY mail client (Gmail
  // threads by threadId, but Apple Mail etc. need In-Reply-To/References).
  // The RFC-822 Message-ID is captured at ingest (payload.rfcMessageId); the
  // per-send metadata fetch is only a fallback for tasks enqueued before that.
  const ownPayload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const messageId = typeof ownPayload.messageId === 'string' ? ownPayload.messageId : '';
  let inReplyTo = target.rfcMessageId;
  if (!inReplyTo && messageId) {
    const original = await deps.googleClient
      .api<{ payload?: GmailPayload }>(
        `${GMAIL}/messages/${messageId}?format=metadata&metadataHeaders=Message-ID`,
      )
      .catch(() => null);
    inReplyTo = original ? gmailHeader(original.payload, 'Message-ID') : '';
  }

  const [agent, profile] = await Promise.all([
    deps.persistence.emailSync.mailbox(),
    deps.persistence.voiceContext.profile(),
  ]);
  // The final answer is the model's Markdown — render it to HTML (with a
  // plain-text fallback) and sign it, so an emailed reply reads as rich text
  // rather than raw asterisks.
  const signed = appendSignature(text, profile?.signature ?? '');
  const raw = buildRawEmail({
    // explicit display name — otherwise recipients see the Google account's
    // profile name, which nothing in this stack controls
    from: `"${agent.name}" <${agent.email}>`,
    to: [target.to],
    subject: /^re:/i.test(target.subject)
      ? target.subject
      : `Re: ${target.subject || '(no subject)'}`,
    body: markdownToPlainText(signed),
    html: markdownToEmailHtml(signed),
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  try {
    await deps.googleClient.api(`${GMAIL}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw, threadId: target.threadId }),
    });
  } catch (error) {
    if (isAmbiguousGoogleMutationError(error)) {
      // The request may already be in Sent. Preserve this exact attempt as
      // unknown so crash recovery never resends it automatically.
      console.error('email delivery outcome is ambiguous; suppressing duplicate retry', error);
      return finalChannelDelivery('email', 'unknown', attemptId, 'provider-outcome-unknown');
    }
    console.error('email provider rejected the final reply', error);
    return finalChannelDelivery('email', 'rejected', attemptId, 'provider-rejected');
  }
  return finalChannelDelivery('email', 'accepted', attemptId);
}
