# Assistant product intent and page guide

Assistant is a personal, conversational assistant that maintains continuity with its owner, remembers useful context, watches connected information, and carries work forward over time. The owner should be able to describe an outcome in ordinary language, see what the assistant is doing, and make the decisions that require their judgment without managing the underlying systems.

This guide expands the product brief into a description of the current application and its intended experience. It covers every web page in this checkout and the corresponding native iOS destinations, including settings, detail screens, and supporting flows. It is for product work, onboarding, design, and engineering. [System architecture](system-reference.md) explains the implementation; [capabilities](capability-reference.md) explains what the assistant can do; [gaps](product-gaps.md) records differences between the brief and the code.

Reviewed against repository source on **October 2, 2026**. “Implemented” describes code present in this checkout, not proof that a feature is enabled, deployed, or physically tested on an iPhone. Availability depends on the selected persistence backend, enabled modules, credentials, and client build. Existing deployment reports retain their own dates.

## Product intent

### One continuing relationship

The primary experience is one continuing conversation rather than a collection of unrelated prompts. Assistant learns the owner's preferences, people, commitments, and working context, and can connect a new question to earlier discussion. The transcript can grow while the context sent to a model remains bounded.

The promise is continuity with evidence, rather than perfect recollection. Relevant earlier discussion can be retrieved when automatic recall is enabled. Durable facts and a compact profile support personalization. Fresh external information still requires a current lookup: remembering a hotel preference does not establish present availability or price.

### Conversation as the front door

The owner can type, dictate into an editable composer, or enter a deliberate hands-free conversation on iPhone. Replies may contain prose, useful cards, suggestions, or decisions. Speech offers another presentation of those replies. The conversation should use familiar language and keep routine maintenance details out of the owner's way.

A request can be answered immediately or become durable work. “What did we decide about the trip?” is retrieval. “Find options and keep working toward booking the trip by Friday” can become a goal and its work sessions. “Remind me tomorrow” creates a timed reminder. These are different responsibilities even when all three start in chat.

### Useful initiative

Assistant can notice important mail, upcoming events, calendar changes, outstanding commitments, watched content, and gaps in what it knows. It should say why the information matters and propose a useful next step. Silence is appropriate when there is no meaningful news.

An observation, a suggestion, and permission to act are separate. “Your itinerary changed” is information. “Want me to check a later connection?” is a suggestion. Sending a message or changing a booking requires the corresponding execution and approval path. A remembered preference is evidence about the owner, not blanket permission to spend money or contact someone.

### Visible and adjustable autonomy

The owner should choose how independently Assistant works. Current code supports individual approvals, standing rules for eligible actions, and bounded autonomy grants. The current iPhone control is **Auto next**, not a persistent unlimited YOLO switch. A grant belongs to a task, normally expires after 24 hours, and preserves specific approval floors, forbidden actions, recipient checks, and budgets.

### Owner control and ownership

The owner can inspect, correct, confirm, pin, and forget remembered information; inspect activity and evidence; pause recurring work; and manage connections. The self-hosting direction is an installation whose infrastructure, credentials, billing, and data belong to the owner. The complete consumer installation and Firestore cutover remain separate unfinished delivery work; see the gap register.

## Core concepts

| Concept | Meaning | Example |
| --- | --- | --- |
| Primary conversation | The stable default owner thread | Everyday conversation with Assistant |
| Side chat | A separate visible conversation | A goal's work chat or a deliberately created new chat |
| Task | A durable unit of work with status, budget, and execution evidence | Research three options or send an approved message |
| Goal | An outcome pursued across work sessions | Organize a trip before a target date |
| Mission | Runtime work pursuing a goal | Today's bounded session researching the trip |
| Schedule | A future or recurring trigger | A daily briefing or goal check-in |
| Reminder | A schedule whose purpose is to notify the owner | A one-time sunglasses reminder tomorrow |
| Approval | Permission for a concrete queued action or another specific decision | Send this exact email to these recipients |
| Standing approval | A saved rule permitting eligible matching actions | Allow future calls to one reviewed MCP tool |
| Suggestion | An inert proposal that can be accepted, dismissed, or snoozed | Investigate a calendar conflict |
| Memory | A saved fact, preference, episode, or experience with lifecycle metadata | The owner's preferred airport |
| Conversation segment | A summary/index over a run of historical messages | The discussion in which an itinerary was chosen |
| Knowledge graph | Source-backed entities and direct relationships derived from memory | A person works at an organization |
| Owner profile summary | A compiled selection of important and pinned facts for permitted prompts | Identity, preferences, and important people |
| Open loop | A decision, question, promise, or dependency still being held | Waiting for a friend's confirmation |
| Saved card | A grounded, revisioned presentation of useful information | A ticket, booking, delivery, or score |
| Situation pack | A bounded plan connecting saved cards, commitments, and decision reasons | A weekend plan with dependencies |
| Skill | Advisory procedural knowledge used during planning | A reliable process for completing a recurring task |

The same underlying record can appear in several places. An approval in chat, Activity, and Approvals is one decision. A person in People and the memory map is one related body of knowledge. A saved card can appear in chat, Cards, and a Situation Pack without becoming three independent facts.

## Application navigation

### iPhone

The app opens into chat and uses a pull-revealed directory rather than persistent navigation chrome. Its nine destinations are Chat, Activity, Goals, Approvals, Chats, Memory, Cards, People, and More. More contains lower-frequency settings and workspace areas. Detail pages generally open inside the destination's navigation stack or a sheet.

The app targets iOS 26. It uses native text interaction, supports accessibility features including Dynamic Type and Reduce Motion, and keeps the agent runtime on the server. A connected phone is a client, not a background agent host. Background work continues on the server when the app closes.

### Web

