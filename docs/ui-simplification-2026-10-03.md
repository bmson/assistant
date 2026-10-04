# Assistant session architecture and interface cleanup

This continuation addresses mistakes that make a capable assistant feel unreliable: losing a draft when changing chats, replacing typed text after a failed send, accepting an unverified connection, showing an endless settings spinner, or moving focus unpredictably during account recovery. The changes keep the existing native conversation and green paper design. They simplify controls and make state ownership explicit.

The [product guide](product-guide.md) remains the complete page inventory. The [native audit](audits/ios-experience-2026-10-02.md) and [browser audit](audits/web-experience-2026-10-02.md) describe page implementations and retained screenshots. This document explains the new architecture contracts and their practical limits. It records local source changes; deployment and native distribution are separate activities.

## Verified connection before session replacement

Previously, saving a candidate server URL and key changed the active client before the app knew whether it could authenticate. A subsequent bootstrap failure could leave the current conversation, preferences, and saved connection out of agreement. The connection form could also report success through a path that had swallowed the bootstrap error.

`saveConnection` now creates a candidate client and requests its authenticated bootstrap first. Only the latest uncancelled pairing attempt can commit its result. A rejected candidate preserves the current client, owner, saved URL, credential and drafts. The candidate uses the existing transport seam, so tests can exercise a different server without contacting it or storing a real key.

After successful verification, the app stores the credential and normalized URL and applies the verified identity. Re-entering the same configuration for the same owner preserves the current draft session and active reply. A different configuration or owner creates a new session, cancels old local work, clears owner projections and optimistic overlays, removes pending navigation and private drafts, and opens the verified conversation. Conversation identifiers alone cannot establish ownership: two installations can reuse an identifier.

Authenticated refresh applies the same boundary if an installation changes owner behind an unchanged URL and key. It advances the generation and clears the previous owner's state exactly once. A delayed read from before that replacement cannot repopulate the new session.

A supplementary overview failure does not invalidate authenticated bootstrap. Settings and activity recover separately. If the device refuses to store the key, the connection remains usable for this launch and a warning explains that it must be entered again next time. Failed verification never writes the candidate credential. The cancellation path also clears its own loading indicator without dismissing a newer connection's loading state.

Source: [AppModel](../apps/ios/Assistant/AppModel.swift), [APIClient](../apps/ios/Assistant/Networking/APIClient.swift), and [connection form](../apps/ios/Assistant/Views/ConnectionView.swift).

## Drafts belong to their conversation

The composer previously had one local text buffer. Changing the active conversation could carry that text into another chat; a failed send could replace a newer follow-up that the owner had already started typing.

The new [ConversationDrafts](../apps/ios/Assistant/Models/ConversationDrafts.swift) value stores unsent text by conversation within an authenticated session. ChatView saves the outgoing chat's draft and restores the incoming chat's draft. A session generation rejects a delayed save from an old disappearing view, even when the next account uses the same conversation identifier. The cache is private, so each keystroke does not publish a global AppModel change and invalidate the transcript.

A failed message enters a separate recovery slot for its original chat. It restores automatically only when the current composer is empty. A newer follow-up remains intact; a visible restore action explains that the owner can send or clear it before recovering the earlier message. Recovery consumes the slot once. Whitespace and Unicode survive storage; trimming occurs only when deciding whether a message is ready to send.

Drafts are held in memory for this app session. They are not uploaded, embedded, indexed in long-term memory, or written to disk. Terminating the app loses this unsent cache. Persistent encrypted draft storage would require a separate retention and device-recovery decision.

Dictation records the same session and conversation scope. Delayed microphone startup, transcript updates, and keyboard focus cannot attach to a different chat. Leaving the visible conversation stops dictation. Sending detaches dictation before clearing the composer, preventing a late transcription tail from recreating the sent draft. The existing native text selection and caret gestures remain the editing mechanism.

Source: [ChatView](../apps/ios/Assistant/Views/ChatView.swift). Regression cases: [ConversationDraftsTests](../apps/ios/AssistantTests/ConversationDraftsTests.swift). The repeatable [host check](../apps/ios/tools/check-composer-drafts.py) runs the unchanged production store and the five pure test method bodies outside UIKit.

