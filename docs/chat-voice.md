# How the assistant sounds in chat

The primary chat is a conversation with one person. It should read like texting
a good human assistant: short, plain, first person, and quiet unless there is
something worth saying. A review of a week of production messages (192 assistant
messages, 124 of them in the primary chat) found that most of what the owner
scrolled past was the system talking about itself:

| In the primary chat                                         | Count | Now                                                              |
| ----------------------------------------------------------- | ----: | ---------------------------------------------------------------- |
| Self-repair progress ("The fix for “…” needs attention: …") |    27 | Stays in Notifications and Improvements; never mirrored          |
| Approval requests rendered as the whole tool brief          |    24 | One line: "Call Baldvin for up to 5 minutes — okay to go ahead?" |
| Raw failures ("Last error: AI_APICallError: …")             |    12 | One plain sentence, no error text                                |
| Canned fallbacks ("no successful tool result was returned") |     6 | Names the step in words                                          |
| Real conversation                                           |   ~28 | Unchanged                                                        |

## The rules

1. **Background work does not talk in the chat.** Work the assistant started on
   its own (a schedule, a nightly job, self-repair) reports to the Notifications
   log and the Activity page. It is not mirrored into the owner's conversation
   and does not ping their phone. See `isBackgroundTask` in
   `packages/core/src/workflow/executor/notices.ts`.
2. **Work the owner asked for gets one line when it fails.** `failureNotice` in
   `packages/core/src/owner-text.ts` classifies the error (provider trouble,
   billing, or ours) and says so without quoting it. The raw error stays on the
   task row, where Activity shows it.
3. **An approval is a question, not a form.** The card and its prose use
   `approvalHeadline` (who/what/how long). The full summary — a call's whole
   brief, a raw URL — stays on the approval row and the Approvals page, which is
   where the owner checks what exactly they are agreeing to.
4. **Questions are asked like questions.** `clarifyingQuestion` replaces
   "Before I proceed, I need to know: A; B".
5. **Names, not identifiers.** Senders go through `readableSender`, places
   through `shortPlace`, task titles through `ownerTaskLabel` (which refuses a
   truncated instruction like "Prepare the owner's morning brief. Check: (1)…").

## Compatibility

Persisted messages keep their exact text forever, and several readers match on
it (`legacyNoticeKind`, `isDecisionProseNotice`, `NEEDS_ATTENTION_PREFIXES`).
Those matchers are untouched; new copy is carried by structured `notice` and
`approval` parts, which is what the clients read.

## Not done yet

- The iPhone approval card still has its own chrome ("Approval needed", the
  code capsule, "Review decision"). The text inside is now short; slimming the
  card itself is a client change.
- The morning brief still arrives as up to three messages (the brief card, the
  scheduled task's recap, and the wake brief). Merging them is a product call.
- Nightly "look-ahead" runs post "nothing to flag" into Notifications. Skipping
  an empty result needs a rule about what counts as empty.