The browser is currently an **owner administration console**. `/` lands on `/settings`; the proxy exposes Settings and Audit, with Security, Setup, and Sign in in passkey mode. The 27 retained product/legacy page implementations (including `/chat`, Activity, Goals and Memory) redirect browser GET/HEAD requests to Settings and reject their page mutations. Everyday conversation and work are available through the native iPhone client and authenticated mobile APIs. The page descriptions below document the native experience and retained component behavior; they do not imply those browser routes are reachable. See the current [web audit](audits/web-experience-2026-10-02.md).

Sources: [iOS shell](../apps/ios/Assistant/Views/ChatView.swift), [iOS root](../apps/ios/Assistant/Views/RootView.swift), [web entry](../apps/web/app/page.tsx), [route policy](../apps/web/proxy.ts), [web Settings](../apps/web/app/settings/page.tsx).

## Chat

**Retained web implementation (currently redirected):** `/chat`, `/chat/[id]`. **iOS:** Chat.

The main page supports a continuing exchange with a composer at the bottom, streamed answers, work status, and inline decisions. The primary conversation is selected through a persistent primary flag; opening `/chat` does not create a fresh chat each time. Explicit side chats remain available through Chats.

The UI displays structured message parts such as grounded cards, recall provenance, approvals, budget requests, suggestions, and notices. A card can carry the answer itself, or head prose that adds explanation. The presence of a visual card is not proof of successful execution; its facts and actions come from the server's evidence and persisted state.

Current actions include sending a message, choosing a model for the conversation, answering a displayed decision, accepting or snoozing a suggestion, opening associated work, and hiding a message from the log. Hidden messages remain stored, can be restored, and are excluded from the history supplied to the model. Hiding is therefore curation, not erasure.

For ordinary conversation, a tool-free streaming path can produce a reply. Requests needing information from a service or an action use the durable executor. Execution can continue after the screen closes, pause for a decision, and report back to the originating chat. Failed owner-requested work should receive a short understandable explanation; raw diagnostics belong in Activity and audit records.

Unsent native drafts are stored separately for each chat within the current authenticated app session. Changing chats restores the appropriate draft. A failed send restores automatically into an empty composer; it preserves a newer follow-up and offers recovery after that draft is sent or cleared. These drafts stay in memory on the phone and do not survive app termination. Changing the server/account clears them. Dictation stops when leaving the visible conversation and cannot write into another chat.

### How a long conversation stays bounded

The conversational stream currently considers at most 40 history messages and caps history at 64 KiB. Other workflow contexts have their own limits and compaction. Those are implementation budgets, not a rule that every 40 messages the entire transcript is discarded.

Offline segmentation groups older messages using time gaps, semantic drift, and a maximum group size, then summarizes and embeds settled groups. Current defaults include a six-hour gap, a 24-message maximum, and a 30-minute settling period. When enabled, recall searches segment summaries first and falls back to message neighborhoods. It excludes the recent window already in the prompt and returns nothing when similarity is too low. Current historical-recall defaults are four entries, minimum similarity 0.75, and an 1,800-character block.

Durable-memory extraction is a separate operation that identifies useful facts and experiences. The knowledge graph is another derived index over source-backed durable memories. These processes are not one “summarize everything and put it in RAG” step. Transcript retention is separately configurable.

### Dictation and Talk mode

On iPhone, tapping the microphone begins dictation into the composer; a second tap stops it. Holding the control listens while it is held. Dictated words are editable and are not sent until the owner sends them. Transcription uses on-device SpeechAnalyzer, with language assets managed by iOS.

Hands-free **Talk mode** is a separate full-screen flow reached through the microphone's “Talk to the assistant” accessibility action. It listens, detects the end of a turn, sends it, speaks the answer, and listens again. It supports interruption and does not turn spoken assent into permission for an approval: it announces that a decision is waiting.

Read-aloud uses on-device speech synthesis. Speak replies aloud is a preference, and a reply can also be spoken from its long-press menu. A spoken presentation skips unsuitable formatting and protects sensitive content. The realtime voice model selected under AI providers serves outgoing phone calls; it is distinct from iPhone dictation and read-aloud.

Sources: [chat turns](../packages/application/src/chat-turn.ts), [history recall](../packages/core/src/memory/recall.ts), [segmentation](../packages/core/src/memory/segmentation.ts), [iOS speech and Talk mode](../apps/ios/README.md), [chat copy rules](chat-voice.md).

## Activity

**Retained web implementation (currently redirected):** `/tasks`. **iOS:** Activity.

Activity is the operational view of work: what needs the owner, what is working, what is waiting for time or another event, and what has finished. It brings approvals and task status into one work-oriented list. It is not the complete list of future recurring schedule definitions; those also live under More and Goals.

Task states distinguish pending, running, waiting for approval, waiting for an event, sleeping, waiting for budget, completed, failed, needing attention, and cancelled. The screen turns these into readable groupings. A task sleeping until tomorrow differs from one that cannot continue without the owner. Completion status must reflect the task outcome, rather than the disappearance of a spinner.

The native Activity view exposes task evidence and controls inline, with navigation to related chat or goal; the retained web implementation has a dedicated task detail page. The owner can inspect completed or archived history. Terminal activity can be archived and restored. Archiving hides a record from the current list while retaining its evidence.

### Activity details

**Retained web implementation:** `/tasks/[id]` (redirected by current browser policy). **iOS:** inline task evidence, cards and controls in Activity; no separate single-task destination.

The detail explains the requested work, status, progress, next step, budget and autonomy state, and what actually happened. It exposes tool activity and produced files where available. Applicable controls allow the owner to cancel work, resume or retry eligible parked work, change a budget, or revoke autonomy. The raw task and tool history support diagnosis even when chat contains only a brief explanation.

