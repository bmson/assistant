# Owner screenshot review — 4 October 2026

The owner shared nine iPhone screenshots covering Reminders, the chat transcript (briefing, settled suggestions, schedule conflict, reminder cards), More → Standing approvals, Improvements, Activity and Documents. This review records what each screenshot shows, the source that produces it, and a proposed improvement. Nothing here is fixed yet; each item is a proposal for a follow-up change.

The screenshots contain personal data (calendar events, a phone number, an email address), so they are described here rather than committed.

Priority key: **P1** wrong behaviour or a misleading state; **P2** confusing presentation that hides useful information; **P3** polish.

## Summary

| # | Area | Finding | Priority |
| --- | --- | --- | --- |
| 1 | Reminders | "After the game" was scheduled at 12:00, while the game is still on (it ends 13:00) | P1 |
| 2 | Chat cards | A reminder cancelled in the same turn still shows as an active reminder card | P1 |
| 3 | Chat cards | The "Reminder cancelled" card does not say which reminder was cancelled | P1 |
| 4 | Briefing | One game in two calendars is reported as a "Schedule conflict" | P1 |
| 5 | Suggestions | A cancelled practice is offered as a new calendar event | P1 |
| 6 | Improvements / chat | Raw OpenRouter routing error is shown to the owner, with a retry that cannot help | P1 |
| 7 | Improvements | "Cards should all have left aligned text" is marked deployed, but settled cards still show centred text | P1 |
| 8 | Activity | "Document processor not configured" is shown as a green **Done** | P1 |
| 9 | Activity | The list is capped at 50 with no total, so "50 tasks · 50 done" is a page size, not a count | P2 |
| 10 | Reminders list | Only a relative time ("Next in 10 hours") with no date or time of day | P2 |
| 11 | Suggestions | "Tomorrow" is written into the stored suggestion text and goes stale ("event start on Tomorrow 5:00 PM") | P2 |
| 12 | Suggestions | One multi-day event becomes two suggestions ("event start" and "event end") | P2 |
| 13 | Standing approvals | Two identical "Repeat an approved phone call" rules; scope text is a raw brief dump | P2 |
| 14 | Activity | Maintenance jobs fill the owner's Activity feed and show developer log text | P2 |
| 15 | Schedule conflict card | No date on the conflict; 24-hour times next to 12-hour titles | P2 |
| 16 | Time format | Cards use the device locale (19:00) and server text uses 12-hour time (5:00 PM) | P3 |
| 17 | Documents | Two red destructive buttons on every import card; a large empty state above the imports | P2 |
| 18 | Navigation chrome | Scrolled content shows through behind the floating title and back button | P3 |
| 19 | Chat | "Jump to latest" covers card text, including when the latest message is one card away | P3 |
| 20 | Activity cards | Blank band between the divider and the footer; status shown twice | P3 |
| 21 | Briefing list | Date chips use a monospaced font | P3 |

## 1. Reminders: "after the game tomorrow"

**What the screenshots show.** The owner asked *"Remind me to wash the car after the game tomorrow."* The game is on the calendar as 10:55–13:00 (Family) and 11:40–13:00 (SF United Soccer). The transcript shows three cards in this order:

1. "Complete · Reminder cancelled · This reminder will no longer run."
2. "Reminder · Wash the car · Oct 4, 2026 at 19:00"
3. "Reminder · Wash the car · Oct 4, 2026 at 12:00"

The Reminders screen lists a single "Wash the car — Once · Next in 10 hours" and, in a later screenshot, "Next in 13 hours".

**Problems.**

- **12:00 is during the game.** The game ends at 13:00, so a 12:00 reminder fires while it is still on. 19:00 is six hours after the end and is not what "after the game" usually means. The schedule should come from the matched event's end time (for example, 13:00 or shortly after) and the reply should name the anchor: "I'll remind you at 1:00 PM, when United v Albion ends."
- **The owner can't tell which reminder is live.** The chat shows two active reminder cards and one anonymous cancellation. The Reminders screen shows one reminder with only a relative time. Without a clock time on that screen (see #10), the owner can't match it to either card.
- **The game may have been cancelled.** The top of another screenshot shows "26/27 U13B Azul Event - CANCELLED". If that is the same fixture, a reminder tied to the game should say the event is cancelled rather than quietly schedule around it.

**Proposed changes.**

