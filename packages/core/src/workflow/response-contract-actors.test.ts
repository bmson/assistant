import { describe, expect, it } from 'vitest';
import { type ActionEvidence, enforceResponseContract } from './response-contract.js';

describe('actor-aware response action claims', () => {
  const readEvidence: ActionEvidence[] = [
    {
      toolName: 'gmail.search',
      status: 'succeeded',
      result: { results: [{ threadId: 'project-update' }], complete: true },
    },
  ];

  it.each([
    'The client has been contacted by Mira.',
    'The client has been contacted by the project manager.',
    'The client has been contacted by Mira and Nora.',
    'They have been notified by her.',
    'Mira checked the calendar and sent the email.',
    'Mira reviewed the schedule, then sent the client a message.',
    'They reviewed the schedule and sent the client a message.',
    'Mira created the document and scheduled the meeting.',
    'Mira checked the calendar, Nora reviewed the agenda and sent the email.',
    'Mira checked the calendar, reviewed the agenda and sent the email.',
    'Mira and Nora checked the calendar and sent the email.',
    'Her document is ready.',
    'Her document that Mira updated is ready.',
    'Her document is ready, updated by Mira.',
    'Her document is ready, updated by Mira for Bob and shared by Nora.',
    'Her document is ready, updated by Mira and shared by Nora.',
    'Mira’s spreadsheet is ready.',
    'Their presentation is ready.',
  ])('preserves source activity instead of inventing an assistant failure: %s', (text) => {
    expect(
      enforceResponseContract(text, readEvidence, { requestText: 'Summarize the project update.' }),
    ).toMatchObject({ text, blocked: false, unsupported: [] });
  });

  it.each([
    ['The client has been contacted.', 'outbound'],
    ['The client has been contacted by me.', 'outbound'],
    ['The client has been contacted by us.', 'outbound'],
    ['The client has been contacted by the assistant.', 'outbound'],
    ['The client has been contacted by your assistant.', 'outbound'],
    ['The client has been contacted by Mira and me.', 'outbound'],
    ['The client has been contacted by Mira and the assistant.', 'outbound'],
    ['The client has been contacted by Mira, Nora, and me.', 'outbound'],
    ['The client has been contacted by Mira with me.', 'outbound'],
    ['The email was sent by noon.', 'outbound'],
    ['The email was sent by tomorrow.', 'outbound'],
    ['The client has been contacted by October.', 'outbound'],
    ['The client has been contacted by December.', 'outbound'],
    ['The client has been contacted by Friday Afternoon.', 'outbound'],
    ['The client has been contacted by Tomorrow Morning.', 'outbound'],
    ['The client has been contacted by Mail Merge.', 'outbound'],
    ['Her document was created by me.', 'workspace'],
    ['Mira’s document was created by the assistant.', 'workspace'],
    ['Her appointment was scheduled by me.', 'calendar'],
    ['Mira’s appointment was scheduled by Mira and me.', 'calendar'],
    ['Her appointment was scheduled by this assistant.', 'calendar'],
    ['Her document was updated by me today.', 'workspace'],
    ['Her document was updated by me personally.', 'workspace'],
    ['Her document was updated by the assistant yesterday.', 'workspace'],
    ['Her document was updated by us this morning.', 'workspace'],
    ['Her appointment was scheduled by Mira and me yesterday.', 'calendar'],
    ['Her document was updated by an unresolved actor.', 'workspace'],
    ['Her document, which I updated, is ready.', 'workspace'],
    ['Her document, which I created, is ready.', 'workspace'],
    ['Her document that I updated is ready.', 'workspace'],
    ['Mira’s spreadsheet, which we updated, is ready.', 'spreadsheet'],
    ['Her document is ready after I updated it.', 'workspace'],
    ['Her document, prepared by me, is ready.', 'workspace'],
    ['Her document is ready, updated by me.', 'workspace'],
    ['Her document is ready; I updated it.', 'workspace'],
    ['Her document is ready. I updated it.', 'workspace'],
    ['Her document (prepared by me) is ready.', 'workspace'],
    ['Her document—prepared by me—is ready.', 'workspace'],
    ['Her document, prepared by myself, is ready.', 'workspace'],
    ['Her document is ready, updated by yours truly.', 'workspace'],
    ['Her document is ready, updated by Mira for Bob and shared by me.', 'workspace'],
    ['Her document is ready, updated by Mira for Bob and shared by us.', 'workspace'],
    ['Her document is ready, updated by Mira for Bob and shared by the assistant.', 'workspace'],
    ['Her document is ready, updated by Mira for Bob and shared by yours truly.', 'workspace'],
    ['The document was updated by Mira. I updated it again.', 'workspace'],
    ['Her document was updated by Mira; we shared it.', 'workspace'],
    ['Sent the email.', 'outbound'],
    ['I checked the calendar and sent the email.', 'outbound'],
    ['Mira checked the calendar, and I sent the email.', 'outbound'],
    ['Mira checked the calendar. Sent the email.', 'outbound'],
    ['Mira checked the calendar; sent the email.', 'outbound'],
    ['Mira checked the calendar. The assistant sent the email.', 'outbound'],
    ['Mira checked the calendar, Assistant reviewed the agenda and sent the email.', 'outbound'],
    ['Mira checked the calendar, the bot reviewed the agenda and sent the email.', 'outbound'],
    ['The configured bot reviewed the agenda and sent the email.', 'outbound'],
    ['The connected automation reviewed the agenda and sent the email.', 'outbound'],
    ['A trusted system reviewed the agenda and sent the email.', 'outbound'],
    ['Her configured bot reviewed the agenda and sent the email.', 'outbound'],
    ['His configured bot reviewed the agenda and sent the email.', 'outbound'],
    [
      'Mira checked the calendar, the automation reviewed the agenda and sent the email.',
      'outbound',
    ],
    ['Mira checked the calendar, my assistant reviewed the agenda and sent the email.', 'outbound'],
    [
      'Mira checked the calendar, this assistant reviewed the agenda and sent the email.',
      'outbound',
    ],
    [
      'Mira checked the calendar, our assistant reviewed the agenda and sent the email.',
      'outbound',
    ],
    ['Mira told me that I reviewed the draft and sent the email.', 'outbound'],
    ['Mira and I reviewed the draft and sent the email.', 'outbound'],
    ['Her document is ready. I sent the email.', 'outbound'],
    ['Her document is ready. Your spreadsheet is ready.', 'spreadsheet'],
    ['Her document was created, and your document was updated.', 'workspace'],
    ['Her document is ready and your document is ready.', 'workspace'],
    ['Her document is new and your document is ready.', 'workspace'],
    ['Her appointment was scheduled, and your appointment was scheduled.', 'calendar'],
    ['Your document is ready.', 'workspace'],
    ['My document is ready.', 'workspace'],
    ['The assistant’s document is ready.', 'workspace'],
    ['I prepared her document; it is ready.', 'workspace'],
  ])('still requires an action receipt for assistant or ambiguous activity: %s', (text, kind) => {
    const result = enforceResponseContract(text, readEvidence, {
      requestText: 'Summarize the project update.',
    });
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain(kind);
  });

  it('keeps a read verb bound to its actor and object across a subject change', () => {
    const text = 'I checked the calendar and Mira sent the email.';
    const evidence: ActionEvidence[] = [
      { toolName: 'calendar.list_events', status: 'succeeded', result: { events: [] } },
    ];
    expect(enforceResponseContract(text, evidence)).toMatchObject({
      text,
      blocked: false,
      unsupported: [],
    });
  });
});
