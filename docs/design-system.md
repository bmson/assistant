# Assistant design system and experience guidelines

Reviewed October 3, 2026. This document defines the experience standard for Assistant and records its current web and native foundations. Guidelines marked **target** are acceptance criteria for future work, not claims that every retained screen implements them. The [screenshot-led refinement](audits/ui-review-2026-10-03.md), [web audit](audits/web-experience-2026-10-02.md) and [iOS audit](audits/ios-experience-2026-10-02.md) contain page-level findings and validation limits.

## Design intent

Assistant should feel like a calm, capable person who knows the situation, keeps useful notes, and follows through. The interface should make three things obvious: what matters now, what the assistant is doing, and what needs the owner's judgment. Routine technical work should recede behind those answers.

The visual identity is green paper, readable ink, and native typography. Conversation has its own deeper green stage. Utility pages are quiet work surfaces. This is an existing product identity to develop consistently, not a reason to add gradients, decorative metric tiles, or an ornamental dashboard to every screen.

Five principles govern decisions:

1. **Continuity:** preserve the owner's place, draft, selections, and understanding as data changes.
2. **Evidence:** distinguish what was observed, inferred, proposed, approved, attempted, and completed.
3. **Judgment:** initiative earns attention by being useful; more notifications are not more assistance.
4. **Clarity:** one dominant action and a readable next step beat a grid of equally weighted controls.
5. **Native behavior:** use platform text editing, scrolling, sheets, focus, and accessibility rather than simulating them with fragile gestures.

## Product surfaces and navigation

The iPhone is the current everyday assistant client. Its directory contains Chat, Activity, Goals, Approvals, Chats, Memory, Cards, People, and More. Web is currently an owner administration console: Settings, Security, Audit, audit detail, Setup, and Sign in. Security, Setup and Sign in are available in passkey mode; Google/shared-token installations expose Settings and Audit. Its 27 other product/legacy route implementations are retained but blocked by the web proxy; `/` lands on Settings. Their retained UI is useful reference material, not current web feature availability.

Use the same concepts across clients without copying platform geometry. For example, native uses sheets and a pull-up directory; the browser console uses navigation links and content regions. A person, fact, decision, goal, or task has one server identity even if it appears in several places. A resolved approval must read resolved in its originating chat, Activity, and Approvals.

**Target:** navigation badges count actionable items, rather than every stored record. An approval badge should take the owner to the same exact decision shown in chat. More should group preferences, connections, workspace, and diagnostics by purpose; ordinary conversation should not expose that information hierarchy.

## Semantic materials and colors

Use semantic tokens from [web globals](../apps/web/app/globals.css) and [AssistantTheme](../apps/ios/Assistant/Design/AssistantTheme.swift). Never choose a light-mode color in a component and try to repair dark mode later. A surface and its foreground travel together.

| Role | Web light / dark | iOS light / dark | Use |
| --- | --- | --- | --- |
| Canvas | `#EEF5F0` / `#121A15` | `#EEF5F0` / `#101712` | Page background |
| Raised | `#FFFFFF` / `#19241D` | `#FFFFFF` / `#1B2820` | Content on a page |
| Sunken | `#E3EDE6` / `#243129` | `#E3EDE6` / `#152019` | Nested well, receipt, subdued input |
| Strong ink | `#15201A` / `#EEF5EF` | `#15201A` / `#EDF6F0` | Primary reading |
| Muted ink | `#5A6D62` / `#9CB0A2` | `#5A6D62` / `#A9BAAF` | Secondary explanation and metadata |
| Accent | `#217A4B` / `#6FCB9C` | `#217A4B` / `#6FCB9C` | Primary action, selected state, links |
| Conversation stage | `#2B8253` / `#1B3626` | `#2B8253` / `#1B3626` | Conversation canvas |
| Conversation well | `#1E613E` / `#193424` | `#1E613E` / `#193424` | Owner message, composer and active stage controls |
| Conversation well ink | `#F4FAF5` strong, `#C6DDCF` supporting | `#F4FAF5` strong, `#C6DDCF` supporting | Opaque reading ink on the well; never attenuate required text by opacity |
| Reply material | Fixed white paper in retained web chat | `#F5FAF6` / `#293D31` | Assistant reply surface |