Sources: [Activity list](../apps/web/app/tasks/page.tsx), [task details](../apps/web/app/tasks/[id]/page.tsx), [task lifecycle](../packages/core/src/workflow/machine.ts), [iOS Activity](../apps/ios/Assistant/Views/ActivityView.swift).

## Goals

**Retained web implementation (currently redirected):** `/goals`. **iOS:** Goals, goal editor, and goal work chat.

Goals represent outcomes to keep moving toward, optionally by a target date. Each has a title, description, priority, status, progress note, and next action. Active, paused, completed, and stopped outcomes are distinct; archival is an additional visibility choice.

The owner can create and edit a goal, choose its target date, adjust its automation cadence, request work, pause or resume it, and inspect its work chat. Goal automation starts bounded work sessions rather than one permanently running model call. The dashboard highlights goals blocked on the owner and shows the next check-in when appropriate.

A goal can opt into bounded autonomous work. Sensitive actions still ask. A deadline supplies planning context and prioritization; it does not guarantee that an external outcome can be achieved on time. Reported progress should be tied to work and evidence, rather than an elapsed-time percentage.

Current background goal updates live in the goal work chat. The optional mirror sends selected updates into the **Notifications** conversation. Despite the legacy `mirrorToPrimary` field name, it does not currently summarize every goal chat into the primary owner conversation. Automatic side-chat roll-ups remain a product gap.

Sources: [Goals page](../apps/web/app/goals/page.tsx), [goal card controls](../apps/web/app/goals/goal-card.tsx), [mission runtime](../packages/core/src/workflow/missions.ts), [mirror contract](../packages/core/src/mission-mirror.test.ts), [iOS Goals](../apps/ios/Assistant/Views/GoalsView.swift).

## Approvals

**Retained web implementation (currently redirected):** `/approvals`, inline chat cards. **iOS:** Approvals, review sheets, and notification actions.

Approvals is a dedicated decision inbox. It shows pending requests and resolved decisions with the action summary, identity, timing, and underlying payload. Its overlap with Activity is intentional: Activity explains the work, while Approvals concentrates the decisions that can unblock it.

The owner can approve or deny a pending request. Where supported, the payload can be reviewed or edited through the corresponding decision surface. Approvals have expiry and stale-state checks. Approving authorizes the recorded action; it does not override a spending limit or prove that the external provider completed the action.

Eligible approval cards offer **Always approve**, followed by review of the proposed standing permission. A saved policy may permit future matching calls. Some tools prohibit blanket rules. MCP standing permissions are tied to a reviewed connection/tool definition; changing that scope requires fresh permission. Calls and high-consequence operations retain their specific protections.

The same decision appears in chat, the inbox, Activity, and sometimes a notification. A successful decision must update all of these representations. On iPhone, notification approval actions require device unlock. Notification delivery is not the authority for the decision; the server applies it.

Sources: [Approvals page](../apps/web/app/approvals/page.tsx), [approval card](../apps/web/app/approvals/approval-card.tsx), [standing-rule flow](../apps/web/app/approvals/always-approve-button.tsx), [dispatcher](../packages/tools/src/dispatcher.ts), [iOS Approvals](../apps/ios/Assistant/Views/ApprovalsView.swift).

## Chats

**Retained web implementation (currently redirected):** `/chat/all`. **iOS:** Chats.

Chats lists the primary conversation and separate conversations, including goal work and Notifications. The owner can open a chat, create a side chat, and manage archived conversations. The primary conversation cannot be archived through the ordinary archive action.

The current native client coordinates one active foreground reply. Opening or creating another chat waits for the reply to finish or be stopped; directory controls explain that condition. A late conversation read cannot override a newer navigation or a reply that started while the read was pending. Durable server work can continue independently.

Side chats are visible workspaces, not hidden topic buckets chosen by a router. Automatic historical recall can span eligible owner conversations when enabled, so a later question can reach information discussed in a side chat. That retrieval differs from automatically posting a summary into the main transcript.

The Notifications conversation is a discoverable log for background work. Routine background failures and repair status can be recorded there without interrupting the primary conversation or sending a phone alert. Owner-requested results and meaningful proactive information follow their own delivery paths.

Sources: [All chats](../apps/web/app/chat/all/page.tsx), [conversation commands](../apps/web/app/chat/actions.ts), [background notices](../packages/core/src/workflow/executor/notices.ts).

## Memory

**Retained web implementation (currently redirected):** `/profile`, `/profile/memories`, `/profile/knowledge`. **iOS:** Memory.

Memory is the owner-facing view of what Assistant knows, how that knowledge is organized, and what needs review. The native home combines a map preview, held-for-review memories, a small selection of facts, and links to deeper controls. Health counts describe lifecycle states such as in use, awaiting review, not yet organized, and owner confirmed; they are not a measured truth score.

Facts can concern identity, work, home, relationships, preferences, health, or other topics. A fact can be pinned into the compact profile, explicitly confirmed, edited, or forgotten. Confirmation of a fact and confirmation of a relationship extracted from it are related but separate review operations.

Important distinctions: message history is the record of a conversation; a segment summarizes a discussion; a durable memory is a selected fact or experience; the graph expresses source-backed relationships; the profile summary is a selected prompt projection. The map is not a visualization of every row in a vector database.

### Memory library

**Retained web implementation (currently redirected):** `/profile/knowledge?view=library`; legacy library links through `/profile/memories` redirect as appropriate. **iOS:** See all / memory library.

The library provides the fuller list of saved facts, search and filters, review state, subject, and graph projection status. The owner can inspect a fact and its origins, correct it, confirm or reject held information, pin or unpin it, and forget it. Source-impact controls explain the graph connections removed when a source memory is forgotten.

