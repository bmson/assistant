import {
  approvalCallBrief,
  approvalRule,
  noAttachments,
  normalizedApprovalAttendees,
  sameApprovalScope,
} from '@assistant/core/approval-rule';
import {
  type ApprovalPolicy as ApprovalPolicyRow,
  type ApprovalPolicyStore,
  listApprovalPolicies,
} from '@assistant/core/workflow/approval-policies';
import type { ToolContext } from './types.js';

/**
 * Policy templates — the ONLY shapes an "Always allow / Never allow" rule can
 * take. Each template is code that interprets a policy row's `match` params
 * against concrete tool args. Free-form predicates are not representable by
 * construction.
 */
export type PolicyTemplate = (
  match: Record<string, unknown>,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => boolean;

/** New rules use the same derivation as the UI, so offered and enforced scopes agree. */
function scopedRule(toolName: string, templateKey: string): PolicyTemplate {
  return (match, args, ctx) => {
    if (ctx.trust !== 'owner') return false;
    const rule = approvalRule(toolName, args);
    return rule?.templateKey === templateKey && sameApprovalScope(match, rule.match);
  };
}

export const policyTemplates: Record<string, PolicyTemplate> = {
  'mcp.call.named_tool': scopedRule('mcp.call', 'mcp.call.named_tool'),
  'gmail.send.to_recipients': scopedRule('gmail.send', 'gmail.send.to_recipients'),
  'gmail.modify.archive': scopedRule('gmail.modify', 'gmail.modify.archive'),
  'calendar.respond_to_event.response': scopedRule(
    'calendar.respond_to_event',
    'calendar.respond_to_event.response',
  ),
  'calendar.update_event.with_guests': scopedRule(
    'calendar.update_event',
    'calendar.update_event.with_guests',
  ),
  'docs.share.to_recipient': scopedRule('docs.share', 'docs.share.to_recipient'),
  'phone.call.same_brief': (match, args, ctx) => {
    const approved = approvalCallBrief(match.brief);
    const actual = approvalCallBrief(args.brief);
    if (
      ctx.trust !== 'owner' ||
      !approved ||
      !actual ||
      Number(actual.maxMinutes) > Number(approved.maxMinutes)
    )
      return false;
    return sameApprovalScope(approved, { ...actual, maxMinutes: approved.maxMinutes });
  },
  /** SMS replies from an owner task to the configured owner number only. */
  'sms.reply_to_owner': (match, args, ctx) => {
    const ownerPhone = String(match.phone ?? '');
    return ownerPhone.length > 0 && ctx.trust === 'owner' && args.to === ownerPhone;
  },

  /** Calendar events with no attendees — nothing leaves the assistant's world. */
  'calendar.self_only_events': (_match, args) => {
    const attendees = args.attendees as unknown[] | undefined;
    return !attendees || attendees.length === 0;
  },

  /**
   * Calendar events whose ONLY attendees are the owner's own addresses
   * (match.emails, set at seed time). Inviting the owner to something they
   * asked about is the calendar twin of replying to their SMS — the invite
   * email goes nowhere but to them.
   */
  'calendar.owner_attendee_only': (match, args) => {
    const allowed = (Array.isArray(match.emails) ? match.emails : []).map((e) =>
      String(e).toLowerCase(),
    );
    const attendees = (Array.isArray(args.attendees) ? args.attendees : []).map((a) =>
      String(a).toLowerCase(),
    );
    return (
      allowed.length > 0 && attendees.length > 0 && attendees.every((a) => allowed.includes(a))
    );
  },

  'sms.send.to_recipient': (match, args, ctx) =>
    ctx.trust === 'owner' &&
    typeof match.phone === 'string' &&
    /^\+\d{7,15}$/.test(match.phone) &&
    args.to === match.phone,

  'calendar.create_event.same_attendees': (match, args, ctx) => {
    const allowed = normalizedApprovalAttendees(match.attendees);
    const actual = normalizedApprovalAttendees(args.attendees);
    return (
      ctx.trust === 'owner' &&
      !!allowed?.length &&
      actual !== null &&
      allowed.length === actual.length &&
      allowed.every((email, index) => email === actual[index])
    );
  },

  'calendar.update_event.same_event': (match, args, ctx) => {
    const added = normalizedApprovalAttendees(args.addAttendees);
    return (
      ctx.trust === 'owner' &&
      typeof match.eventId === 'string' &&
      match.eventId.length >= 3 &&
      args.eventId === match.eventId &&
      added !== null &&
      added.length === 0
    );
  },

  /** Email without attachments to a specific, owner-approved recipient. */
  'gmail.send.to_recipient': (match, args, ctx) => {
    if (ctx.trust !== 'owner' || !noAttachments(args)) return false;
    const allowed = String(match.recipient ?? '').toLowerCase();
    if (!allowed) return false;
    const to = args.to;
    const recipients = (Array.isArray(to) ? to : [to]).map((r) => String(r).trim().toLowerCase());
    return recipients.length > 0 && recipients.every((r) => r === allowed);
  },
};

export interface PolicyMatch {
  policy: ApprovalPolicyRow;
  effect: 'allow' | 'deny';
}

export function matchPolicyRows(
  rows: readonly ApprovalPolicyRow[],
  input: {
    agentId: string;
    toolName: string;
    args: Record<string, unknown>;
    ctx: ToolContext;
  },
): PolicyMatch | null {
  const evaluate = (row: ApprovalPolicyRow): boolean => {
    if (!row.enabled || row.agentId !== input.agentId || row.toolName !== input.toolName)
      return false;
    const template = policyTemplates[row.templateKey];
    if (!template) return false; // unknown template = never matches (fails closed)
    return template((row.match ?? {}) as Record<string, unknown>, input.args, input.ctx);
  };

  for (const row of rows.filter((r) => r.effect === 'deny')) {
    if (evaluate(row)) return { policy: row, effect: 'deny' };
  }
  for (const row of rows.filter((r) => r.effect === 'allow')) {
    if (evaluate(row)) return { policy: row, effect: 'allow' };
  }
  return null;
}

/** First matching enabled policy wins; deny templates are checked before allows. */
export async function matchPolicies(
  store: ApprovalPolicyStore,
  input: {
    agentId: string;
    toolName: string;
    args: Record<string, unknown>;
    ctx: ToolContext;
  },
): Promise<PolicyMatch | null> {
  const rows = await listApprovalPolicies(store, input.agentId, {
    toolName: input.toolName,
    enabledOnly: true,
  });
  return matchPolicyRows(rows, input);
}