- When a reminder is relative to a named event ("after the game", "before the meeting"), resolve the event and schedule from its `end` (or `start`), returning the anchor in the tool result so the card can show "after United v Albion".
- Add a response-contract check: a reminder scheduled "after" an event must not fire before that event's end.
- If the anchoring event is cancelled, say so and ask instead of creating the reminder.

Source: [reminder tools](../../packages/tools/src/reminders.ts), [response contract](../../packages/core/src/workflow/response-contract.ts).

## 2–3. Reminder cards in the same turn contradict each other

**Cause.** `reminderResponseCards` builds a card for every reminder in a `reminder.create` **or `reminder.list`** result, keyed by `reminderId`. It never removes a reminder that a later `reminder.cancel` in the same evidence cancelled. A list call made before the cancel therefore renders the cancelled reminder as an active "Reminder" card. `statusResponseCards` also renders every status card before every reminder card, so the cancellation appears above the reminders whatever order the calls ran in.

The cancellation card text is fixed: "Reminder cancelled — This reminder will no longer run." It doesn't use the reminder's text or time, although the cancel result identifies the reminder.

**Proposed changes.**

- In `reminderResponseCards`, collect `reminderId`s with `reminder.cancel` → `cancelled: true` and either drop them or render them with `enabled: false` and a "Cancelled" label.
- Show list results only when the owner asked to list reminders. A list call made as an internal check before a change shouldn't produce cards.
- Put the reminder's text and former time in the cancellation card's `detail`: "Wash the car · was Sun, Oct 4 at 12:00 PM".
- Change the status card eyebrow from "Complete" to something that matches the action ("Cancelled", "Sent", "Draft ready"). "Complete" above "Reminder cancelled" reads as a contradiction.

Source: [`reminderResponseCards`](../../packages/core/src/workflow/response-cards.ts) (≈L550), [`statusResponseCards`](../../packages/core/src/workflow/response-cards.ts) (≈L1074), [card ordering](../../packages/core/src/workflow/response-cards.ts) (≈L1338), [native status card "Complete" label](../../apps/ios/Assistant/Components/MessageBubble.swift) (≈L3474).

## 4. False schedule conflict: one game, two calendars

**What the screenshot shows.** "Schedule conflict · 1 · Confirmed overlaps · Overlap 11:40–13:00" between:

- "⚽ United v Albion (11:40AM)", 10:55–13:00, Family calendar, *Crocker Amazon Soccer Fields, soccer field & Parking lot, 785 Moscow St*
- "26/27 U13B Azul vs ALBION SC BU13 Academy", 11:40–13:00, SF United Soccer calendar, *Crocker Amazon, 1669 Geneva Avenue*

This is one fixture: the family calendar entry adds 45 minutes of travel or warm-up time to the club's entry. The briefing summary then says "a scheduling conflict today at 11:40 AM between two soccer events", which is wrong.

**Cause.** `sameRealWorldEvent` merges copies on different calendars only when:

- the normalized locations are equal or one contains the other, which fails here because both strings include different street addresses; or
- the titles share at least two tokens, which also fails because the only shared token is `albion`.

The strong signals it ignores:

- Identical end time (13:00).
- The family title includes the club event's start time: "(11:40AM)" equals the other event's start.
- Both locations start with the same venue name ("Crocker Amazon").

**Proposed changes.**

- Compare the venue name, meaning the first comma- or newline-separated location segment, on a token or prefix basis instead of comparing the whole address.
- Treat the same end instant plus at least one shared distinctive title token as the same event across calendars.
- Treat a time written in one title that equals the other event's start time as a match signal. `titleTokens` currently strips it before comparing.
- Add this pair as a regression fixture in `briefing.test.ts`.

Source: [`sameRealWorldEvent` / `findConflicts`](../../packages/core/src/workflow/briefing.ts) (≈L349–462), [`normalizedLocation` / `titleTokens`](../../packages/core/src/workflow/briefing.ts) (≈L315).

## 5, 11, 12. Calendar suggestions from mail

**What the screenshots show.** These settled suggestions:

- "stop drop and go event start on Tomorrow 5:00 PM, from Geoff Oxholm via ParentSquare — add it to your…"
- "stop drop and go event end on Thu, Oct 8 5:00 PM, from Geoff Oxholm via ParentSquare — add it to your…"
- "Spa reservation at vabali spa Berlin on Sun, Oct 11 9:40 AM, from vabali spa Berlin — add it to your cale…"
- "Practice cancelled (was scheduled 5:00 PM - 6:30 PM PT) on Mon, Oct 12 5:00 PM, from SF United F.C. — a…"