The dark surfaces differ intentionally by platform, while their semantic role and green family match. Pixel equality is not the consistency contract. Web accent foreground changes from white to deep ink in dark mode; light accent fills cannot carry white text reliably. Native warning/error surface and ink pairs already exist and should be used together.

The light secondary ink is now shared across platforms. On the opaque sunken surface, `#5A6D62` measures 4.61:1; the previous native `#5E7266` measured 4.30:1. Ordinary text needs at least 4.5:1 under the [WCAG contrast criterion](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). These are calculated token-pair ratios, not a whole-app accessibility certification; opacity, nested surfaces and component-specific colors still require inspection.

Stage content uses stage foregrounds. Content printed on reply paper uses paper foregrounds. Do not inherit stage text into a paper card, or dark-page ink into a fixed white reply. Mood cues may tint the small chat accent; they must not unexpectedly recolor the entire conversation or change the meaning of status colors.

The light brand stage has limited contrast headroom. Retained web bare-stage text uses white/near-white ink; ordinary conversation controls use the darker shared well and its opaque reading pair. The console header stays opaque over chat so its ordinary navigation ink does not blend into the stage. Native owner/composer surfaces and recall metadata use the same well family. Glass or a decorative wash must not weaken the material behind required reading text. A placeholder is readable interface text, and a provisional completion must remain readable while conveying its status through wording/type treatment.

**Target:** status success, warning, destructive/error, and informational colors have named surface, ink, and border roles on both platforms. Brand green alone does not distinguish completed work from selected work. Status is always expressed in words and accessible labels as well as color. Validate text contrast on the actual nested surface; the lighter surrounding page is not the relevant measurement.

## Typography and hierarchy

Use system faces. Web uses SF on Apple platforms and Segoe/system elsewhere; display aliases the same family. Native uses Dynamic Type styles. Use monospaced text for identifiers, code, payloads, and diagnostic keys. Ordinary labels, navigation, explanations, and buttons use sentence case and the interface face.

| Purpose | Web working scale | Native guidance |
| --- | --- | --- |
| Page title | 28 px on phones, 30 px on larger screens, strong | Native navigation title or large title |
| Content title | 24 px | Title/Title2, appropriate to sheet hierarchy |
| Section title | 18 px | Headline |
| Reading and conversation | 16 px or comfortable reading size | Body, scales with owner text settings |
| Controls and secondary text | 14 px | Subheadline/Callout |
| Metadata | 12 px minimum in ordinary browser layouts | Caption, never required to understand an action |

Hierarchy comes from size, weight, space, and material. Do not put every section title in a large colored badge. Keep conversational prose in readable columns; long audit identifiers may wrap or scroll within their own region without making the page overflow. Owner-facing scheduling should use the owner's local date interpretation. Diagnostic timestamps may use explicit UTC, as Audit does; device-key dates currently use browser locale. Exact timestamps/timezones belong in supporting evidence when ambiguity matters.

**Target:** at large accessibility text sizes, controls and metadata reflow vertically, without fixed-height clipping. A critical action, amount, recipient, warning, or error is never represented only by tiny text. Web zoom remains enabled.

## Geometry and spacing

| Role | Web | iOS |
| --- | --- | --- |
| Main reply/hero geometry | Retained chat shell uses 16 px corners | Conversation/hero 27 pt |
| Utility card | 16 px | 22 pt |
| Nested panel | Smaller than its parent | 18 pt |
| Control | 8 px where appropriate | 12 pt |
| Page gutter | Responsive, derived from shared page shell | 16 pt compact gutter |
| Card stack/content gaps | Consistent shared spacing utilities | 12 pt |
| Action gap | Shared compact spacing | 8 pt |
| Touch action | Shared buttons and fields at least 44 px | At least 44 pt |

Use platform spacing deliberately, rather than forcing the web corner radius onto iPhone. A utility card holds one meaningful object or decision. A list of records should use rows, not a nested stack of elevated cards inside another card. Borders and tonal wells create separation; shadows are reserved for actual raised or overlay material.

Own safe areas once. The composer and transcript must move as one surface when the native directory is revealed. Derive status-crown and Dynamic Island clearances from actual device geometry. Do not fix one phone by adding a constant padding that fails another phone, keyboard state, or text size.

## Shared state language

The server stores detailed workflow states; the interface translates them consistently. This table is the design vocabulary, not a replacement for the workflow state machine.