“In use” means usable by the memory system under its context and trust rules. It does not mean that every fact is inserted into every model prompt. Quarantined information stays out until its review is resolved.

### Knowledge map and relationship details

**Retained web implementation (currently redirected):** `/profile/knowledge?view=map`. **iOS:** full-screen relationship map, entity detail, People connections.

The graph contains people, organizations, projects, places, events, dates, and topics. Relationships retain the original supporting fact, confidence, review state, and where applicable temporal bounds. A connection can be confirmed or marked stale. Entities can be renamed, retyped where valid, or merged; aliases preserve reconciliation identity.

The owner can add a relationship with a source note. This note becomes ordinary durable memory and evidence for the relationship. A graph-only assertion without a source is not the intended model. Date identity is canonical, so a label change does not turn a date into a different kind of entity.

The current web map offers starting points, focused connections, a whole-map overview, and Map/List presentations. The list expands a relationship tree without requiring the spatial drawing. Native graph controls have their own visualization and entity navigation. Two-hop context can aid retrieval but is not itself proof of a newly inferred relationship.

### Open Loops

**Retained web implementation (currently redirected):** Open loops panel in `/profile`. **iOS:** Memory → Open loops.

Open Loops is the desk of unresolved follow-through captured from owner conversations. It holds four kinds:

- **Decision:** a choice or settled direction worth retaining.
- **Question:** something still unanswered.
- **Promise:** a concrete follow-up the owner said they would do.
- **Waiting on:** a reply, approval, document, or other dependency from someone else.

For example, “I promised Anna the itinerary” is a promise, while “Anna will send her dates” is waiting on. Neither is automatically a task or reminder. A loop provides context for follow-through; executing the next action requires the usual request or accepted suggestion.

The owner can mark a loop Done, use Later to snooze it for a day, Correct its description or next step, or dismiss it as Not relevant. Untouched loops retire according to kind: decisions after 90 days, questions and waiting-on items after 30, promises after 45. A dated loop retires two weeks after its due date. Retirement means stale, not proof the commitment was fulfilled.

### Profile summary and About you

**Retained web implementation (currently redirected):** `/profile/about`. **iOS:** Memory → Profile summary.

The profile exposes the compact owner card that permitted conversation prompts use before deeper retrieval. It also exposes the underlying owner facts by life domain. The owner can add or edit facts, pin them, confirm them, and request a refresh of the summary. Native profile maintenance also exposes organization controls.

Compilation is deterministic: pinned owner facts lead, with a small selection of high-importance current facts per domain and a limited list of important people. Most ordinary facts stay in memory for retrieval. Private profile context is withheld from external-sender and tainted workflows. “Always kept in context” therefore means eligible compact profile context, not the entire knowledge graph or unconditional access for every task.

### Writing voice

**Retained web implementation (currently redirected):** `/profile/voice`. **iOS:** Memory → Writing voice, sample/import and editing flows.

Writing voice describes how the owner writes when Assistant drafts on their behalf: tone, phrasing, structure, and habits distilled from suitable owner-authored samples. It is separate from Assistant's conversational personality and from audible speech.

The page shows the learned profile and sample counts, supports supplying examples and editing the profile, and exposes controls to remove learned/uploaded samples. Sample deletion can preserve the distilled profile where the control explicitly says so. Removing the full long-term memory has a broader effect. Third-party text must not become a writing sample merely because it was read during a task.

The native writing-voice editor requires a successful initial read before editing or saving. Failure offers retry instead of a writable blank profile. Failed saves preserve entries. Memory export and erasure serialize their actions and report the actual response.

### Tidy up the map

**Retained web implementation (currently redirected):** `/profile/knowledge?view=cleanup`. **iOS:** Memory → Tidy up the map.

Cleanup organizes findings into trust/review, keeping facts current, and graph projection health. It surfaces quarantined memories, unreviewed or rejected connections, expired and superseded facts, disconnected projection data, and failed source processing. The owner can resolve review items, retry eligible failures, and remove disconnected derived data.

Cleanup is maintenance over evidence and indexing state. It should not silently rewrite uncertain facts into confident truths. Graph source retries can require paid extraction; cost and backlog information belong in the review flow. “Projection health” concerns the derived map and differs from forgetting source memories.

### Your data

**Retained web implementation (currently redirected):** `/profile/data`, export endpoint `/api/profile-export`. **iOS:** Memory → Your data.

The owner can export long-term-memory data and request long-term-memory erasure. The export includes saved facts, graph projections, people profiles, writing samples/profile, the compiled recall card, and Situation Packs with decision reasons. It excludes secrets and internal embeddings. This is a memory export, not a full database or disaster-recovery backup.

Erasure removes the relevant remembered data and derived projections and keeps tombstones so the same source does not immediately teach the forgotten fact again. Pack decision memory is erased while explicit planning items have distinct retention. Workspace cleanup uses a recoverable durable process. Erasure is not equivalent to hiding a chat row, archiving a goal, deleting every conversation, or revoking an external provider account.

Sources: [Memory home](../apps/ios/Assistant/Views/MemoryView.swift), [web memory hub](../apps/web/app/profile/page.tsx), [Knowledge workspace](../apps/web/app/profile/knowledge/page.tsx), [Open Loops](../apps/ios/Assistant/Views/CommitmentsView.swift), [commitment lifecycle](../packages/core/src/memory/commitments.ts), [owner-card compilation](../packages/core/src/memory/consolidation.ts), [privacy export](../packages/application/src/profile/privacy-export.ts), [privacy erasure](../packages/application/src/profile/privacy-erasure.ts).

## Cards

**Retained web implementation (currently redirected):** `/cards`. **iOS:** Cards and saved-card detail/actions.