**Problems and causes.**

- **Stale relative date.** `proposalFor` builds `summary` with `ownerDateTime(entry.iso, timeZone)`, which produces "Tomorrow". The summary is stored and still says "Tomorrow" on later days. It also reads badly: "on Tomorrow 5:00 PM". Store absolute dates in persisted text and let the client render them as relative.
- **A cancellation proposed as a new event.** "Practice cancelled (was scheduled…)" falls into the `appointment` category, so the assistant offers to *add* it to the calendar. A cancellation should offer to remove or mark the existing practice ("SF United cancelled Monday's practice — remove it from your calendar?"). If nothing matches, it should become an informational note.
- **One event, two suggestions.** "event start" (tomorrow) and "event end" (Thu, Oct 8) come from the same email. Extraction should combine start and end markers from one message into one ranged event.
- **Truncated proposals.** The settled row clips the summary at two lines, ending in "add it to your…". The useful part, what and when, survives, so the stored title could drop the fixed "— add it to your calendar?" suffix. The action is already implied by the receipt state.

Source: [`proposalFor`](../../packages/core/src/workflow/briefing.ts) (≈L212), [`ownerDateTime`](../../packages/core/src/owner-text.ts) (≈L110).

## 6. Raw provider error shown in chat and Improvements

**What the screenshots show.** A chat notice and the Improvements card both show:

> The fix for "Investigate the 7 unsupported-claim corrections…" needs attention: No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection

The Improvements card then offers **Retry within daily allowance**, **Run now** and **Dismiss report**.

**Cause.** The OpenRouter client always sends `require_parameters: true`, plus `max_price` when it is configured. If the investigation model's request includes a parameter that no upstream supports, or no upstream fits the price ceiling, OpenRouter returns this error. The self-repair loop stores `err.message` as `lastError` unchanged, and `notifyRepair` puts that text into the owner notification.

**Problems.**

- This is a configuration error and will fail the same way on every retry. The UI still offers two retry paths, and one of them ("Run now") may bill.
- The owner sees a provider name and a documentation URL they can't act on.

**Proposed changes.**

- Classify provider errors when `lastError` is written: routing or configuration, transient, budget, or content. For a routing or configuration error, show "The model chosen for investigations isn't available with the current settings. Choose another model in AI providers," with a link to that screen. Keep the raw text in the evidence and history disclosure.
- Hide **Retry** and **Run now** for non-transient errors until the model or route changes.
- Probe the configured investigation model with the same request shape when it is saved, so the mismatch shows up there and not in a later failure notice.

Source: [OpenRouter `require_parameters`](../../packages/core/src/model-router/provider.ts) (≈L180), [self-repair error capture](../../packages/core/src/workflow/self-repair.ts) (≈L320) and [notification text](../../packages/core/src/workflow/self-repair.ts) (≈L130), [Improvements actions](../../apps/ios/Assistant/Views/WorkspaceView.swift) (≈L830–853).

Other notes on the Improvements card:

- **Retry within daily allowance**, **Run now** and **Dismiss report** are stacked at three different widths. Use one action row, or full-width buttons that match.
- The text doesn't explain how "Retry within daily allowance" differs from "Run now". Add a one-line caption: "Retry waits for tomorrow's free attempt; Run now starts an extra, billed attempt."

## 7. Left-alignment fix not confirmed

The Improvements screen shows "Deployed · needs confirmation — Cards should all have left aligned text". The settled suggestion rows in the chat screenshot are still centred. In every wrapped title, the left and right margins of the first line are equal (for example, "Spa reservation at vabali spa Berlin on Sun, Oct 11" is inset about 28 px on both sides relative to its second line).

`settledRow` sets `.multilineTextAlignment(.leading)` on the `DisclosureGroup` (commit 9be39d6). The label `VStack` has no `maxWidth: .infinity`, and the default disclosure style renders the label as a button. In practice, the environment value doesn't reach the wrapped `Text`.

**Proposed changes.**

- Don't confirm this improvement yet.
- Apply `.multilineTextAlignment(.leading)` directly on the title `Text`, and give the label `VStack` `.frame(maxWidth: .infinity, alignment: .leading)`.
- Add a snapshot or UI test with a two-line settled title. The alignment can only be verified on a rendered row.