| State | Owner-facing meaning | Required presentation |
| --- | --- | --- |
| Queued | Work is accepted and waiting to start | Brief next step; no implication that tools ran |
| Working | A bounded work session is active | Useful progress, cancel where supported |
| Needs your decision | A concrete choice or approval blocks work | Exact subject and next action |
| Waiting until… | Time/event dependency | Local time or named dependency |
| Needs more budget | Allowed work exceeded its grant | Amount and scope; route to budget decision |
| Needs attention | Work cannot proceed reliably | Cause, evidence, useful recovery action |
| Completed | The requested outcome is supported by execution evidence | Result or artifact, not only a green tick |
| Cancelled | Work was stopped | Distinguish known effects from anything still being reconciled |
| Failed | The operation did not finish | Honest failure; no fabricated completion message |
| Stale data | Last good information is visible but could not refresh | Freshness, retry; disable unsafe decisions against stale detail |

Do not reuse “Done” for an archived task, a stale memory, a dismissed notice, and an executed request. Archive changes visibility. Snooze changes timing. Forget removes retained information. These verbs have different consequences.

Every asynchronous screen needs initial loading, loaded empty, loaded content, refresh, recoverable failure, unavailable capability, and pending mutation treatment. An empty list is not a failed request. Preserve last good data on a refresh failure and tell the owner it may be stale. Retry should restore the same intention and parameters.

## Component contracts

### Page shell

One title, one short explanation where needed, one primary action if the page creates something, then content. Shared shell owns canvas, width, gutters, top/navigation treatment, and focus/skip behavior. Detail pages identify the object before showing controls. On phones, page actions have their own row so long titles retain their reading width. Narrow fact grids stack instead of squeezing labels and values. Loading placeholders follow final geometry to limit disruptive layout movement. Records are readable on arrival; repeated scroll-driven entrance effects are removed from the shared browser card.

### Record row

Put the identifying label first, then the important status or time, then optional supporting metadata. Keep a single clear destination. Secondary menus should not compete with the row's open action. A trailing disclosure is only appropriate when the row opens something; switches and destructive controls must not masquerade as disclosures.

### Decision card

Show the action, exact recipients/targets, relevant amount or scope, and why a decision is needed. Present approve/reject or the actual choices, with pending and resolved states. Show granted scope and expiry for standing/autonomous permissions. Repeated projection of the same approval uses one server decision identity and cannot cause another execution.

### Status and evidence

Give the useful plain-language status first. The source, timestamp, tool result, and audit identifiers are secondary. An expandable “What happened” is appropriate for Activity/Audit; raw JSON is not the main outcome. Evidence must remain accessible for the owner and useful for debugging.

### Destructive actions

State the concrete consequence at the action: forget this fact, revoke this device, cancel this work, remove this connection. Use a short confirm step for destructive account/security actions. Do not add confirmation to every reversible selection, filter, or view change. Prevent repeated submission, preserve error recovery, and never display success until the server confirms it.

### Forms

Labels remain visible when a value is entered. Explain required setup or permissions next to the relevant field. Preserve draft input after errors. Keyboard submit and focus order work predictably. A saved preference should show the applied value without waiting for a broad unrelated reload.

Editors that load existing values must finish a successful read before accepting writes. Failed initial reads offer retry instead of presenting writable blank fields. Refreshes preserve each dirty field independently. Existing connections precede setup controls; add forms open through a deliberate action. Serialize dependent mutations, and show failures beside the action without discarding input. A new recovery credential receives focus, wraps on phones, and has both copy feedback and a visible manual fallback.

### Search and large lists

Separate typed query, applied query, and result freshness where searches are asynchronous. Clearing search also clears the applied filter. Give no-results wording that includes the active filter and a clear action. Keep stable identities, bound fetching and rendering, and page results; do not load every fact into the client to draw the first screen.

## Conversation and human assistant behavior

Start with the useful response. For a straightforward question, answer. For work, say what was accepted and what happens next. Ask one concise question when a material detail is missing. Use remembered preferences without repeating the owner's biography. A summary is a working note with sources, not a substitute for checking a live fact.

An unsent draft belongs to its conversation and authenticated session. Changing chats restores the appropriate draft. A failed send may restore automatically only into an empty composer; a newer follow-up stays intact with an explicit recovery path. The current single-reply coordinator waits for completion or stop before chat switching, chat creation or model changes. Explain this condition beside the controls. Dictation and delayed focus remain bound to their original visible conversation.