Cards gathers useful structured information already shaped by Assistant: tickets, travel, bookings, events, deliveries, sports scores, and other grounded answers. Connected mail can supply relevant information; conversation lookups can produce cards too. The stored model supports revisions, freshness, refresh status, and evidence-based presentation.

The owner can open a card, use its permitted actions, refresh supported information, or dismiss it. A refresh starts ordinary work and needs current evidence; it is not permission to invent a new flight time or silently change a booking. Sensitive facts have protected presentation. A saved card is not automatically an Apple Wallet pass, a payment instrument, or live access to a reservation system.

Sources: [Cards page](../apps/web/app/cards/page.tsx), [saved-card controls](../apps/web/app/cards/saved-card-grid.tsx), [card compilation](../packages/core/src/generative-card.ts), [generated UI](generative-ui.md).

## Situation Packs

**Retained web implementation (currently redirected):** `/packs`. **iOS:** Cards → Situation packs and pack editing/rehearsal.

A Situation Pack holds a bounded plan alongside its source cards, commitments, dependencies, and choice reasons. Its lanes are Plan, I owe, and Waiting on. It allows the owner to keep “what happens next” and “why we chose this” together without creating another execution engine.

The owner can create a pack, attach existing cards or commitments, add explicitly labeled planning notes, record choices and reasons, edit an item, and rehearse a proposed change. Rehearsal shows before/after state, affected dependents, and unknowns. Applying updates planning state and marks dependent items for review; it does not modify the actual booking, reminder, calendar, or message.

Packs observe changes in stored card revisions and commitment state. A changed source can produce a review suggestion through the proactive system. A lasting preference requires explicit confirmation; situation-only choice memory is the default. “Discuss next steps” prepares a chat draft, leaving sending to the owner.

Limits are deliberate: up to 30 items and 30 decision reasons per pack, bounded recent lists, version checks, and 24-hour previews bound to source fingerprints. This is grounded planning, not an arbitrary simulator of real-world consequences.

Sources: [Situation Packs contract](situation-packs.md), [pack use cases](../packages/core/src/situations.ts), [web pack editor](../apps/web/app/packs/packs-panel.tsx), [iOS packs](../apps/ios/Assistant/Views/SituationPacksView.swift).

## People

**Retained web implementation (currently redirected):** `/people`, `/people/[id]`. **iOS:** People and person detail/connections.

People is a person-centered view of contacts, remembered facts, relationships, recent interactions, and important dates. It overlaps the graph by design but adds communication identity and contact management. Search and grouping help find a person; upcoming occasions provide timely context.

A person detail shows identity, relationship to the owner, saved facts, direct and related connections, events, and occasions. Applicable controls edit contact details or relationship, manage known status, merge duplicates, and add or review birthdays and anniversaries. The legacy `/profile/people/[id]` route redirects here.

Being listed does not establish that every statement from that person is trusted or that the assistant may contact them without a decision. Known-contact status participates in trust and recipient checks; it is not unrestricted authority. Dates extracted from sources may require review before becoming dependable personal context.

Sources: [People list](../apps/web/app/people/page.tsx), [person detail](../apps/web/app/people/[id]/page.tsx), [occasion management](../apps/web/app/people/occasions-panel.tsx), [native People](../apps/ios/Assistant/Views/PeopleView.swift).

## Settings and More

**Web:** `/settings`. **iOS:** More.

Native More contains assistant language/time settings, notifications, reminders, appearance, speech, server connection, AI providers, Calls, MCP connections, the current chat model, location controls, workspace pages, recurring jobs, and standing approvals. The current web Settings page concentrates on mobile pairing and access security. Existing web provider/MCP components do not establish that those panels are mounted in the current Settings page.

### Assistant identity and language

Edit assistant settings exposes timezone, locale, and signature. The assistant uses this information for local time interpretation, scheduling, and presentation. The owner's identity, assistant identity, and provider credentials are separate concepts. Locale selection does not promise that every piece of interface copy is translated.

### iOS notifications

Notification controls request system permission and show its state. Local notifications depend on work the app can observe while running. Remote APNs notifications can reach a closed app when the push module and credentials are configured. Routine foreground updates are suppressed to avoid duplicate banners; approval attention has a distinct path. The badge tracks pending approvals, and Live Activities show ongoing work and decision waits.

Chat notifications carry the owner and conversation identity when available. Tapping one loads the destination through the authenticated server, waits for initial connection or an active reply to settle, and opens that conversation. Older route-only notifications return to the main conversation. A foreign-owner notice is ignored; an unavailable conversation returns to the authenticated main conversation with an explanation. Device and APNs verification remain required before treating this source change as shipped behavior.

Server nudge policy distinguishes ambient information from interrupt-level attention. Quiet hours and a shared daily ambient cap can hold phone interruptions without deleting the corresponding in-app information. Those policy preferences are opt-in; absence of settings is not a default silent-hours guarantee.

### Reminders

Reminders shows active one-time and recurring alerts, next firing time, and whether delivery is already queued. Ordinary conversational reminder requests default to one-time. Recurrence must be expressed or selected deliberately.

The owner can remove a reminder. Cancellation stops queued and future alerts through server state and worker rechecks. Earlier messages remain in the conversation. A successful removal is based on a confirmed cancellation, not optimistic disappearance from a list.

### Appearance

The iPhone offers System, Light, and Dark. The current stored default is Dark. This is a device preference; System follows the phone's setting. Accessibility contrast and motion behavior should continue to work across themes.

### Speech

The owner can enable spoken replies, adjust speed, and choose among installed usable voices. Best installed is an automatic choice; better system voices may need a download through iOS settings. These preferences belong to the phone. Enabling automatic speech makes replies audible even with the ringer off, as the UI states.

### Assistant server

