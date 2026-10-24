import { approvalCallBrief } from '@assistant/application/approval-rule';
import { parsePhoneCallToOwnerNumberGrantMatch } from '@assistant/persistence';
// Shared between the full settings page and the collapsed-rail settings
// popover, so the two surfaces never drift into describing the same
// schedule/policy differently.

export const scheduleLabels: Record<string, string> = {
  'morning-brief': 'Morning brief',
  'daily-briefing': 'Daily briefing',
  'tomorrow-check': 'Evening look at tomorrow',
  pulse: 'During-the-day pulse',
  'memory-extraction': 'Remember useful details from today',
  'open-loop-sweep': 'Retire open loops nobody is working on',
  'memory-consolidation': 'Organize saved memory',
  'chat-segmentation': 'Organize conversation history',
};

export const policyLabels: Record<string, string> = {
  'mcp.call.named_tool': 'Always allow a connected tool',
  'calendar.owner_attendee_only': 'Create calendar invitations for you',
  'calendar.self_only_events': 'Create private events on the assistant calendar',
  'gmail.send.to_recipient': 'Send email without attachments to an approved recipient',
  'sms.send.to_recipient': 'Send texts to an approved number',
  'calendar.create_event.same_attendees': 'Create events with approved guests',
  'calendar.update_event.same_event': 'Edit an approved calendar event',
  'gmail.send.to_recipients': 'Send email to an approved recipient group',
  'gmail.modify.archive': 'Archive mail',
  'calendar.respond_to_event.response': 'Respond to calendar invitations',
  'calendar.update_event.with_guests': 'Edit an event and invite approved guests',
  'docs.share.to_recipient': 'Share Google Docs with an approved recipient',
  'phone.call.to_owner_number.v1': 'Future calls to an approved number',
  'phone.call.same_brief': 'Repeat an approved phone call',
  'sms.reply_to_owner': 'Reply to your text messages',
};

export function policyScope(templateKey: string, match: unknown): string | null {
  const values =
    match && typeof match === 'object' && !Array.isArray(match)
      ? (match as Record<string, unknown>)
      : {};
  if (templateKey === 'mcp.call.named_tool') {
    return `Tool: ${values.toolName}; connection: ${values.connectionId}; any arguments. Server, credentials, or tool-definition changes require fresh approval.`;
  }
  if (templateKey === 'gmail.send.to_recipients' && Array.isArray(values.recipients)) {
    return `Exactly these recipients, without attachments: ${values.recipients.join(', ')}`;
  }
  if (templateKey === 'gmail.modify.archive') {
    return `Any mail; archive${values.markRead === true ? ' and mark read' : values.markRead === false ? ' and mark unread' : ''}; no other label changes`;
  }
  if (templateKey === 'calendar.respond_to_event.response') {
    return `Calendar: ${values.calendarId}; response: ${values.response}; notify organizers without a comment`;
  }
  if (templateKey === 'calendar.update_event.with_guests' && Array.isArray(values.attendees)) {
    return `Event: ${values.eventId}; edits may notify existing guests and invite exactly: ${values.attendees.join(', ')}`;
  }
  if (templateKey === 'docs.share.to_recipient') {
    const access =
      values.role === 'reader' ? 'read-only' : values.role === 'commenter' ? 'comment' : 'edit';
    return `Future Google Docs; recipient: ${values.email}; access: ${access}; email a link`;
  }
  if (templateKey === 'phone.call.to_owner_number.v1') {
    const grant = parsePhoneCallToOwnerNumberGrantMatch(match);
    if (!grant) return 'Stored permission details are unavailable.';
    return `Exact number: ${grant.recipientE164}; any topic or script when you directly ask for a call; anyone may answer; personal information from available context, including saved or retrieved information, may be shared. Requested duration ceiling: ${grant.maxMinutes} minutes; expires ${grant.expiresAt} (UTC). Duration is not a precise hang-up guarantee. Expiry stops new authorization; an in-flight call may continue. Simple requests such as “Call me now” or a call to this exact number may use this permission. Requests that add a topic, script, or other instructions require approval for that call. For “me”, “my phone”, or “my number”, your configured owner number must match this permission. A name alone still needs approval. Routing to this number does not verify who answers. A paused permission requires a fresh review from a pending owner call.`;
  }
  if (templateKey === 'phone.call.same_brief') {
    const brief = exactStoredCallBrief(match);
    if (!brief) return 'Stored permission details are unavailable.';
    return `Exact approved brief: call ${brief.to}; requested duration ceiling ${brief.maxMinutes} minutes; goal: ${brief.goal}. May share: ${brief.context || 'no extra facts'}. May agree to: ${brief.mayAgreeTo || 'nothing'}. Limits: ${brief.mustNot || 'none specified'}. Voicemail: ${brief.onVoicemail}${brief.voicemailMessage ? ` (${brief.voicemailMessage})` : ''}. Language: ${brief.language}.`;
  }
  if (templateKey === 'gmail.send.to_recipient' && typeof values.recipient === 'string') {
    return `Recipient: ${values.recipient}`;
  }
  if (templateKey === 'calendar.create_event.same_attendees' && Array.isArray(values.attendees)) {
    return `Exactly these guests: ${values.attendees.filter((a): a is string => typeof a === 'string').join(', ')}`;
  }
  if (templateKey === 'calendar.update_event.same_event' && typeof values.eventId === 'string') {
    return `Event: ${values.eventId}; edits may notify existing guests, but cannot add guests`;
  }
  if (
    (templateKey === 'sms.send.to_recipient' || templateKey === 'sms.reply_to_owner') &&
    typeof values.phone === 'string'
  ) {
    return values.phone ? `Phone: ${values.phone}` : 'No owner phone is configured';
  }
  if (templateKey === 'calendar.owner_attendee_only' && Array.isArray(values.emails)) {
    const emails = values.emails.filter((email): email is string => typeof email === 'string');
    return emails.length > 0
      ? `Owner emails: ${emails.join(', ')}`
      : 'No owner email is configured';
  }
  if (templateKey === 'calendar.self_only_events') return 'Only events without guests';
  return null;
}

