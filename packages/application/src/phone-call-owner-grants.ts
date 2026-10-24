import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { CallBriefSchema, decryptStoredCredential, encryptStoredCredential } from '@assistant/core';
import { resolveApproval } from '@assistant/core/workflow/approvals';
import type {
  OwnerCallNumberGrantReview,
  PhoneCallToOwnerNumberGrantMatch,
} from '@assistant/persistence';
import {
  parsePhoneCallToOwnerNumberGrantMatch,
  phoneCallOwnerNumberReviewSourceFingerprint,
} from '@assistant/persistence';
import { z } from 'zod';
import { type ApprovalDecisionStore, ownerApprovalRepository } from './approvals.js';

export const OWNER_CALL_GRANT_ACKNOWLEDGEMENT = 'any_direct_owner_topic_any_answerer_v1';
export const OWNER_CALL_GRANT_VALIDITY_DAYS = [1, 7, 30] as const;
export const OWNER_CALL_GRANT_DEFAULT_VALIDITY_DAYS = 7;
const REVIEW_TTL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const PURPOSE = 'phone.call.to_owner_number.review.v1';

const ReviewTokenSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal(PURPOSE),
    ownerId: z.string().min(1),
    approvalId: z.string().uuid(),
    taskId: z.string().uuid(),
    toolCallId: z.string().uuid(),
    taskTrust: z.literal('owner'),
    sourceArgsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    directOwnerRequest: z
      .object({
        recipientRequest: z
          .union([
            z
              .object({
                kind: z.literal('explicit_number'),
                recipientE164: z.string().regex(/^\+[1-9]\d{6,14}$/),
              })
              .strict(),
            z.object({ kind: z.literal('owner_self') }).strict(),
          ])
          .nullable(),
        agentId: z.string().min(1),
        taskId: z.string().min(1),
        conversationId: z.string().min(1),
        ownerMessageId: z.string().min(1),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
        clientOperationId: z.string().uuid(),
        taskTriggerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        ownerMessageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    issuedAt: z.iso.datetime(),
    reviewExpiresAt: z.iso.datetime(),
    validityDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    grant: z
      .object({
        schemaVersion: z.literal(1),
        grantId: z.string().uuid(),
        recipientE164: z.string().regex(/^\+[1-9]\d{6,14}$/),
        maxMinutes: z.number().int().positive(),
        expiresAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();

type ReviewToken = z.infer<typeof ReviewTokenSchema>;

type Store = ApprovalDecisionStore;

function validTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    return 'UTC';
  }
}

function currentBrief(review: OwnerCallNumberGrantReview) {
  const args = review.toolCall.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const parsed = CallBriefSchema.safeParse((args as { brief?: unknown }).brief);
  return parsed.success ? parsed.data : null;
}

function fingerprintReview(review: OwnerCallNumberGrantReview): string | null {
  const toolFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(review.toolCall.args);
  const approvalFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(review.approval.payload);
  return toolFingerprint && toolFingerprint === approvalFingerprint ? toolFingerprint : null;
}

function checkIssuedToken(value: unknown, now = Date.now()): ReviewToken | null {
  const parsed = ReviewTokenSchema.safeParse(value);
  if (!parsed.success) return null;
  const token = parsed.data;
  const issued = Date.parse(token.issuedAt);
  const reviewExpires = Date.parse(token.reviewExpiresAt);
  const grantExpires = Date.parse(token.grant.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(reviewExpires) ||
    !Number.isFinite(grantExpires) ||
    reviewExpires !== issued + REVIEW_TTL_MS ||
    grantExpires !== issued + token.validityDays * DAY_MS ||
    reviewExpires <= now
  )
    return null;
  const strictMatch = parsePhoneCallToOwnerNumberGrantMatch(token.grant);
  return strictMatch ? token : null;
}

export type OwnerCallGrantPreviewResult =
  | {
      ok: true;
      reviewToken: string;
      approvalId: string;
      brief: ReturnType<typeof CallBriefSchema.parse>;
      grant: PhoneCallToOwnerNumberGrantMatch;
      validityDays: (typeof OWNER_CALL_GRANT_VALIDITY_DAYS)[number];
      reviewExpiresAt: string;
      ownerTimeZone: string;
      configuredMaxMinutes: number;
      existingActiveGrants: OwnerCallNumberGrantReview['existingActiveGrants'];
    }
  | { ok: false; reason: string };

/** Create an opaque, ten-minute review for exactly one still-pending call. */
export async function previewOwnerCallNumberGrant(
  store: Store,
  approvalId: string,
  validityDays: number,
): Promise<OwnerCallGrantPreviewResult> {
  if (
    !loadConfig().PHONE_CALL_TO_OWNER_GRANT_ENABLED ||
    process.env.PHONE_CALL_TO_OWNER_GRANT_ENABLED !== 'true'
  )
    return { ok: false, reason: 'Reusable owner-number calls are disabled.' };
  if (!(OWNER_CALL_GRANT_VALIDITY_DAYS as readonly number[]).includes(validityDays))
    return { ok: false, reason: 'Choose a supported permission duration and review again.' };
  try {
    const { agentId, approvals } = await ownerApprovalRepository(store);
    const review = await approvals.getOwnerCallNumberGrantReview?.(agentId, approvalId);
    if (
      review?.task.trust !== 'owner' ||
      !review.directOwnerRequest ||
      !(review.repositoryNow instanceof Date) ||
      !Number.isFinite(review.repositoryNow.getTime())
    )
      return { ok: false, reason: 'This review expired or changed. Review again.' };
    const brief = currentBrief(review);
    const sourceArgsFingerprint = fingerprintReview(review);
    if (!brief || !sourceArgsFingerprint)
      return { ok: false, reason: 'This review expired or changed. Review again.' };
    const issuedAt = review.repositoryNow;
    const grant: PhoneCallToOwnerNumberGrantMatch = {
      schemaVersion: 1,
      grantId: randomUUID(),
      recipientE164: brief.to,
      maxMinutes: brief.maxMinutes,
      expiresAt: new Date(issuedAt.getTime() + validityDays * DAY_MS).toISOString(),
    };
    const token: ReviewToken = {
      schemaVersion: 1,
      purpose: PURPOSE,
      ownerId: agentId,
      approvalId,
      taskId: review.task.id,
      toolCallId: review.toolCall.id,
      taskTrust: 'owner',
      sourceArgsFingerprint,
      directOwnerRequest: review.directOwnerRequest,
      issuedAt: issuedAt.toISOString(),
      reviewExpiresAt: new Date(issuedAt.getTime() + REVIEW_TTL_MS).toISOString(),
      validityDays: validityDays as ReviewToken['validityDays'],
      grant,
    };
    const reviewToken = encryptStoredCredential(JSON.stringify(token));
    return {
      ok: true,
      reviewToken,
      approvalId,
      brief,
      grant,
      validityDays: token.validityDays,
      reviewExpiresAt: token.reviewExpiresAt,
      ownerTimeZone: validTimeZone(review.ownerTimeZone),
      configuredMaxMinutes: loadConfig().CALL_MAX_MINUTES,
      existingActiveGrants: review.existingActiveGrants,
    };
  } catch {
    return { ok: false, reason: 'This review expired or changed. Review again.' };
  }
}

/** Finalize only the exact current approval and exact reviewed future scope. */
export async function approveOwnerCallNumberGrant(
  store: Store,
  approvalId: string,
  reviewToken: string,
  acknowledgement: string,
) {
  if (
    !loadConfig().PHONE_CALL_TO_OWNER_GRANT_ENABLED ||
    process.env.PHONE_CALL_TO_OWNER_GRANT_ENABLED !== 'true'
  )
    return { ok: false as const, reason: 'Reusable owner-number calls are disabled.' };
  if (acknowledgement !== OWNER_CALL_GRANT_ACKNOWLEDGEMENT || !reviewToken.startsWith('v2.'))
    return { ok: false as const, reason: 'This review expired or changed. Review again.' };
  let token: ReviewToken | null;
  try {
    token = checkIssuedToken(JSON.parse(decryptStoredCredential(reviewToken)));
  } catch {
    return { ok: false as const, reason: 'This review expired or changed. Review again.' };
  }
  try {
    const identity = await ownerApprovalRepository(store);
    if (!token || token.ownerId !== identity.agentId || token.approvalId !== approvalId)
      return { ok: false as const, reason: 'This review expired or changed. Review again.' };
    const grant = parsePhoneCallToOwnerNumberGrantMatch(token.grant);
    if (!grant)
      return { ok: false as const, reason: 'This review expired or changed. Review again.' };
    const result = await resolveApproval(identity.approvals, {
      approvalId,
      expectedAgentId: identity.agentId,
      decision: 'approved',
      via: 'web',
      policy: {
        agentId: identity.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.to_owner_number.v1',
        match: grant as unknown as Record<string, unknown>,
        effect: 'allow',
      },
      ownerCallNumberGrant: {
        expectedApprovalId: token.approvalId,
        expectedAgentId: token.ownerId,
        expectedTaskId: token.taskId,
        expectedToolCallId: token.toolCallId,
        sourceArgsFingerprint: token.sourceArgsFingerprint,
        directOwnerRequest: token.directOwnerRequest,
        reviewIssuedAt: token.issuedAt,
        reviewExpiresAt: token.reviewExpiresAt,
        validityDays: token.validityDays,
        match: grant,
      },
    });
    if (
      result.ok &&
      (result.ownerCallNumberGrant?.grantId !== grant.grantId ||
        result.ownerCallNumberGrant.expiresAt !== grant.expiresAt)
    )
      return {
        ok: false as const,
        reason:
          'Could not confirm result. Refresh to check this call and saved permission before trying again.',
      };
    return result.ok
      ? result
      : { ok: false as const, reason: 'This review expired or changed. Review again.' };
  } catch {
    return {
      ok: false as const,
      reason:
        'Could not confirm result. Refresh to check this call and saved permission before trying again.',
    };
  }
}