The connection screen stores the server URL and a **mobile access credential** in Keychain. This credential authenticates the phone to its own assistant server. It is not a model-provider API key. Web pairing can issue or rotate a shared mobile token in the existing auth mode; passkey mode supports separately revocable device keys.

The connection flow supports onboarding, checking access, updating the connection, and disconnecting. A reachable server, a valid mobile credential, and a configured model provider are different readiness checks.

### AI providers and model choices

The provider screen manages connections, their models, main/fast text choices, and a realtime voice model for phone calls. Supported provider families include OpenRouter, direct OpenAI, Google Vertex AI, and explicitly configured OpenAI-compatible gateways. Credentials are encrypted on the server and are not returned to the phone.

The owner can add a provider, inspect or refresh its model list, enable or disable it, add/manage catalog models, and choose appropriate models. A conversation-level model override is separate from defaults for internal planning/background roles. Embedding changes require a data migration, not an ordinary chat-model switch.

### MCP connections

The owner can name and add a Streamable HTTP endpoint, provide an optional bearer credential, discover its tools, refresh, enable/pause, or remove the connection. Production endpoints must satisfy the public-network boundary. OAuth authorization is not implemented here.

Remote descriptions and results are untrusted. Calls initially require review; an eligible Always approve flow can save permission for one reviewed tool scope. Changed endpoints, credentials, or tool definitions invalidate that previous scope. A listed MCP connection does not grant general access to every remote account.

### Current chat model

More includes Automatic and the eligible enabled models for the active conversation. Changing this sets a conversation override. Automatic returns to role routing. Provider availability and budgets still apply.

Current-chat model changes wait for the active reply to finish or be stopped. AI providers preserves unsaved main/fast selections independently across refreshes. Existing MCP connections appear before an expandable add form; tool review follows active approval policy rather than a promise that autonomous operation always asks.

### Share iPhone location and background arrival nudges

Location sharing is opt-in and requests OS permission when enabled. The server receives short-lived position pings and a device timezone for relevant owner-private context. Current location is considered fresh for 30 minutes; pings default to three-day retention and do not become semantic long-term location history.

Background arrival nudges separately opt into coarse significant-change monitoring and require Always location access for background use. The app sends throttled wake pings; the server decides whether a useful tip is warranted. This is not continuous precision tracking, and the map of remembered places does not automatically contain every place the phone visited.

### Recurring jobs and standing approvals

Recurring jobs exposes server schedules and pause/resume controls. Goal automation is managed in Goals, and reminders have their own screen. Standing approvals lists saved permission rules with enable/pause and deletion controls. Editing a schedule changes when future work starts; it does not by itself cancel a task already executing. Removing a rule means future eligible actions ask again.

Sources: [More](../apps/ios/Assistant/Views/MoreView.swift), [connection](../apps/ios/Assistant/Views/ConnectionView.swift), [provider management](../apps/ios/Assistant/Views/AIProvidersView.swift), [settings use cases](../packages/application/src/settings-port.ts), [location policy](../packages/core/src/memory/location.ts), [nudge policy](../packages/core/src/proactive/nudge-policy.ts), [mobile access](../apps/ios/README.md).

## Calls

**Retained web implementation (currently redirected):** `/calls`, `/calls/[id]`. **iOS:** More → Calls and call detail.

Calls lists outgoing calls and exposes a live or completed call's status, outcome, notes, transcript, check-in questions, and approved brief. The owner can answer a live check-in or request hang-up. A call request starts in ordinary work, for example asking Assistant to call a restaurant.

Every call requires approval of the number, purpose, information it may share, commitments it may make, hard limits, time limit, and voicemail behavior. The service delivers a fixed AI/transcription disclosure. The realtime model sees the approved brief rather than the owner's entire memory and inbox. The transcript is stored; call audio is not recorded.

When a decision falls outside the brief, Assistant asks the owner through a check-in rather than inventing authorization. Finishing a call resumes the originating task. Third-party speech makes follow-up context untrusted, so another outward action may require a new approval. Calls require Twilio, a suitable realtime provider, budget, and configured number/country limits.

Sources: [phone calls](phone-calls.md), [Calls list](../apps/web/app/calls/page.tsx), [call detail](../apps/web/app/calls/[id]/page.tsx), [iOS Calls](../apps/ios/Assistant/Views/CallsView.swift).

## Capabilities

**Retained web implementation (currently redirected):** `/capabilities`. **iOS:** More → Capabilities.

Capabilities explains optional installed modules and their readiness: usable, disabled, setup needed, or unavailable. It helps distinguish a missing credential from a missing implementation. The base platform's chat, memory, contacts, goals, approvals, and budgets are different from optional service integrations.

Module selection is composed/configured on the server; this page is not a universal install button. Selecting a module without readiness does not give the model a functioning tool. Detailed families and the complete declared tool catalog are documented separately.

Sources: [Capabilities page](../apps/web/app/capabilities/page.tsx), [workspace projection](../packages/application/src/workspace-capabilities.ts), [optional modules](modules.md).

## Documents

**Retained web implementation (currently redirected):** `/documents`. **iOS:** More → Documents and document actions/upload.

Documents is the searchable file library. It records title, source, size/type, trust, extraction state, searchable passage count, and errors. The owner can upload a file, ask about its contents in chat, and use applicable retry/delete controls. Appropriate attachments can also be filed from connected mail.

Text and text-bearing PDFs can be extracted directly; heavier office formats and scans depend on the document processor and its actual format support. Extraction, chunking, and embedding create passage retrieval. This does not guarantee that every document is fully understood or automatically converted into durable personal graph facts.

The current upload limit is 25 MB. An enabled documents module and supported backend path are required. Firestore read/extraction support must not be confused with complete owner upload availability; the dedicated migration status records the limitation.

