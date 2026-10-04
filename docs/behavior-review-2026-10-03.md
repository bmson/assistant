# Assistant behavior and improvement review — 3 October 2026

This continuation reviews what happens after a person sends a message: which route handles it, what the assistant can truthfully say, which effects actually occur, how the interface explains a decision, and how a reported defect becomes a reviewable fix. It builds on the complete [page inventory](product-guide.md), [design guidelines](design-system.md), and [session/interface cleanup](ui-simplification-2026-10-03.md).

The work treats the assistant as a continuing relationship with durable responsibilities. A polite reply is useful only if it answers the right question, preserves the owner's intent, and gives an accurate account of what happened. A finished response and completed work are separate facts.

## What changed in the message lifecycle

The application chat handler now has direct scenario coverage in addition to executor replay. Tests drive the real handler with an in-memory owner-scoped chat store and scripted router. They cover ordinary greetings, emotional support, explanation and rewrite requests, actionable messages, accepting a prior concrete offer, excluding background notices from that offer, bare budget decisions, explicit autonomy, spoken mode, expressive cues, provider and queue failures, malformed/large requests, missing chats, and unavailable optional context.

An explicit unavailable conversation returns a recoverable error before appending a message. It no longer silently creates another thread with a different history. Starting a new conversation remains an intentional operation. Optional ambient/profile reads may fail without stalling an otherwise answerable conversational turn; task creation and action evidence are still authoritative dependencies.

Imperative weather checks now reach the executor even without a question mark. “Is my calendar clear tomorrow?” uses the all-calendar availability reader, with the owner's local date window. These deterministic rules protect clear requests from a weak classifier; genuinely ambiguous intent still receives classification and planner treatment.

Availability replies now start with the useful answer and name the calendars actually checked. A whole local day is recognized by civil dates, including 23- and 25-hour daylight-saving days. Partial ranges, unavailable calendars, missing checked-calendar names, and malformed busy intervals cannot imply a clear whole day. Partial windows retain their exact human-readable coverage; repeated daylight-saving clock times include their time-zone distinction. This renderer currently uses English formatting; localized copy remains a separate task.

Conceptual questions have an execution gate as well as a model-facing instruction. A provider that returns an unrelated calendar or mail call cannot dispatch it. A tool-only conceptual completion receives one checkpointed retry asking for a direct answer, with tools withheld; any further proposed calls are discarded. If no usable reply remains, the task needs attention. This is bounded recovery, not an unending retry loop.

The no-tool rule is also checked immediately before dispatch. A fictional approval notice in a conceptual or read-answer turn cannot invoke the action-recovery retry or create a real unrelated send approval. The conceptual retry has its own durable checkpoint flag, so it remains bounded across recovery without inflating the required-action failure signals used by self-improvement.

The fictional-approval recovery reply no longer invites the owner to approve an unrelated action. It states that no approval exists, explains that the reply could not finish, and points to Activity before retrying in case earlier work already ran.

Source: [chat handler](../packages/application/src/chat-turn.ts), [handler scenarios](../packages/application/src/chat-turn.test.ts), [triage](../packages/application/src/chat-triage.ts), [read detection](../packages/core/src/workflow/read-intent.ts), and [executor loop](../packages/core/src/workflow/executor/step-loop.ts).

## Receipts must prove the requested effect

Reminder creation and cancellation have separate response-contract evidence kinds. A succeeded function invocation does not prove that a reminder was created or removed. Creation requires a usable reminder identifier and no explicit false creation result. Cancellation requires `cancelled: true`. A creation cannot justify a cancellation, and a receipt from an earlier task cannot justify a new change.

The same checks apply to short responses such as “Done” or “I removed it” when the current request identifies the reminder effect. Ambiguous cancellation lists up to five bounded returned reminder labels and asks which one to remove. A not-found result explains that no active matching reminder was found. Failed, missing, or stale receipts cannot produce a success claim.

A deterministic replacement corrects the text, but cannot turn an unverified effect into completed work. Executor finals with unsupported effect claims now remain `needs_attention`. Supported actions, corrected factual projections, repaired URLs, and unavailable optional model review can still finish normally. An empty executor completion also needs attention. It retains any current-task verified effect summary and typed cards, then points to Activity before a retry. It makes no extra model call and does not repeat the action. Reminder cards reject explicit false creation or failure receipts as well.

Optional review has a stricter fallback: if its proposed replacement fails the same evidence, wording, link, or grounding contract, the original checked answer survives. The task can finish on that answer. The rejected candidate still contributes correction telemetry, so repeated reviewer problems reach self-improvement. The historical `outputVerificationRevised` flag records a supplied replacement candidate, not proof that the replacement was delivered. Successful, valid improvements to the wording still publish normally.

Partial live-lookup recovery also retains typed cards built from successful current-task results. A failed weather read cannot hide an already verified calendar event; an invented prose score cannot hide the actual retrieved scoreboard. Failed source results cannot supply those cards. Unsupported numeric drafts remain an attention/correction signal, with the usable source evidence visible instead of an unnecessary blind retry.

Mail answers avoid a redundant search-results card when a complete, nonempty search is fully covered by later successful thread reads containing message text. Incomplete searches, unopened hits, missing thread identities, and failed or empty reads retain their results card. The remaining lodging scenarios still expose diagnostic-first prose and a historical booking-date mismatch that should be made explicit to the owner; passing evidence checks does not make those replies ideal.