Suggestions resolve into receipts. A snoozed receipt shows its actual return time when provided, including accessible speech. Missing timing is stated plainly. Authoritative pending state can return when the snooze expires. Accepting a suggestion links its created work and shows progress; it does not create an approval badge.

An approval receipt describes permission; the action ledger establishes execution. Distinguish rejection, failure, expiry, missing decisions, and completed effects. If a reply is interrupted after work ran, retain verified effects and an Activity recovery link. Ambiguous requests show bounded, concrete choices. An unreadable settled message must remain visible with useful recovery rather than disappear or invite a blind repeated action.

A simple availability answer leads with the owner's local day and the calendars actually checked. Keep partial coverage and missing calendars explicit. Successful source cards remain useful when another lookup fails; avoid repeating a complete mail search when the opened threads already carry its evidence. Optional self-review may improve the wording, but a rejected revision must preserve the original checked answer.

Improvement decisions use the returned outcome and explanation: routing applied, already current, advisory reviewed, dismissed, or already decided. Requesting a code fix shows its real investigation stage. Tested, merged, deployed, and owner-confirmed are separate states. Keep failures beside the action, preserve a recoverable open proposal, and discard receipts from an old authenticated session. See the [behavior review](behavior-review-2026-10-03.md) and [improvement flow](self-improvement-flow.md).

**Target:** task updates should be meaningful changes: a discovered option, material problem, completed result, necessary decision, or deadline risk. Routine tool retries, provider names, segmentation work, and successful maintenance belong in Activity/diagnostics. Do not flood the main conversation with operational acknowledgments.

Use conditional initiative: “The flight moved to 07:00. That leaves less time for the connection. Want me to check alternatives?” A notice explains relevance and offers a next step. It does not imply the owner authorized a booking. Personalization should be helpful and editable, with a clear path to why a fact was recalled and to correcting or forgetting it.

**Target:** resolve related events into one useful interaction. A hotel confirmation, flight change, and calendar update about the same trip should refer to the same situation, rather than starting three disconnected conversations. Context continuity should survive a paused task and a model change because it lives in durable records, not only in a prompt.

### Initiative and attention

The design distinguishes a retained observation, an in-app suggestion, a chat notice, a push, and an urgent interruption. Use the least interruptive surface that still meets the situation. Suppress unchanged duplicates; retain unannounced material changes for later; respect explicit quiet hours and notification preferences.

**Target:** add clear “less like this,” snooze, and source controls to proactive notices. Measure whether the notice helped, rather than optimizing how often it was emitted. Learn attention preferences from explicit feedback first. Sensitive inferred facts should remain reviewable and should not become surprising push text.

### Voice

Dictation and Talk have different jobs. Dictation fills editable input and the owner sends it. Talk is an explicitly entered hands-free session with visible listening, thinking, speaking, stopped, and paused-for-decision states. A visible entry and exit matter as much as the microphone waveform.

Stop listening while a real approval or budget decision requires review. Spoken acknowledgment is not approval for an exact outbound action. Going to the background stops the session. Interruption, headset changes, speech permissions, echo, and recovery need physical-device validation; compiler success cannot establish those behaviors.

## Page-specific design standards