Source: [`settledRow`](../../apps/ios/Assistant/Components/MessageBubble.swift) (≈L4522–4566).

## 8, 9, 14, 20. Activity

**What the screenshot shows.** "50 tasks · 50 done". Cards for Memory Extraction, Document Processing, Pulse and Ambient Refresh, each subtitled "Scheduled" with a green "✓ Done" pill.

- **Failure shown as success (P1).** Document Processing reports "document processor not configured — pending documents left as-is" with status `done`. This is a setup problem, so it should be `needs_attention`, or at least a distinct "Not set up" state. It should link to the configuration screen, and it shouldn't run (and bill a budget) on every tick while unconfigured.
- **The count is a page size (P2).** `listActivityWithRepository` defaults to `limit: 50` and returns no total or `hasMore`. The header counts what was loaded, and the filters run on the client over that same window. As a result, "Needs you" can miss an older `needs_attention` task. Return a total per status (`activityRows` already exists for the dashboard) and page the list.
- **Maintenance work fills the feed (P2).** Background jobs (Memory Extraction, Pulse, Ambient Refresh, Document Processing) run every few minutes and push the owner's own tasks out of the 50-row window. Group them under one collapsible "Background upkeep" row, or hide successful no-op runs by default.
- **Developer log text (P2).** Memory Extraction shows "extraction: 7 saved (0 quarantined, 0 new people), 0 duplicate, 0 tombstoned, 0 occasion(s), from 2 conversation(s); open loops 4 saved (0 duplicate)". Plain version: "Learned 7 things from 2 conversations · 4 follow-ups noted". Keep the full counts in details.
- **"Scheduled" next to "Done" (P3).** The subtitle is the trigger type, but it reads as a status that contradicts the pill. Use "Runs automatically", or drop it.
- **Duplicate status and empty space (P3).** The green check glyph and the "✓ Done" pill say the same thing. In the footer `HStack(alignment: .bottom)`, the 44 pt "…" menu sits above the metadata line and leaves a blank band under the divider. Pulse has no progress text, so its card is mostly empty. Align the footer on `.center` or `.firstTextBaseline`, and omit the divider when there is no progress text.

Source: [Activity view](../../apps/ios/Assistant/Views/ActivityView.swift) (summary ≈L140, card ≈L196), [activity query limit](../../packages/application/src/tasks/queries.ts) (≈L71), [extraction summary](../../packages/core/src/memory/jobs.ts) (≈L397), [document processor summary](../../packages/core/src/memory/document-processor.ts) (≈L219).

## 10. Reminders screen shows only relative time

`reminderDetail` renders "Once · Next in 10 hours". A relative time alone can't be checked against what the owner asked for ("after the game"), and it changes every time the screen opens: 10 hours in one screenshot, 13 in another.

**Proposed change.** "Once · Sun, Oct 4 at 1:00 PM · in 10 hours". Put the absolute time first and keep the relative time as a secondary hint. Use the same formatter as the chat reminder card so the two screens can be compared directly.

Also:

- The reminder row repeats the bell glyph in a large tile above the title, which costs a full line on every row. Put the glyph inline with the title, as in Activity.
- The footer copy is good. Consider "Remove" → "Cancel reminder" to match the chat card's wording.

Source: [`RemindersView`](../../apps/ios/Assistant/Views/MoreView.swift) (≈L558–663).

## 13. Standing approvals: duplicate phone-call rules

**What the screenshot shows.** Two "Repeat an approved phone call" rules with the same visible text. Each is a single paragraph of more than 15 lines: "Call +1415…, up to 5 minutes: Stay on the line with Baldvin… Do not hang up until he says goodbye.. May share: … May agree to: … Limits: … Voicemail: leave_message (Hi Baldvin…). Language: English."

**Problems.**

