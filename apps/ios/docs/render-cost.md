# What the transcript costs per frame

The chat transcript targets consistent 60fps while a reply streams in, a finger
drags the pull menu open, or text is typed into the composer. That target has
not been established by the checks below. This document describes the current
rendering work and the correctness constraints on further changes.

## Why the transcript is unusual

`ChatTranscriptRows` builds the log into a plain `VStack`. The current
`ChatView` lets the transcript draw through the full conversation surface,
behind the crown, navigation and composer. Controls are siblings of the scroll
view in a `ZStack`, keeping their gestures outside its pan-recognizer subtree.
The first and last messages have scroll-content clearance for the crown and
measured composer; this spacing does not create a clipped viewport. Jump to
latest shares a floating stack with Undo and draft recovery above the composer,
so controls cannot overlap or change transcript height. Measured Undo/recovery
height contributes to endpoint content clearance because those notices can
remain at the newest edge; Jump never changes that clearance.
Only the complete conversation surface clips at its outer rounded edge.

The eager stack keeps every row mounted. Any change to that behavior must
preserve bottom-follow as messages arrive and streamed replies grow, the
reader's position when browsing older messages, and row state and interactions.
Drawing behind chrome does not establish that a lazy replacement is correct.

The cost of that choice is that every row must exist when the log is first
opened. `ChatTranscriptRows` now owns the eager stack behind an equatable
boundary. Draft text, pull distance, and composer geometry stay in `ChatView`;
they no longer regroup receipts or resolve preceding prompts in the rows view.
The rows view changes when messages, send availability, or card-form state/task
revisions change, and directly observes Reduce Motion. Its action closures
capture the same model and state bindings throughout a screen's lifetime.

The following boundaries reduce repeated work; their presence does not prove
a frame-time budget.

## 0. The model is observed per property

`AppModel` is `@Observable`, not an `ObservableObject`. As an `ObservableObject`
it published through a single channel: any of its thirty properties changing
re-rendered every view that held the model — fifty-five of them, including the
chat transcript left alive underneath whichever page was open. A refresh landing
on Approvals rebuilt the whole conversation behind it. With Observation a view
re-renders only when a property it actually read changes.

Two rules follow:

- **State no view reads is `@ObservationIgnored`.** Tasks, caches and flags
  used only by model operations cost nothing to track and cannot invalidate
  anything. Privacy alone is not the criterion: `conversationDrafts` stays
  tracked because visible computed draft scope and recovery depend on it.
- **Read what you need in the body, not a copy of everything.** A view that
  reads `model.messages` is invalidated by messages; one that reads
  `model.overview` is not. Passing a derived value down to a child is cheaper
  than letting the child read the whole model.

Bootstrap and overview reads start together. A bootstrap that replaces the
authenticated owner invalidates the speculative overview and requires a fresh
read in the new connection generation; it cannot promote old private data by
updating the ticket after authentication. The regression fixtures route those
concurrent reads by path, rather than relying on network arrival order.

## 1. A row that has not changed is not rebuilt

`ChatTranscriptRows` compares messages, `isSending`, `cardFormStateRevision`
and `cardFormTaskRevision`. If you add another content input, include it in
equality. Do not pass closures whose behavior changes with unrepresented
state: the equality boundary would retain the old
behavior. The transcript keeps its eager stack; this equality boundary changes
ownership of derivation work, not scroll behavior. Full-height drawing and
content clearance are owned by `ChatView`, outside that boundary.

`MessageBubble` and `ApprovedReceiptGroup` are `Equatable`, and the transcript
attaches `.equatable()` to each. A token landing in the newest reply changes
exactly one row; every other row compares equal and SwiftUI skips its body.

Comparing is much cheaper than it looks: the message values come out of the
same array, so their strings compare by buffer identity rather than character
by character.

`MessageBubble`'s actions are closures and cannot be compared, so `==` compares
whether each one is present. That is sound because none of them varies while a
row's content holds still — each captures either `AppModel`, which is a
reference, or the message itself, and the ones that switch off do it by going
nil (`runForReal` and `retry` while a turn is in flight, `hide` for a row the
server has not stored yet).

**If you add a property to `MessageBubble`, add it to `==`.** A property left
out is a row that does not redraw when it should. A new closure needs the same
argument the existing ones have: either it never varies, or its nil-ness says
when it does.

`@State` and `@Environment` are not part of this and do not need to be. SwiftUI
tracks them per row and invalidates it directly, so a colour scheme, Dynamic
Type or Reduce Motion change still redraws every bubble.

## 2. Markdown is parsed once per source string, not once per frame