This preserves a practical distinction: the owner can read an honest reply while still seeing that the responsibility remains unfinished. It also lets the existing self-repair sweep observe the failure rather than losing it behind a misleading `done` state.

Source: [response contract](../packages/core/src/workflow/response-contract.ts), [receipt regression cases](../packages/core/src/workflow/response-contract.test.ts), and [authoritative finalization](../packages/core/src/workflow/executor/finalize.ts).

## Improvement is a sequence of evidenced decisions

The [self-improvement flow](self-improvement-flow.md) documents signals, proposals, investigations, checks, publication, deployment, and owner confirmation. This review strengthens the decision boundary rather than giving the assistant unrestricted permission to modify itself.

Model-routing changes and proposal decisions are atomic and owner-scoped. Duplicate decisions are idempotent. A dismissed or already applied proposal cannot later change routing. Unknown roles, missing models, unavailable/unpriced models, incompatible embedding models, malformed fields, and empty evidence reject the proposed change while leaving it open. An incomplete swap cannot silently apply its valid half.

Decision responses carry `outcome`, `enacted`, and `detail`. A routing change says what changed; an advisory acknowledgment says that no settings or code changed. Already-current and already-decided proposals have distinct receipts. The native client preserves these outcomes instead of throwing them away behind a success boolean. Repair and improvement requests also check their captured connection generation before publishing results into the current owner's interface.

The Improvements page has one supported code-fix request action. It reports actual investigation identity/state, exposes failures beside the relevant controls, and distinguishes deployed code from confirmation that the original behavior is fixed. Proposal evidence is a review input; this patch does not establish a statistical model-quality improvement or a general automatic promotion/rollback system.

## Output presentation and interaction

The native transcript now distinguishes rejected, failed, expired, denied, and missing decisions. Local approval failures remain visible without inventing a success receipt. A settled row with no renderable content receives a conservative explanation and an Activity link rather than disappearing. Known notice metadata can render without requiring a nonempty prose field.

The design rule is that useful state and the next action belong together. A decision receipt should name the actual state, a recovery path should preserve previous effects, and a code-fix control should explain the stage it can start. The conversational tone stays concise; investigation detail and history are available on demand.

Source: [message presentation](../apps/ios/Assistant/Components/MessageBubble.swift), [native outcome policy](../apps/ios/Assistant/Models/APIModels.swift), and [Improvements view](../apps/ios/Assistant/Views/WorkspaceView.swift).

## Scenario review and acceptance boundaries

The [interaction scenario guide](testing/assistant-scenarios-2026-10-03.md) maps the messages, actions, and assertions. The scripted runner can retain delivered answers and full evidence with `pnpm eval:questions --suite all`; the default historical audit suite remains available. A dedicated local replay database and rollback keep mail, calendar, reminders, notifications, and memory effects intercepted.

Tests distinguish exact invocation counts, approved arguments, pending versus completed effects, denied sends, prior-task evidence, timezone windows, partial reads, provider recovery, verification outages, and generated card kinds. Real model inference is a separate evaluation: scripted answers test the surrounding machinery and its response to bad model output, not a model's independent reasoning accuracy.

The final [delivered-answer review](testing/assistant-scenario-answers-2026-10-03.md) retains every request and exact reply from **67 scripted executor scenarios**: all passed, none failed or unrun, and $0 in model charges. An independent review compared every retained reply with its request, status, approvals, tool evidence, and cards. The corpus fingerprint is `76763cad1514a01f9cc3450733e6e323295d92d285552faaea022266f1ecc806`; its private local evidence directory is `.workspace/question-regression/runs/assistant-behavior-2026-10-03-final-reviewed`.

The coordinated full repository run passed **4,600 tests across 615 files, with zero skips**, in 1,032.37 seconds. It includes actual PostgreSQL and Firestore emulator improvement races and rollback checks, the handler and executor scenarios, and the final response contract. All 141 recorded source hashes remained unchanged during the run. The owned emulator was stopped after validation. The runner used a 30-second test and hook deadline with unchanged behavior assertions; three fixtures had exceeded the default five-second deadline in a prior focused run. These fixture deadlines do not measure app latency.

The iOS app, activity extension, and registered test sources compiled for generic arm64 iPhone. Separately, **111 actual-source Foundation presentation checks** passed. There were **zero executed XCTest/device cases** because no runnable simulator runtime was available. The retained presentation source hash matches the final native model source.

The final production build passed with `AUTH_DEV_BYPASS=false`. Typechecking passed for all fourteen packages and the scripts. Formatting and architecture boundaries passed, with the existing twenty-four warnings and three informational diagnostics. The [verification record](audits/assets/assistant-behavior-2026-10-03.json) retains the source hashes, corpus identity, check counts, deadlines, native limits, and hashes of the private local logs.

This is local source work based on an uncommitted working tree at `20905fdf3a86dcb1d09701ba8c84c590d4e3f5e0`. It does not establish production release, real-model accuracy, semantic memory-retrieval quality, or physical-device speech, gesture, accessibility, and push behavior. The lodging date discrepancy and diagnostic-first lodging copy remain explicit usability follow-ups in the scenario guide.