| Page or area | Main question it answers | Dominant design responsibility |
| --- | --- | --- |
| Chat | What are we discussing, and what happens next? | Reading, editable composer, continuity, grounded cards/decisions |
| Activity | What work is underway or blocked? | Status groups, useful progress, inline evidence, cancel/recover |
| Goals | What outcomes are we moving toward? | Deadline, next action, actual progress, blocked-on-owner state |
| Approvals | Which concrete decisions need me? | Exact action scope and one authoritative resolution |
| Chats | Where did this work/discussion happen? | Primary vs work/notification chats, stable titles, archive clarity |
| Memory home | What do you know, and what needs review? | Trust, useful entry points, modest graph preview |
| Memory library/detail | Is this fact current and accurate? | Source, correction, confirmation, pin/forget, bounded search |
| Knowledge map | How are people, places and events related? | Focused relationships and accessible list alternatives |
| Open loops | What remains unresolved? | Promise/question/decision/waiting-on semantics, next step, snooze |
| Profile summary | What personal context do you use? | Inspectable compact context and pinning criteria |
| Writing voice | How do drafts sound like me? | Owner-authored evidence, editable profile, sample deletion scope |
| Tidy up | Which memory issues need action? | Source-backed trust/currentness/projection review |
| Your data | How can I inspect and remove retention? | Export scope and precise forgetting consequences |
| Cards | Where is the useful record? | Scan ticket/booking/order content, currentness and source |
| Situation Packs | What is the plan around this situation? | Timeline, linked evidence, decisions, versioned rehearsal |
| People/detail | Who is this and what matters about them? | Identity/aliases, verified communication targets, occasions |
| More | How does my assistant work for me? | Coherent preference, connection, workspace, diagnostic groups |
| Settings (web) | How do I connect the phone? | Focused pairing and links to security |
| Security (web) | Who can access the installation? | Passkeys/devices/sessions/recovery, explicit revoke scope |
| AI providers | Which connection/model is used? | Credential presence without exposure, model vs role vs voice |
| MCP | Which tools can be used? | Connection health, available abilities, capability limits |
| Calls/detail | What is happening on the call? | Foreground live state, transcript, clear missing/stale recovery |
| Capabilities | What is enabled and ready? | Configured vs working distinction and useful setup guidance |
| Documents/import | What was processed and retained? | Progress, source provenance, failures, delete scope |
| Skills | What procedures can be followed? | Inspect/edit instructions, provenance, advisory scope |
| Costs | What did this work cost? | Actual vs estimated/unavailable, overlap, enforceable budgets |
| Anomalies | Which evidence needs investigation? | Specific unusual behavior and actionable evidence |
| Improvements | What change is proposed, tested or released? | Separate proposal, evaluation, PR, check, merge, deploy states |
| Audit/detail | What actually happened? | Readable evidence hierarchy, filters, limited diagnostic fetching |
| Setup/sign in/connection | How do I get into my own assistant? | Clear prerequisites, recovery, consumer language |

## Performance is part of design

Do not make the owner wait for unrelated data. Page-specific reads should match the screen: pairing does not need all passkeys and sessions, and an audit index does not need to prefetch 100 full investigations. Keep heavy renderer styles/assets outside an administration shell that never renders them.

Streaming must not regroup the whole transcript at token frequency. Keep expensive transforms behind memoization boundaries, preserve row identity, and avoid per-token programmatic scrolling that fights the reader. Poll only when foreground and useful; cancel promptly, back off on failures, and preserve an actionable stale-data state.

The map draws its initial seed immediately and prepares force layout outside the interface thread. Adopt only the current snapshot, keep the owner's camera, and defer still-layout replacement while a finger owns navigation. Reduced Motion receives a still result. The live solver and drawing still need device frame measurements; see [map performance](../apps/ios/docs/graph-performance.md).

A notification must restore the conversation that contains its information. Resolve its identity through authenticated state, defer navigation while a reply settles, and let a newer deliberate selection win. Unavailable destinations need a readable recovery path. Saving an in-app notice and presenting a phone alert are separate outcomes.

**Target:** measure time to first useful screen and first visible reply token, request count/bytes, large-list memory, frame pacing while streaming, and polling wakeups in active/idle/background states. Keep real-device measures distinct from synthetic screenshot timing and compile checks. Set numeric budgets from representative device traces, not from an unmeasured promise.

## Review and maintenance

For each change, review its final content in light and dark, narrow and wide layouts, keyboard/accessibility navigation, empty/error/pending states, and long labels. Native additions also need large Dynamic Type, VoiceOver, Reduced Motion, keyboard/safe areas, and scene transitions. Stateful controls need behavioral verification, not only screenshots.

The October 3 review covers 96 console layouts across four widths and light/dark, 204 static retained-product layouts, hydrated form recovery and settled conversation layouts. The console checks keyboard navigation, appearance changes, enlarged text, guarded credential actions and acknowledged changes followed by failed refreshes. Native pages, editors and detail views now receive actual isolated simulator captures in both appearances, including large text and lower scroll positions. Exact inventories, executed test results and remaining device checks belong in the [dated visual review](audits/ui-review-2026-10-03.md). Hosted renders establish visual behavior; physical audio, native touch gestures, VoiceOver traversal and live performance still require their own evidence.

Keep shared roles in semantic helpers, document a necessary exception at its source, and update this guide and the page audit when behavior changes. A new page must have a defined purpose, state contract, performance plan, and current source of truth before it becomes another item in navigation.