Sources: [Documents page](../apps/web/app/documents/page.tsx), [document pipeline](../packages/core/src/memory/documents.ts), [processor](../workers/document-processor/package.json), [Firestore status](firestore-implementation-status.md).

## Backstory import

**Retained web implementation (currently redirected):** `/import`. **iOS:** More → Documents includes backstory import/source management; Writing voice has its own sample-import flow. Import is not a separate primary destination.

Backstory import distills older archives into remembered context. Current parsers recognize mbox mail, supported JSON message exports, and text. This differs from filing a document for passage search and from importing an entire application database.

The page shows uploadable archives, ready files, import history, processing counts, errors, and review state. Source controls support eligible resume/retry, releasing or rejecting quarantined facts, removing an import's memories while keeping its file, or deleting the import and file. Bulk release is a meaningful trust decision, not an assertion that the archive's contents are verified.

Sources: [Import page](../apps/web/app/import/page.tsx), [source actions](../apps/web/app/import/source-card.tsx), [parsers](../packages/core/src/memory/import-parsers.ts).

## Skills

**Retained web implementation (currently redirected):** `/skills`. **iOS:** More → Skills and skill editor.

Skills are procedures learned from experience or supplied by the owner. They contain a name, preconditions, steps, gotchas, authorship/deprecation state, and usage/success/failure counts. The owner can create and edit skills and retire or restore applicable entries.

The planner reads skills as advice. A skill is not executable code, a schedule, or an approval exemption. Its proposed actions still pass through the tool dispatcher and risk rules. Learned skills can help repeat successful methods without giving model reflection permission to modify protected configuration.

Sources: [Skills page](../apps/web/app/skills/page.tsx), [skill controls](../apps/web/app/skills/skills-panel.tsx), [skill retrieval](../packages/core/src/memory/skills.ts), [reflection](../packages/core/src/memory/skill-reflect.ts).

## Costs

**Retained web implementation (currently redirected):** `/costs`. **iOS:** More → Costs.

Costs distinguishes provider billing from Assistant's operation ledger. Provider views can include OpenRouter spend and Google Cloud Billing exports; the local ledger attributes model and worker operations to tasks, sources, and models and shows in-progress reservations. The page exposes configured spending limits and expensive work.

These numbers cannot simply be added: a model or Cloud Run job can appear in both the provider report and the operation ledger. A budget reservation is a conservative hold before work, then settled to observed usage where available. Assistant limits protect its controlled operations and do not cap the provider's entire invoice.

Billing reads can be stale or unavailable; current-period usage is not necessarily a final invoice. Google reports require a configured BigQuery billing export and read permissions. Currency, credits, adjustments, and reporting scope matter when interpreting hosting cost.

Sources: [Costs page](../apps/web/app/costs/page.tsx), [cost tracking](cost-tracking.md), [budget implementation](../packages/core/src/cost.ts).

## Anomalies

**Retained web implementation (currently redirected):** `/anomalies`. **iOS:** More → Anomalies.

Anomalies currently flags unusual **approval-policy activity**, such as auto-execution far above a baseline, an outward action overnight, or a burst. Each finding records observed versus expected activity and related evidence. The owner can suspend the implicated rule or dismiss a false positive.

This is narrower than a universal detector of weird model behavior. Response checks, captured model-output audits, health monitoring, and repair reports cover other failure categories. An empty anomaly list does not establish that every model answer is correct.

Sources: [Anomalies page](../apps/web/app/anomalies/page.tsx), [finding controls](../apps/web/app/anomalies/anomaly-card.tsx), [scan](../packages/core/src/workflow/anomaly.ts).

## Improvements

**Retained web implementation (currently redirected):** `/improvements`. **iOS:** More → Improvements and report/repair detail.

Improvements holds model/behavior proposals and tracked code fixes. The owner can inspect rationale and evidence, apply supported model-role proposals, dismiss proposals, report an issue or feature request, request a code investigation, and run/retry eligible repair attempts.

Decision receipts distinguish an actual routing change from an advisory acknowledgment, an already current configuration, or a previous settled decision. Invalid proposals remain open with an explanation. Routing and proposal settlement commit together; repeated or competing clicks preserve the first decision. Code-fix requests link the actual report, including existing blocked or failed work, instead of always claiming a new investigation was queued. The complete [self-improvement flow](self-improvement-flow.md) explains evidence, recovery, spending, and the remaining measured-promotion/history gaps.

Repair tracks diagnosis, queue state, coding work, checks, PR status, deployment monitoring, and owner confirmation. The hosted and legacy worker paths have different setup requirements. A coding result is not a verified repair: repository CI must pass before a PR is presented as ready, and the owner reviews and merges it. This flow does not automatically merge or deploy.

Model reflection generates proposals and advisory learning; it does not authorize unrestricted modification of the running assistant. Code fixes are bounded, use synthetic briefs rather than raw private transcripts, and preserve protected paths and publication gates.

Sources: [Improvements page](../apps/web/app/improvements/page.tsx), [repair panel](../apps/web/app/improvements/repair-panel.tsx), [self repair](self-repair.md), [improvement review](../packages/core/src/workflow/improve.ts).

## Audit trail and investigations

**Web:** `/audit`, `/audit/[id]`. **iOS:** relevant evidence through task and repair details; no separate primary Audit destination.

The audit list exposes recorded work and its model/tool evidence. A detail groups the investigation material around the task and offers a bounded investigation request to the assistant. Audit exists to answer what was requested, what was selected or called, what permission applied, what it cost, and what result was actually observed.

Audit is diagnostic data, not another source of instructions from an external sender. Captured output and transcripts have privacy and retention implications. A complete audit chain is useful evidence but cannot by itself prove a real-world result that the provider never confirmed.

