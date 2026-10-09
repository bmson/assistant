import {
  cardShapeSignals,
  type GeneratedCardPayload,
  type GenerativeCardSpecV1,
  GenerativeCardSpecV1Schema,
  generateEvidenceCard,
  generateEvidenceCardOutcome,
  persistGeneratedCard,
} from '@assistant/core/generative-card';
import type { ModelRouter } from '@assistant/core/model-router';
import type { ActionEvidence } from '@assistant/core/workflow/response-contract';
import type {
  EmailObserverClaim,
  EmailObserverSource,
  GeneratedCardRepository,
  NotificationsConversationRepository,
} from '@assistant/persistence';
import { notificationDeliveryKey } from '@assistant/persistence';
import { z } from 'zod';
import type { InboundEmailEvent, OwnerNotifier } from '../platform.js';

/**
 * The things in the owner's mail worth going back to — a hotel reservation,
 * concert tickets, a table booking, a delivery on its way, an appointment —
 * saved to the Cards page as they arrive, without being asked.
 *
 * The card is the same one the owner would get by asking: the composer lays
 * it out, and every value on it is checked word for word against the email
 * (core/generative-card.ts). What mail cannot do is decide that a card is
 * worth a model call: a prefilter reads the message first, and newsletters,
 * sales and anything without the shape of a booking never reach a model.
 * A flight booking is one more booking: its card is the confirmation as the
 * airline wrote it, not a live status.
 *
 * Mail is untrusted, so a card built from it carries no links and no images:
 * a phishing message dressed as a booking must not get a tappable "Manage
 * booking" button in the assistant's own UI. The owner still has the email.
 */

export interface EmailCardDeps {
  router: ModelRouter;
  generatedCards: GeneratedCardRepository;
  notifications: NotificationsConversationRepository;
  notifyOwner: OwnerNotifier['notifyOwner'];
}

