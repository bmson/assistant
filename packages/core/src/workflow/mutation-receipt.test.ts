import { describe, expect, it } from 'vitest';
import { type ActionEvidence, enforceResponseContract } from './response-contract.js';

const ownerRequest = 'Cancel the sunglasses reminder.';
const cancellation: ActionEvidence = {
  id: 'call-reminder',
  toolName: 'reminder.cancel',
  status: 'succeeded',
  args: { query: 'sunglasses' },
  result: { cancelled: true, reminderId: 'reminder-a', text: 'Sunglasses' },
};

function check(
  draft: string,
  request: string,
  rows: ActionEvidence[] = [],
  pending: string[] = [],
) {
  return enforceResponseContract(draft, rows, {
    requestText: request,
    admittedMutationText: request,
    pendingMutationApprovalToolCallIds: new Set(pending),
  });
}

describe('terminal mutation receipts', () => {
  it.each([
    ["I'll delete it now.", 'Delete the obsolete file.'],
    ['Sure — I’ll delete it now.', 'Delete the obsolete file.'],
    ['The obsolete file has been deleted.', 'Delete the obsolete file.'],
    ["I've forgotten that now.", 'Forget the saved preference.'],
    ['Done.', 'Edit the contact record.'],
    ['Removed.', ownerRequest],
    ['I successfully cancelled the sunglasses reminder.', ownerRequest],
  ])('holds unsupported %s at the completion seam', (text, request) => {
    const final = check(text, request);
    expect(final).toMatchObject({ blocked: true, unsupported: ['mutation'] });
    expect(final.text).toContain('couldn’t confirm');
    expect(final.text).not.toContain(text);
  });

  it('accepts the matching positive receipt and rewrites an unsupported future promise', () => {
    expect(check('I removed the sunglasses reminder.', ownerRequest, [cancellation])).toMatchObject(
      {
        blocked: false,
        text: 'I removed the sunglasses reminder.',
      },
    );
    expect(check("I'll cancel it now.", ownerRequest, [cancellation])).toMatchObject({
      blocked: false,
      text: 'I confirmed the requested reminder removal.',
    });
  });

  it.each([
    { ...cancellation, fromCurrentTask: false },
    { ...cancellation, status: 'running' },
    { ...cancellation, status: 'failed' },
    { ...cancellation, status: 'denied' },
    { ...cancellation, result: { cancelled: false } },
    { ...cancellation, result: { cancelled: true, text: 'Sunglasses' } },
    { ...cancellation, result: { cancelled: true, reminderId: 'other', text: 'Passport' } },
    {
      ...cancellation,
      result: {
        cancelled: true,
        reminderId: 'reminder-a',
        text: 'Sunglasses',
        deliveryStatus: 'unknown',
      },
    },
  ])('never treats an unrelated, failed, or interrupted call as a receipt', (row) => {
    expect(check('Done.', ownerRequest, [row]).blocked).toBe(true);
  });

  it.each([undefined, 'Bring sunglasses'])(
    'honors the uniquely resolved reminder query for receipt text %s',
    (text) => {
      const row = { ...cancellation, result: { cancelled: true, reminderId: 'reminder-a', text } };
      expect(check('I cancelled the sunglasses reminder.', ownerRequest, [row]).blocked).toBe(
        false,
      );
      expect(
        check('I cancelled the passport reminder.', 'Cancel the passport reminder.', [row]).blocked,
      ).toBe(true);
    },
  );

  it('does not let a completed action on one checklist item stand in for another', () => {
    const result = check('Done.', 'Cancel the sunglasses reminder and delete the obsolete file.', [
      cancellation,
    ]);
    expect(result.text).toContain('I confirmed the requested reminder removal');
    expect(result.text).toContain('couldn’t confirm the requested file removal');
    expect(result.blocked).toBe(true);
  });

  it('binds each explicit completion to a matching request and receipt', () => {
    const passport = {
      ...cancellation,
      args: { query: 'passport' },
      result: { cancelled: true, reminderId: 'reminder-b', text: 'Passport' },
    };
    const request = 'Cancel the sunglasses reminder and cancel the passport reminder.';
    const draft = 'I removed the sunglasses reminder and deleted the passport reminder.';
    expect(check(draft, request, [cancellation, passport])).toMatchObject({
      blocked: false,
      text: draft,
    });
    expect(check(draft, request, [cancellation]).blocked).toBe(true);
  });

  it('does not say the entire request awaits approval when only one change does', () => {
    const waiting = { ...cancellation, status: 'awaiting_approval', result: null };
    const result = check(
      "I'll cancel it after you approve.",
      'Cancel the sunglasses reminder and delete the obsolete file.',
      [waiting],
      ['call-reminder'],
    );
    expect(result.text).toContain('couldn’t confirm the requested file removal');
  });

  it('joins a named calendar removal to the event ID in the execution receipt', () => {
    const lookup = {
      toolName: 'calendar.search_events',
      status: 'succeeded',
      result: {
        events: [
          { eventId: 'event-synthetic', summary: 'Planning review' },
          { eventId: 'event-other', summary: 'Design review' },
        ],
      },
    };
    const receipt = {
      toolName: 'calendar.cancel_event',
      status: 'succeeded',
      args: { eventId: 'event-synthetic' },
      result: { cancelled: 'event-synthetic' },
    };
    expect(check('Done.', 'Cancel the Planning review event.', [lookup, receipt]).blocked).toBe(
      false,
    );
    expect(check('Done.', 'Cancel the Design review event.', [lookup, receipt]).blocked).toBe(true);
    expect(
      check('Done.', 'Cancel the Planning review event.', [
        {
          ...lookup,
          result: {
            events: [
              ...lookup.result.events,
              { eventId: 'event-duplicate', summary: 'Planning review' },
            ],
          },
        },
        receipt,
      ]).blocked,
    ).toBe(true);
  });

  it('validates an edit against the concrete requested change', () => {
    const change = {
      toolName: 'docs.replace_text',
      status: 'succeeded',
      args: {
        documentId: 'example-doc-id',
        replacements: [{ oldText: 'Draft', newText: 'Ready' }],
      },
      result: {
        documentId: 'example-doc-id',
        updated: true,
        replacements: [{ oldText: 'Draft', newText: 'Ready', occurrencesChanged: 1 }],
      },
    };
    expect(
      check('Done.', 'Edit document example-doc-id from "Draft" to "Ready".', [change]).blocked,
    ).toBe(false);
    expect(
      check('Done.', 'Edit document example-doc-id from "Draft" to "Published".', [change]).blocked,
    ).toBe(true);
    expect(
      check(
        'I edited document example-doc-id from "Draft" to "Published".',
        'Edit document example-doc-id from "Draft" to "Ready".',
        [change],
      ).blocked,
    ).toBe(true);
  });

  it('separates real approval from inferred approval or an executed effect', () => {
    const waiting = { ...cancellation, status: 'awaiting_approval', result: null };
    const draft = "I'll cancel it after you approve.";
    expect(check(draft, ownerRequest, [waiting], ['call-reminder']).text).toContain(
      'awaiting your approval',
    );
    expect(check(draft, ownerRequest, [waiting], ['another-call']).text).not.toContain(
      'awaiting your approval',
    );
    expect(check('I cancelled it.', ownerRequest, [waiting], ['call-reminder']).text).toContain(
      'couldn’t confirm',
    );
  });

  it.each([
    ['I did not delete the file.', 'Do not delete the file.'],
    ['To delete a file, first make sure you selected the correct one.', 'How do I delete a file?'],
    ['"I’ll delete it now."', 'Draft a fictional message about deleting a file.'],
    ['> I’ll delete it now.', 'Explain this line.\n> I’ll delete it now.'],
    [
      'I removed the awkward wording from the draft below.',
      'Rewrite this message to sound natural.',
    ],
  ])('leaves quoted, negative, and non-action discussion alone', (draft, request) => {
    expect(check(draft, request).blocked).toBe(false);
  });
});