## Delayed responses must still belong to the visible session

Requests capture both the active client and a connection generation. Shared projection writes check that identity after an asynchronous response. This covers bootstrap, overview, archived work/goals, workspace settings, provider and MCP lists, saved cards, and people caches. Conversation updates also check their captured conversation. A result from a previous session cannot repopulate these projections or add old optimistic decisions to the new owner's transcript.

The same rule applies to approval and suggestion receipts, card refresh markers, provider and MCP mutations, assistant settings and rules, writing voice, and memory export/erasure feedback. Memory exports use unique temporary filenames, so two exports on the same day cannot silently replace the bytes behind an earlier share URL. In-flight workspace counts are tracked per connection generation: an old slow read does not prevent the new session from warming its settings.

Creating a chat, changing its model, hiding a message, and opening a conversation respect captured session and navigation intent. A late hide failure cannot insert the removed message into another chat or owner. A delayed model change cannot reopen a conversation after the owner deliberately navigates elsewhere. Newer navigation takes precedence over an older response.

The current client has one active reply coordinator. Chat switching, chat creation, and current-chat model changes therefore wait until a reply finishes or the owner stops it. Directory and model controls explain that condition instead of appearing to accept an operation that would replace the active transcript. The server may continue durable work independently of the stopped local stream. Simultaneous foreground replies in multiple chats would need per-conversation turn coordinators and a defined notification policy; this patch does not introduce them.

These checks govern publication into current client state. They cannot undo an external action that an earlier authorized server request already performed. They also do not replace server ownership checks, workflow idempotency, or transaction guarantees. Remaining return-valued domain queries should adopt the same session contract as the client is divided into smaller coordinators.

## Utility pages show existing state before setup

More now refreshes the workspace settings it actually uses without reloading the conversation bootstrap. Assistant preferences cannot open a blank editor before their initial read succeeds. A failed read offers retry; cached values remain visible with an explanation that they must refresh before changes. Failed submissions retain input and show feedback beside the relevant controls.

AI providers preserves unsaved main and fast model choices independently. An unrelated provider refresh follows new server defaults only for fields the owner has not edited. Failed connection attempts keep entered values. Removing a provider uses a consequence-specific confirmation. Loading, an unavailable service, and an empty provider list are distinct states. Phone-call voice models remain separate from the iPhone's read-aloud and Talk settings.

Connected tools shows established MCP connections first. Adding one expands a compact disclosure rather than placing a large form ahead of the list. Existing actions serialize per screen, retain failed input, and explain that tool approval follows the assistant's active policy; the page no longer promises that every call always asks during autonomous operation.

Writing voice waits for a successful initial read before allowing editing or saving. Otherwise an initial failure could turn blank fields into an accidental overwrite of the owner's existing profile. Retry is available, failed saves retain entries, and an active submission prevents dismissal. Memory export and erasure cannot run together; success feedback follows the actual result.

Source: [More](../apps/ios/Assistant/Views/MoreView.swift), [AI providers](../apps/ios/Assistant/Views/AIProvidersView.swift), [workspace utility pages](../apps/ios/Assistant/Views/WorkspaceView.swift), and [memory data](../apps/ios/Assistant/Views/MemoryDataView.swift).

## Suggestions become accurate receipts

Suggestion hydration now carries the server's snooze deadline into native message parts. A snoozed card presents the actual return date and time when available, including VoiceOver output. If the server does not provide a usable deadline, the receipt says that the return time is unavailable; the app does not invent tomorrow.

A locally acknowledged snooze remains visible across a stale pending read until its known deadline. When that deadline passes, authoritative pending state can become actionable again. An acknowledgment without a deadline is shown immediately, but later authoritative pending state may prevail; it is not hidden indefinitely. Accepted suggestions preserve their created task identity and hydrate progress rather than returning to an unanswered question. Suggestions remain separate from approval counts.

Source: [APIModels](../apps/ios/Assistant/Models/APIModels.swift), [MessageBubble](../apps/ios/Assistant/Components/MessageBubble.swift), and [suggestion lifecycle tests](../apps/ios/AssistantTests/APIModelsTests.swift).