`AssistantMarkdown` is a hand-written block parser plus an `AttributedString`
build per block — the dominant cost in turning a message into views, and a pure
function of the source string. `blocks(in:)`, `attributed(_:inline:)`,
`inlineAttributed(_:)` and `plainText(_:)` all go through a `RenderMemo`
(`System/RenderMemo.swift`): a bounded, thread-safe memo that keeps its newest
keys.

Two things follow from that:

- **Reach for the memoised entry points**, not the parser behind them. Calling
  `AttributedString(markdown:)` directly in a body puts the cost back.
- **Read a parse into a local before looping over it.** `blocks` used to be a
  computed property, and the `blocks[index - 1]` lookup inside the `ForEach`
  re-entered the parser once per block — quadratic in the length of a reply.

A miss costs exactly what every call used to cost, so the memos degrade into
the old behaviour rather than into a cliff. Full, they come to a few megabytes.

`NSRegularExpression.cached(_:options:)` is the same idea for patterns:
compiling costs far more than matching, and the card readers in
`MessageBubble.swift` build several of their patterns from parts at call time,
so a stored property per site would not have covered them.

## 3. What a row needs to know about the log is resolved once

Two of `MessageBubble`'s inputs depend on the rest of the conversation: the
prompt a reply is answering, and whether a newer answer has superseded it. Both
were scans through `model.messages` inside the row builder, so drawing n rows
cost n scans of n messages — on every frame, per the above.

`TranscriptContext` resolves both in one pass before the `ForEach`. If another
row input needs to look at its neighbours, put it there rather than scanning
from inside the row.

## Formatters

`AssistantFormatters` (in `Models/APIModels.swift`) holds the shared
`DateFormatter`s. Constructing one is expensive — it resolves a locale, a
calendar and a format — and these are read while drawing rows, so
`DateFormatter()` inside a body or a per-row helper is a real cost, not a
micro-optimisation. `DateFormatter().monthSymbols` inside a `ForEach` was the
worst instance.

The trade is written down next to the type: a shared formatter resolves its
format once, so a region changed while the app is running may not reach it. iOS
relaunches an app when the region changes, which is what makes that acceptable.
Anything keyed to a fixed wire format pins `en_US_POSIX` and must not be given
the device's locale.

## Timestamp parsing during log ordering

`ChatLogOrder` reuses parsed send times by the full raw `createdAt` string.
It uses the unchanged fixed wire-format parser behind `ChatMessage.createdAt`;
invalid strings cache a nil result, and equivalent instants expressed as
separate raw strings remain separate keys. Duplicate strings within one input
are parsed at most once.

After each ordering call, only timestamp keys present in that input remain in
the parsed-date cache. `reset()` clears it. This pruning does not remove the
existing assigned message positions: hiding and re-adding a durable row keeps
its place, and provisional rows still gain authoritative placement when their
send time arrives. The position assignment and comparator are unchanged.

The cache avoids repeated parsing on warm reads and adds dictionary work on a
cold read. Optimized host benchmarks are evidence about that ordering work,
not iOS frame times, scroll performance, or production polling overlap. A
cache hit still requires a linear input pass and the existing sort. In three
alternating optimized host runs on an M4 Pro, the 500-row warm-call median fell
from 21.10ms to 0.21ms; cold fill was 21.12ms versus 21.50ms. With 3,000 rows and
entirely different raw timestamps each pass, medians were 127.90ms versus
129.39ms. These isolated timings exclude input construction and process startup
and do not establish a scroll improvement.

## What is covered, and what a device still has to confirm

`AssistantTests/RenderCostTests.swift` covers the correctness claims, not the
speed: that the memo computes once per key and stays within its limit, that
`attributed(_:inline:)` reads a source exactly as the inline build it replaced
did, that `TranscriptContext` agrees with the scans it replaced for every row,
and that a row compares equal only while its content holds still — including
that a landing token still makes it unequal.

The existing bottom-follow regression must also pass when new messages arrive
and streamed replies grow. Runtime validation must cover scrolling away from
the bottom and preserving row state and interactions.

None of it measures frames. Message changes still require linear transcript
grouping/context work and one equality comparison per row. Typing/menu changes
now compare the transcript's inputs before that work is offered. Profile a long
conversation on a device to establish frame and launch costs before choosing
virtualization; a smaller source body is not a frame-rate measurement.

`ActivityView` and `CardsView` use lazy stacks; Memory home and People now use
native `List`. The paged memory library, Knowledge cleanup, Goals, Approvals,
packs and Workspace still build list content eagerly. Converting them needs
runtime validation of height proposals, particularly nested geometry and
Markdown/code blocks. See the current source audit in
[`docs/audits/ios-experience-2026-10-02.md`](../../../docs/audits/ios-experience-2026-10-02.md).

The server side of "the app feels slow" is a separate axis and is written up in
[`docs/audits/performance-review.md`](../../../docs/audits/performance-review.md).