/** Words a booking, a ticket or a delivery says about itself. */
const CARD_WORTHY =
  /\b(?:reservation|reserved|booking|booked|confirmation|confirmed|itinerary|tickets?|e-?tickets?|admission|check-?in|appointment|your order|order (?:#|number|no\.?)|shipped|out for delivery|delivery (?:date|window)|tracking (?:number|#)|rsvp|you're going|see you (?:on|at))\b/i;
/** What a sale says about itself. A booking footer's "unsubscribe" is not one. */
const MARKETING =
  /\b(?:\d{1,2}% off|sale ends|limited[- ]time|promo(?:tion(?:al)?)? code|flash sale|shop now|don't miss out|exclusive offer|last chance)\b/i;

/** "Confirmation number: 7353…" — a line a form printed, not a person wrote. */
const LABELLED_LINE = /(?:^|\n)[ \t]*[A-Z][\w #.'/-]{1,30}:[ \t]*\S/g;

export function mayBeCardWorthy(subject: string, body: string): boolean {
  const head = body.slice(0, 3000);
  if (MARKETING.test(`${subject}\n${head}`)) return false;
  // Booking mail says what it is in its subject ("Your reservation is
  // confirmed", "Your tickets"), or prints its details as labelled fields. A
  // friend's "the usual place is booked" does neither.
  const labelled = (head.match(LABELLED_LINE) ?? []).length >= 2;
  if (!CARD_WORTHY.test(subject) && !(labelled && CARD_WORTHY.test(head))) return false;
  // A date, a time, an amount or a column of labelled fields — at least two —
  // or it is a message about a booking rather than the booking itself. Mail
  // can be terse ("Section B, Row 12 · Sat, Nov 14 · 7:00 PM"), so unlike a
  // chat reply it needs no minimum length beyond a sentence.
  const text = body.slice(0, 6000).trim();
  return text.length >= 60 && cardShapeSignals(text) >= 2;
}

/** No links, no images: what an untrusted sender must not put in our UI. */
export function withoutSenderLinks(spec: GenerativeCardSpecV1): GenerativeCardSpecV1 | null {
  const blocks = spec.blocks.flatMap((block): GenerativeCardSpecV1['blocks'] => {
    if (block.type === 'image') return [];
    if (block.type !== 'section') return [block];
    const children = block.blocks.filter((child) => child.type !== 'image');
    return children.length ? [{ ...block, blocks: children }] : [];
  });
  if (!blocks.length) return null;
  return { ...spec, blocks, actions: spec.actions.filter((action) => action.type !== 'open_url') };
}

const PreparedEmailCardSchema = z.object({
  kind: z.literal('generated-card'),
  id: z.string().uuid(),
  revisionId: z.string().uuid(),
  spec: GenerativeCardSpecV1Schema,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  grounding: z.enum(['evidence', 'answer', 'message']),
});

export type EmailCardPreparation =
  | { kind: 'prepared'; result: unknown }
  | { kind: 'no_op' }
  | { kind: 'budget_blocked'; mode: 'park' | 'block' }
  | { kind: 'unknown'; errorCode: string };

function sourceEvent(source: EmailObserverSource): InboundEmailEvent {
  return {
    agentId: source.agentId,
    messageId: source.messageId ?? source.sourceId.replace(/^gmail:/, ''),
    from: source.from,
    subject: source.subject,
    body: source.body,
    authenticated: source.authenticated,
  };
}

function cardEvidence(source: EmailObserverSource): ActionEvidence[] {
  return [
    {
      toolName: 'email.inbound',
      status: 'succeeded',
      args: { messageId: source.messageId ?? source.sourceId },
      result: { from: source.from, subject: source.subject, text: source.body.slice(0, 12_000) },
    } as ActionEvidence,
  ];
}

export async function prepareEmailCard(
  deps: Pick<EmailCardDeps, 'router'>,
  source: EmailObserverSource,
): Promise<EmailCardPreparation> {
  if (!mayBeCardWorthy(source.subject, source.body)) return { kind: 'no_op' };
  const composed = await generateEvidenceCardOutcome({
    router: deps.router,
    sourceText: `An email the owner received from ${source.from}: ${source.subject}`,
    evidence: cardEvidence(source),
    sourceKey: source.sourceId,
  });
  // Keep an ambiguous model/provider outcome explicit so the durable runner
  // can retain the paid-attempt fence instead of treating it as a no-op.
  if (composed.kind === 'unknown')
    return { kind: 'unknown', errorCode: 'email_card_effect_unknown' };
  if (composed.kind !== 'card') return composed;
  const spec = withoutSenderLinks(composed.payload.spec);
  if (!spec) return { kind: 'no_op' };
  const verifiedSpec =
    source.sourceVerification === 'forwarded_unverified'
      ? {
          ...spec,
          sourceLabel: 'Forwarded email (unverified)',
          facts: spec.facts.map((fact) => ({ ...fact, source: 'Forwarded email (unverified)' })),
        }
      : spec;
  return { kind: 'prepared', result: { ...composed.payload, spec: verifiedSpec } };
}

export async function applyPreparedEmailCard(
  deps: EmailCardDeps,
  source: EmailObserverSource,
  claim: EmailObserverClaim,
  preparedResult: unknown,
): Promise<'complete' | 'no_op' | 'unknown'> {
  const parsed = PreparedEmailCardSchema.safeParse(preparedResult);
  if (!parsed.success) return 'unknown';
  const composed = parsed.data as GeneratedCardPayload;
  const spec = withoutSenderLinks(composed.spec as GenerativeCardSpecV1);
  if (!spec) return 'no_op';
  const evidence = cardEvidence(source);
  const effectFence = {
    id: claim.id,
    agentId: claim.agentId,
    claimToken: claim.claimToken,
    claimGeneration: claim.claimGeneration,
    expectedPrivacyGeneration: claim.privacyGeneration,
  };
  const conversationId = await deps.notifications.getOrCreate(source.agentId, effectFence);
  const saved = await persistGeneratedCard(deps.generatedCards, {
    agentId: source.agentId,
    conversationId,
    payload: { ...composed, spec },
    evidence,
    sourceText: `Email: ${source.subject}`.slice(0, 2000),
    emailObserverEffectFence: effectFence,
  });
  if (saved.id === composed.id) {
    const deliveryKey = notificationDeliveryKey(
      'email-observer',
      source.agentId,
      source.sourceId,
      'google.email-card',
      '1',
    );
    const delivery = await deps.notifyOwner({
      text: `Saved “${saved.spec.title}” from your email to your Cards page.`,
      urgency: 'ambient',
      deliveryKey,
      emailObserverEffectFence: effectFence,
    });
    if (!delivery) return 'unknown';
    const statuses = delivery.legs.map((leg) => leg.status);
    if (statuses.some((status) => status === 'unknown' || status === 'failed')) return 'unknown';
  }
  return 'complete';
}

export async function cardFromEmail(
  deps: EmailCardDeps,
  event: InboundEmailEvent,
): Promise<GeneratedCardPayload | null> {
  if (!mayBeCardWorthy(event.subject, event.body)) return null;
  const evidence: ActionEvidence[] = [
    {
      toolName: 'email.inbound',
      status: 'succeeded',
      args: { messageId: event.messageId },
      result: {
        from: event.from,
        subject: event.subject,
        text: event.body.slice(0, 12_000),
      },
    } as ActionEvidence,
  ];
  const composed = await generateEvidenceCard({
    router: deps.router,
    sourceText: `An email the owner received from ${event.from}: ${event.subject}`,
    evidence,
    // The same booking's reminder a week later revises this card, through
    // the booking reference the composer finds, rather than adding another.
    sourceKey: `gmail:${event.messageId}`,
  });
  if (!composed) return null;
  const spec = withoutSenderLinks(composed.spec);
  if (!spec) return null;
  const conversationId = await deps.notifications.getOrCreate(event.agentId);
  const saved = await persistGeneratedCard(deps.generatedCards, {
    agentId: event.agentId,
    conversationId,
    payload: { ...composed, spec },
    evidence,
    sourceText: `Email: ${event.subject}`.slice(0, 2000),
  });
  // A new object gets one ambient notice; a revision of one already on the
  // Cards page (the same reservation, mailed again) updates it quietly.
  if (saved.id === composed.id)
    await deps.notifyOwner({
      text: `Saved “${saved.spec.title}” from your email to your Cards page.`,
      urgency: 'ambient',
    });
  return saved;
}