## Browser recovery and controls stay usable on phones

New recovery codes wrap within the phone width while preserving readable groups, provide a copy action, and receive focus when issued. Replacing a code resets the saved acknowledgment. Clipboard denial produces a visible instruction to select and copy the value; a long error does not become a button label. Newly issued device keys use the same feedback contract.

Sign-in recovery is a native disclosure with an explicit return to passkey sign-in. Opening it focuses the recovery input; closing it clears the entered code. Passkey failures give a relevant next step for unsupported browsers, an unsuitable address, or duplicate registration.

Shared overflow controls use the browser's native popover invoker for logical tab order and focus restoration. Panels have an accessible label and remain inside a short or narrow viewport. The browser remains the owner administration and investigation console: the 27 dormant product routes remain behind the existing redirect policy.

Source: [shared copy control](../apps/web/lib/copy-button.tsx), [recovery notice](../apps/web/app/setup/recovery-code.tsx), [sign-in](../apps/web/app/signin/signin-client.tsx), and [shared UI controls](../apps/web/lib/ui-client.tsx). The browser audit records synthetic screenshots and behavior checks using actual components and styles.

## Design and architecture decisions

| Decision | Practical reason | Tradeoff |
| --- | --- | --- |
| Verify candidate bootstrap before committing pairing | A typo must not destroy a working session | The form waits for authenticated verification |
| Keep drafts in a private conversation-scoped value | Preserve text without publishing every keystroke to the transcript | Unsent text does not survive termination |
| Fence asynchronous publication with connection generation | A delayed old response cannot become current owner state | Query and mutation methods must follow one explicit contract |
| Keep one active foreground reply | Current transcript, speech, and Live Activity have one coordinator | Switching waits for completion or stop |
| Preserve dirty fields independently | Refreshing a service must not undo an unsaved model choice | Baselines need explicit server acknowledgment |
| Show existing connections before add forms | Routine management deserves the simplest path | Setup takes an intentional additional action |
| Distinguish missing, loading, failed, and stale data | Blank fields and endless spinners cannot imply valid state | Screens need a recoverable read state |
| Use actual snooze deadlines | A receipt should describe the server's decision accurately | Older server payloads may lack a return time |
| Use native disclosure and popover behavior | Focus, tab order and dismissal have platform semantics | Browser support remains part of the client compatibility contract |

## Verification and remaining work

The canonical isolated-database suite passed **4,406 tests across 610 files, zero skipped**, with the local Firestore emulator enabled. Production build passed with development authentication bypass disabled. All 14 package typechecks and scripts typechecking passed. Lint and architecture boundaries passed with 24 existing warnings and three informational diagnostics. Final whitespace checks, 694 local documentation links and 20 recorded source hashes passed. The emulator was stopped after validation.

Browser QA passed 72 synthetic layouts plus focused recovery, clipboard, key-replacement and keyboard/popover checks, retaining 17 screenshots. A final generic arm64 native test build passed for app, extension and all registered test source, including the owner-replacement regression. No XCTest cases executed.

The pure draft host check passed five test method bodies and 22 assertions against the production store. Separate actual-source host harnesses passed 121 suggestion assertions, 86 conversation/pairing assertions, six provider-default checks and six writing-voice loading checks. Registered native regressions cover failed pairing, preserving the same connection, changing owner with the same conversation identifier, clearing a cancelled loading state, rejecting an old MCP response, and owner replacement through authenticated refresh. The [machine-readable verification record](audits/assets/ui-simplification-2026-10-03.json) retains source hashes and scope limits.

The host checks exercise state policy without UIKit. Browser fixtures use actual components and application styles with synthetic data, not real authentication or production writes. A generic native build compiles app, extension and test sources; it does not establish physical microphone, gesture, VoiceOver, background or push behavior. No simulator runtime is available in this checkout.

The next architecture work should extract connection/session ownership, per-conversation drafts, and turn coordination from the large AppModel without creating a second state authority. Preserve these behavioral regressions while moving boundaries. Cross-producer attention and a durable phone-delivery outbox remain the most important server follow-through; this UI pass does not replace them. Model promotion still requires measured task quality, cost and latency against the evaluation fixtures.
