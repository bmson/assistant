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
  'phone.call.same_brief': 'Repeat approved call',
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
  if (templateKey === 'phone.call.same_brief' && values.brief && typeof values.brief === 'object') {
    const brief = values.brief as Record<string, unknown>;
    return `Call ${brief.to}, up to ${brief.maxMinutes} minutes: ${brief.goal}. May share: ${brief.context || 'no extra facts'}. May agree to: ${brief.mayAgreeTo || 'nothing'}. Limits: ${brief.mustNot || 'none specified'}. Voicemail: ${brief.onVoicemail}${brief.voicemailMessage ? ` (${brief.voicemailMessage})` : ''}. Language: ${brief.language}.`;
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