export function phonePermissionAvailability(
  policy: { templateKey: string; match: unknown; enabled: boolean; effect: string },
  systemEnabled: boolean,
  now: Date = new Date(),
): string | null {
  if (policy.templateKey !== 'phone.call.to_owner_number.v1') return null;
  const grant = parsePhoneCallToOwnerNumberGrantMatch(policy.match);
  if (!grant)
    return 'Stored permission details are unavailable. Refresh or remove this saved entry.';
  if (policy.effect !== 'allow') return 'This saved entry is not an allow permission.';
  if (!policy.enabled)
    return 'Paused. A fresh review creates a new permission; this entry remains paused.';
  if (Date.parse(grant.expiresAt) <= now.getTime())
    return 'Expired. A fresh review is required for new authorization.';
  if (!systemEnabled)
    return 'Saved, but future owner-number calls are currently disabled by the system.';
  return 'Available for a matching direct request from you, subject to its expiry and the current call checks.';
}

function exactStoredCallBrief(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'brief')
  )
    return null;
  return approvalCallBrief((value as { brief: unknown }).brief);
}

export function phonePermissionKind(
  templateKey: string,
  match: unknown,
): 'owner_number' | 'same_brief' | 'opaque' {
  if (
    templateKey === 'phone.call.to_owner_number.v1' &&
    parsePhoneCallToOwnerNumberGrantMatch(match)
  )
    return 'owner_number';
  if (templateKey === 'phone.call.same_brief' && exactStoredCallBrief(match)) return 'same_brief';
  return 'opaque';
}

export function phonePermissionLabel(templateKey: string, match: unknown): string {
  const kind = phonePermissionKind(templateKey, match);
  return kind === 'owner_number'
    ? 'Future calls to an approved number'
    : kind === 'same_brief'
      ? 'Repeat an exact approved phone-call brief'
      : 'Stored phone permission';
}

export function phonePermissionOpaqueDetails(templateKey: string, match: unknown): string | null {
  if (phonePermissionKind(templateKey, match) !== 'opaque') return null;
  try {
    return JSON.stringify(match, null, 2) ?? 'Stored details unavailable.';
  } catch {
    return 'Stored details unavailable.';
  }
}