- **Duplicates.** The policy key is a SHA-256 hash of the canonical brief, and the brief includes every field: `contactName`, `voicemailMessage`, `language` and others. Two briefs that differ only in a field the label doesn't show, or in whitespace, become two rules that look the same. Normalise text fields (trim, collapse whitespace) before hashing. When a new rule would add an otherwise matching rule with the same `to` and `goal`, offer to replace the existing one.
- **Raw enum and double punctuation.** "Voicemail: leave_message" shows a transport value. "goodbye.. May share" adds a period after text that already ends with one. The approval card already has friendly copy ("Leaves a voicemail if no one answers"), so the settings label should use it.
- **Contradictory policy.** "Do not hang up on voicemail" next to "Voicemail: leave_message". This text comes from the model-written brief, so validate it when the brief is created: if `mustNot` mentions voicemail, it must agree with `onVoicemail`.
- **Density.** Show the target, a one-line goal and the limits as separate labelled rows. Collapse the full brief behind "Show full brief". Mask the phone number to its last four digits on the list row.

Source: [settings label](../../apps/web/app/settings/labels.ts) (≈L60), [`approvalCallBrief`](../../packages/core/src/approval-rule.ts) (≈L198), [policy key hash](../../packages/firestore/src/approvals.ts) (≈L36, ≈L612), [approval summary copy](../../packages/tools/src/calls/index.ts) (≈L52).

## 15, 16, 21. Dates and times across cards

- **No date on the conflict card.** "Overlap 11:40–13:00" doesn't say which day it is. The briefing is dated Saturday, Oct 3 and calls the conflict "today", while the owner refers to "the game tomorrow". Add the day ("Sun, Oct 4 · 11:40 AM–1:00 PM").
- **Mixed clock formats.** Client-rendered cards use the device locale ("Oct 4, 2026 at 19:00", "11:40–13:00"). Server-composed text uses 12-hour time ("5:00 PM", "11:40AM" in titles). Pick one source of truth: the owner's locale setting from More → Language and time, applied on both server and client.
- **Year shown for near dates.** "Oct 4, 2026" includes the current year. Drop the year inside the current year and say "Today" or "Tomorrow" only when rendering, never in stored text (see #11).
- **Monospaced date chips.** In the briefing's upcoming list, the date chips ("Tomorrow", "Thu, Oct 8") use `.caption2.monospaced()`. The [design system](../design-system.md) keeps monospace for codes and evidence. Use `.monospacedDigit()` on the system font if tabular alignment is the goal.

Source: [`cardDate`](../../apps/ios/Assistant/Components/MessageBubble.swift) (≈L3980), [briefing chip](../../apps/ios/Assistant/Components/BriefingCardView.swift) (≈L180).

## 17. Documents

- **The empty state takes the top of the screen.** "No documents filed" with a large icon sits above the 23 backstory imports, so the content that exists starts halfway down. When imports exist, show a one-line "No filed documents yet" and put imports first.
- **Destructive actions are visually prominent.** Every import card shows two red buttons, **Purge memories** and **Delete source**, next to **More**, which wraps to two rows. These are rare, irreversible actions. Move them into the **More** menu with their confirmation, leaving one row with a status pill.
- **Unclear counts.** "19 saved · 1 processed" and "698 saved · 295 processed". It isn't clear what was processed (files, messages, windows) or how many remain while one is **Running**. Use "295 of 1,240 emails read · 698 memories saved", with a progress bar while running.

Source: [Documents content](../../apps/ios/Assistant/Views/WorkspaceView.swift) (≈L378–396) and [import actions](../../apps/ios/Assistant/Views/WorkspaceView.swift) (≈L1203–1272).

## 18–19. Navigation chrome and "Jump to latest"

- **See-through header.** On Improvements and Documents, scrolled text passes behind the floating title and back button with no material. For example, "Observed pattern" is cut off behind the back button, and "Filed documents 0" shows as a ghost behind "Documents". `assistantSubmenuChrome` should add a scroll-edge material (blur and fade) under the title row once the content has scrolled.
- **"Jump to latest" placement.** The pill sits mid-card over body text in both chat screenshots. In one of them, the latest message is less than a screen away. Show it only when the distance to the bottom is more than about one viewport, and dock it above the composer over a backdrop so it never covers a line of text.

## Suggested order of work

1. Reminder correctness: #1, #2, #3 and #10. These directly affect whether the owner trusts that a reminder will fire at the right time.
2. Briefing truthfulness: #4 and #5. Never report a conflict that isn't one, and never propose adding a cancellation.
3. Error honesty: #6 and #8. Classify errors, use plain language, and hide retries that can't succeed.
4. Re-open the alignment improvement: #7, adding a rendered test.
5. Activity scale: #9 and #14. Totals, paging and grouped upkeep.
6. Presentation polish: #11–13 and #15–21.