Sources: [audit list](../apps/web/app/audit/page.tsx), [investigation page](../apps/web/app/audit/[id]/page.tsx), [audit investigations](audit-investigations.md), [model-output review](llm-output-review.md).

## Access and setup

### Secure your assistant

**Web:** `/setup`, passkey authentication mode only.

The one-time setup link lets the owner claim an installation with a passkey. It is an access-ownership flow, not the complete provisioning/install wizard. An already authenticated owner is directed to security management.

### Sign in

**Web:** `/signin`, passkey mode only; configured Google authentication has its own auth flow.

The page authenticates the installation owner. Recovery is available through the supported offline recovery-code flow. Sign-in is separate from authorizing Gmail/Calendar access for the assistant's integration identity.

### Security

**Web:** `/security`, also embedded in `/settings` in passkey mode.

Security manages passkeys, offline recovery codes, mobile/device credentials, and sessions. Device credentials can be revoked independently. This is not the same permission system as tool approvals, MCP standing rules, or provider API keys.

### Connection onboarding

**iOS:** Connection, before the normal shell when no usable server is configured.

The owner supplies the server URL and mobile credential, checks access, and enters the application after successful pairing. Connection can be reopened under More → Assistant server. Credential storage is Keychain-based; the phone never needs the database password or the assistant's model-provider secret.

Sources: [setup](../apps/web/app/setup/page.tsx), [sign in](../apps/web/app/signin/page.tsx), [security](../apps/web/app/security/page.tsx), [owner passkeys](consumer-owner-passkeys.md), [Connection](../apps/ios/Assistant/Views/ConnectionView.swift).

## Complete web page inventory

This register includes all 34 `page.tsx` files under `apps/web/app` at review time. Bracketed paths are dynamic route patterns. **Only the six console routes marked reachable are currently exposed (three are passkey-only); 27 are retained/dormant and the landing route redirects.** API routes, actions, loading states, and shared components are not independent pages.

| Route | Responsibility | Documentation above | Current browser access |
| --- | --- | --- | --- |
| `/` | Redirect to Settings | Application navigation | Redirect to Settings |
| `/chat` | Stable primary chat | Chat | Dormant; redirect to Settings |
| `/chat/[id]` | Specific conversation | Chat | Dormant; redirect to Settings |
| `/chat/all` | Current/archived chat directory | Chats | Dormant; redirect to Settings |
| `/tasks` | Activity list | Activity | Dormant; redirect to Settings |
| `/tasks/[id]` | Work details and controls | Activity details | Dormant; redirect to Settings |
| `/goals` | Goal list and editors | Goals | Dormant; redirect to Settings |
| `/approvals` | Decision inbox | Approvals | Dormant; redirect to Settings |
| `/cards` | Active saved cards | Cards | Dormant; redirect to Settings |
| `/packs` | Plans and follow-through | Situation Packs | Dormant; redirect to Settings |
| `/people` | Contact/person directory | People | Dormant; redirect to Settings |
| `/people/[id]` | Person details | People | Dormant; redirect to Settings |
| `/profile` | Memory home and Open Loops | Memory | Dormant; redirect to Settings |
| `/profile/memories` | Memory hub and legacy workspace-link routing | Memory library | Dormant; redirect to Settings |
| `/profile/knowledge` | Library, map, and cleanup views | Memory library, Knowledge map, Tidy up | Dormant; redirect to Settings |
| `/profile/about` | Owner facts and compact profile | Profile summary | Dormant; redirect to Settings |
| `/profile/voice` | Writing style and samples | Writing voice | Dormant; redirect to Settings |
| `/profile/data` | Export and erasure controls | Your data | Dormant; redirect to Settings |
| `/profile/people/[id]` | Legacy redirect to person detail | People | Dormant; redirect to Settings |
| `/settings` | Pairing and owner access | Settings and More | Reachable console |
| `/calls` | Outgoing calls | Calls | Dormant; redirect to Settings |
| `/calls/[id]` | Live/completed call details | Calls | Dormant; redirect to Settings |
| `/capabilities` | Optional module readiness | Capabilities | Dormant; redirect to Settings |
| `/documents` | File ingestion and search library | Documents | Dormant; redirect to Settings |
| `/import` | Historical archive distillation | Backstory import | Dormant; redirect to Settings |
| `/skills` | Advisory procedure library | Skills | Dormant; redirect to Settings |
| `/costs` | Billing, ledger, and budgets | Costs | Dormant; redirect to Settings |
| `/anomalies` | Approval-policy anomalies | Anomalies | Dormant; redirect to Settings |
| `/improvements` | Proposals and repair tracking | Improvements | Dormant; redirect to Settings |
| `/audit` | Execution evidence index | Audit trail | Reachable console |
| `/audit/[id]` | Task investigation | Audit investigations | Reachable console |
| `/setup` | Initial owner claim | Secure your assistant | Passkey mode only |
| `/signin` | Owner passkey login/recovery | Sign in | Passkey mode only |
| `/security` | Passkeys, devices, recovery, and sessions | Security | Passkey mode only |

## Supporting native surfaces

In addition to the destinations above, the native experience includes the chat message action menu and hide/undo bar; inline approval, budget, suggestion, and saved-card controls; task and goal detail/editors; memory fact/editor/review sheets; the library; person/occasion and graph entity/relationship editors; pack editing/rehearsal; reminder removal; provider connection/model detail and model pickers; MCP connection management; repair reporting/details; and the full-screen Talk mode.

System surfaces include the notification authorization prompt, approval notification actions, app badge, Live Activity and Dynamic Island views, speech/microphone authorization, language-asset readiness, and location authorization. They are part of the experience contract even though they are not standalone web routes. Compilation and automated tests do not establish their physical audio, touch, background delivery, or permission behavior; device QA remains a separate verification layer.
