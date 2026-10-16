/*
 * Owner-facing wording for approval requests. Every escalated tool call needs
 * a plain-language summary; tools may provide their own `approvalSummary`, and
 * these fallbacks cover the rest so the approval (and the 160-char SMS built
 * from it) always says what is actually being approved.
 */

function quoted(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? `“${text.slice(0, 120)}”` : fallback;
}

/** Human fallback for tools that are normally autonomous but were escalated. */
export function approvalFallbackSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'gmail.search':
      return `Search the assistant’s inbox for ${quoted(args.query, 'matching messages')}`;
    case 'gmail.read_thread':
      return 'Read the selected email conversation';
    case 'gmail.create_draft':
      return `Create an email draft to ${Array.isArray(args.to) ? args.to.join(', ') : 'the selected recipient'}`;
    case 'calendar.availability':
      return 'Check calendar availability for the requested time';
    case 'calendar.list_events':
      return 'Review events on the assistant’s calendar';
    case 'docs.create':
      return `Create the Google Doc ${quoted(args.title, '')}`.trim();
    case 'docs.append':
      return 'Add content to the selected Google Doc';
    case 'docs.replace_text':
      return 'Replace text in the selected Google Doc';
    case 'docs.get':
      return 'Read the selected Google Doc';
    case 'sheets.create':
      return `Create the Google Sheet ${quoted(args.title, '')}`.trim();
    case 'sheets.append_rows':
    case 'sheets.write_rows':
      return 'Update the selected Google Sheet';
    case 'sheets.get_rows':
      return 'Read rows from the selected Google Sheet';
    case 'slides.create':
      return `Create the presentation ${quoted(args.title, '')}`.trim();
    case 'slides.append':
      return 'Add slides to the selected presentation';
    case 'workspace.write':
      return `Save ${quoted(args.path, 'a file')} in the assistant’s workspace`;
    case 'workspace.read':
      return `Read ${quoted(args.path, 'a workspace file')}`;
    case 'workspace.list':
      return `List files in ${quoted(args.path, 'the assistant’s workspace')}`;
    case 'goals.list':
      return 'Review your current goals';
    case 'goals.update_progress':
      return 'Update progress on the current goal';
    case 'memory.save':
      return 'Remember this information for future conversations';
    case 'memory.recall':
      return `Recall saved information about ${quoted(args.query, 'this topic')}`;
    case 'conversations.search':
      return `Search earlier conversations for ${quoted(args.query, 'this topic')}`;
    case 'conversations.context':
      return 'Read the surrounding messages in your earlier conversation';
    case 'web.fetch':
      return `Open ${quoted(args.url, 'the requested public webpage')}`;
    case 'improvement.report':
      return 'Log this as an improvement task';
    case 'owner.notify':
      return 'Send you an assistant update';
    case 'task.schedule':
      return 'Schedule the requested follow-up work';
    case 'contacts.lookup':
      return `Look up ${quoted(args.name, 'a saved contact')}`;
    case 'documents.search':
      return `Search your filed documents for ${quoted(args.query, 'this topic')}`;
    case 'occasions.save':
      return 'Save an occasion (birthday/anniversary) for a contact';
    case 'occasions.list':
      return 'List upcoming occasions';
    case 'goals.create':
      return `Create the goal ${quoted(args.title, '')}`.trim();
    case 'mission.update':
      return 'Update this mission’s progress';
    case 'drive.search':
      return `Search your Google Drive for ${quoted(args.query, 'matching files')}`;
    case 'drive.read':
    case 'drive.download':
      return 'Read the selected Google Drive file';
    case 'drive.ingest':
      return 'File a Google Drive document into your searchable library';
    case 'watch.create':
      return 'Set up an inbox watch for a matching message';
    case 'watch.cancel':
      return 'Cancel the selected inbox watch';
    case 'watch.list':
      return 'List your active inbox watches';
    case 'applications.apply_confirmation':
    case 'applications.append_confirmation_doc':
    case 'applications.cancel_confirmation':
    case 'applications.list_confirmations':
    case 'applications.watch_confirmation':
      return 'Act on a job-application confirmation';
    default:
      return unmappedToolSummary(toolName);
  }
}

/**
 * Fallback wording for a tool with no hand-written summary. Splicing the raw
 * name into "Allow the assistant to …" produced non-sentences ("Allow the
 * assistant to calendar test create") because tool names are namespace-first,
 * not verb-first. Naming the tool plainly is both grammatical and more honest
 * about the fact that this action has no vetted description.
 */
function unmappedToolSummary(toolName: string): string {
  const [namespace, ...rest] = toolName.split('.');
  const action = rest.join(' ').replaceAll('_', ' ').trim();
  if (!namespace) return 'Run an assistant action';
  return action
    ? `Use the ${namespace} tool (${action})`
    : `Use the ${namespace.replaceAll('_', ' ')} tool`;
}
