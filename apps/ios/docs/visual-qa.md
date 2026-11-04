# Visual and interaction QA

A review of the SwiftUI client's visual surfaces and interaction layer: how states animate
between each other, how active states read, and how the Dynamic Island surfaces position
and behave.

**Reviewed at:** `89d5b01` — 24 Swift files, 6,965 lines, plus `Info.plist` and the build
settings.

**Method:** source read. No Swift toolchain or simulator was available, so nothing was built
or screenshotted. Findings marked **[verify]** depend on runtime geometry — safe-area
insets, text metrics, Dynamic Island dimensions — and should be confirmed on device before
you spend time on them. The rest are readable straight from the code.

**Status:** 21 of 27 fixed. Every heading below is marked `Fixed` or `Open`.

| Severity | Total | Fixed | Open |
| -------- | ----- | ----- | ---- |
| Critical | 4     | 4     | —    |
| High     | 7     | 6     | 1    |
| Medium   | 8     | 4     | 4    |
| Polish   | 8     | 7     | 1    |

The six left open are the five that need a device to settle, plus P8, which is a shipping
decision rather than a bug. None of the fixes have been compiled — there is no Swift
toolchain in the environment they were written in — so the first thing to do with this
branch is build it and run the test target.

---

## Dynamic Island and the activity crown

The crown is a black surface drawn in-app at the top of the screen, meant to read as an
extension of the hardware cutout. That illusion is load-bearing, and it is where most of the
risk sits.

### C1 · The idle crown paints a black pill on any device without a cutout — **Critical** · Fixed

`crownBackground` returns `shape.fill(.black)` unconditionally. When `thought == nil` the
shadow is switched off but the fill is not, so a 126×37 black rounded rectangle is always
drawn at the top of the chat.

On a Dynamic Island iPhone in portrait that is invisible — black on black. But `Info.plist`
ships landscape on iPhone and the project ships `TARGETED_DEVICE_FAMILY = "1,2"`. Rotate an
iPhone 15 Pro and the top inset collapses to zero, so `foregroundLift` becomes 0 and the pill
lands at the very top edge while the real island has moved to the left. On iPad, or a notch
iPhone, it floats over the status bar permanently.

_Fix:_ gate the fill on `thought != nil` the same way the shadow is, and decide explicitly
whether iPad and landscape are supported.

`Assistant/Components/ActivityCrown.swift:178-185`, `:217-224`, `Assistant/Info.plist:46-58`,
`Assistant.xcodeproj/project.pbxproj` (`TARGETED_DEVICE_FAMILY`)

### C2 · Every send tears down the Live Activity and requests a new one — **Critical** · Fixed

`AppModel.send` always calls `LiveActivityManager.start`, and `start` opens with
`await endAllImmediately()` before `Activity.request`.

If an activity is already live — background work, or a second message during a long turn —
the island collapses and replays its full attach animation on every message. The state it is
showing is continuous; the animation says it is not.

_Fix:_ call `ensure(…)` then `update(…)`; reserve `start` for when `activeActivity()` is nil.

`Assistant/AppModel.swift:196-202`, `Assistant/System/LiveActivityManager.swift:32-49`

### C3 · A finished turn leaves "Your result is ready" in the island for 15 minutes — **Critical** · Fixed

`finish(…)` picks its dismissal policy from `retainsSummary`, which is
`!notificationDelivered`. `NotificationManager.schedule` returns `false` whenever
`applicationState == .active` — so watching the reply arrive in the app guarantees
`retainsSummary == true` and a `.after(now + 15 min)` dismissal. Failures hold for 30.

The in-app crown clears the same state after 1.8 seconds. The two surfaces are meant to
mirror each other and disagree by roughly 500×. In practice the island keeps a stale
"Finished" card through the next several turns of a conversation the user is actively having.

_Fix:_ decide the policy on foreground state rather than on whether a notification went out.
A result the user already saw does not need a 15-minute receipt.

`Assistant/AppModel.swift:384-396`, `Assistant/System/LiveActivityManager.swift:84-87`,
`Assistant/System/NotificationManager.swift:53-54`

### H1 · Mid-turn tool steps fire terminal tones, and success haptics — **High** · Fixed

`ToolActivity.thought` maps `"succeeded"` to `.done` and `"awaiting_approval"` to
`.waiting`, and `pollForReply` publishes whatever the last tool reports.

Three consequences chain off it:

- The crown shows a green checkmark plus `safeDetail`'s "Your result is ready" after each
  successful tool call, mid-turn.
- The crown's `sensoryFeedback` fires a `.success` haptic every time that happens.
- A `.waiting` step routed through `update(…)` always carries `pendingCount: 0`, so the
  island's compact trailing shows `!` and the expanded region says "Decision waiting" no
  matter how many actually are.

_Fix:_ clamp tool-derived thoughts to `.working`; let only `pollForReply`'s terminal branch
emit `.done` / `.failed`, and thread the real `pendingCount` through `update`.

`Assistant/Models/APIModels.swift:552-560`, `Assistant/AppModel.swift:333-337`,
`Assistant/Components/ActivityCrown.swift:29-36`,
`Assistant/System/LiveActivityManager.swift:51-59`

### H2 · Crown position is a one-shot UIKit poll, not reactive state — **High** · Fixed

`ActivityCrown.foregroundLift` is a `static var` that walks
`UIApplication.shared.connectedScenes` for the key window's top inset during body evaluation.

It returns 0 before the key window has insets, and nothing invalidates the view when they
change. Whether the fake crown lines up with the real island depends on when SwiftUI happens
to re-run the body — first launch, rotation, and a status-bar height change are all cases
where it can be a frame late or simply wrong.

_Fix:_ read the inset from the `safeAreaInsets` environment or a `GeometryReader` so the
offset is part of the layout pass.

`Assistant/Components/ActivityCrown.swift:214-224`, `Assistant/Views/RootView.swift:77-91`

### H7 · Every error message renders behind the hardware island — **High** · Fixed

M6 below moved the error banner out of `ChatView` and up into `RootView`, and offset it by
`ActivityCrown.safeAreaOverhang` so the expanded crown could not cover it. That number is
measured from the safe-area boundary, which was the right origin in `ChatView` — but the root
stack carries `.ignoresSafeArea(.container, edges: .top)`, so a top-aligned child there starts
at the physical top edge. Reading a safe-area-relative offset in that space placed the banner
roughly one top inset too high, in both of its states:

- Idle — the common case, since the crown only appears while work is running — the inset was a
  flat `4`. On a 15 Pro the pill occupies y = 11–48, so the warning glyph and the first words
  of every error sat behind it.
- Expanded, the offset resolved to about 35pt on the same device, which is _inside_ the crown
  (y = 10–86) rather than below it. M6's symptom therefore survived M6's fix.

_Fix:_ one `ActivityCrown.overlayTopInset` measured from the physical top edge, taking the
collapsed pill as what has to be cleared when the crown paints nothing. The transcript's own
content margin — which was already correct — now comes from the same call, so the two cannot
drift apart again. The banner animates between the two seats on the crown's spring.

`Assistant/Components/ActivityCrown.swift:258-286`, `Assistant/Views/RootView.swift:78-98`,
`:194-210`, `Assistant/Views/ChatView.swift:329-339`

### M1 · `topInset − 10` hardcodes one generation's island geometry — **Medium** **[verify]** · Open

The lift assumes a fixed gap between the island's bottom edge and the safe-area top, and the
collapsed 126×37 frame assumes one island size. That lands within a point or so on 14/15 Pro.
It drifts on hardware with different insets and means nothing at all on notch or flat-top
devices. There is no device check anywhere in the file — the constant is doing the work a
capability query should.

_Fix:_ detect island presence and skip the crown where there is not one, rather than tuning a
magic number.

`Assistant/Components/ActivityCrown.swift:77-84`, `:222-223`

### M2 · At accessibility text sizes the crown covers the status bar — **Medium** **[verify]** · Open

`expandedWidth` returns a flat 342 for accessibility sizes and `expandedMinimumHeight` goes
to 188. On a 393pt screen that spans roughly x = 25–367, so the black surface is drawn over
both the clock and the battery indicator, and up to 188pt of transcript. There is no dismiss
— tapping it opens a route.

_Fix:_ cap the width against the container, and let the crown push content down instead of
overlaying it at accessibility sizes.

`Assistant/Components/ActivityCrown.swift:153-169`

### M3 · The expanded island's centre label will truncate — **Medium** **[verify]** · Open

`DynamicIslandExpandedRegion(.center)` renders `thought.label` at
`.subheadline.weight(.semibold)` with `lineLimit(1)`. The centre region is the narrowest slot
in the expanded island, squeezed between leading and trailing. Labels reaching it include
"Working in the background" (25 characters) and tool names like "Saving a note to memory".

_Fix:_ move the label into the bottom region, which has the full width, or shorten the
`AssistantThought` label set for the island specifically.

`AssistantActivityExtension/AssistantActivityWidget.swift:25-30`,
`Assistant/System/AssistantActivityAttributes.swift:16-22`

### P1 · `phaseGlyph` accepts a `compact` flag it never reads — **Polish** · Fixed

Both `compactLeading` and `minimal` pass `compact: true`; the function body ignores the
parameter, so all three presentations get the identically sized glyph.

_Fix:_ size the glyph down for the compact and minimal slots, or drop the parameter so the
call sites stop implying a distinction that is not there.

`AssistantActivityExtension/AssistantActivityWidget.swift:135-148`

---

## Chat transcript and pull-up menu

The transcript has had a lot of motion work put into it. Three of the transitions it declares
are wired to state that nothing animates, so they never play.

### C4 · Message insertion transitions never run — new bubbles pop in — **Critical** · Fixed

`messageRow` declares a careful asymmetric transition: opacity, a 0.986 scale from the bottom
anchor, a 10pt offset. Nothing animates `model.messages` — there is no `withAnimation` around
any mutation in `AppModel`, and no `.animation(…, value: model.messages)` in the view.

A `.transition` only plays inside an animation transaction, so every new message appears
instantly at full size. The same omission silently disables two more:

- the error banner's `.move(edge: .top)` transition — nothing animates `errorMessage`;
- the quick-reply strip's appearance, which is animated for `composerFocused` but not for
  `isSending`, so the composer resizes in a hard step when a turn starts and ends.

The autonomous notice, by contrast, has its `.animation(value: autonomous)` and works, which
is what makes the other three read as oversights rather than intent.

_Fix:_ add `.animation(reduceMotion ? nil : …, value: model.messages)` on the `LazyVStack`,
and value-scoped animations for `errorMessage` and `isSending`.

`Assistant/Views/ChatView.swift:356-382`, `:121-131`, `:900-953`,
`Assistant/AppModel.swift:188-191`

### H3 · The streaming pulse dot does not pulse — **High** · Fixed

`MessageBubble` applies `.symbolEffect(.pulse, options: .repeating)` to a `Circle()`.

`symbolEffect` is declared on `View`, so it compiles, but it only does anything to SF Symbol
content. On a shape it is a silent no-op — the streaming indicator inside the assistant
bubble is a static dot. The same modifier is used correctly on `Image(systemName:)` in
`StatusPill` and in the crown's thinking glyph, so this is a one-off.

_Fix:_ drive it with a `PhaseAnimator` or a `TimelineView` like `ComposerWorkingIndicator`
does, or swap the shape for a symbol.

`Assistant/Components/MessageBubble.swift:111-128`, `Assistant/Components/StatusPill.swift:11-17`

### H4 · Quick replies are unreachable in the normal send-and-wait flow — **High** · Fixed

`sendDraft()` ends with `composerFocused = true`. The quick-reply strip renders only when
`!composerFocused`.

So the keyboard stays up for the whole turn, and when the reply lands carrying its
suggestions, the condition that hides them is still true. The user has to know the strip
exists, dismiss the keyboard, and go looking. The feature is built, styled, and effectively
invisible.

_Fix:_ drop focus when a reply with quick replies arrives, or show the strip above the
keyboard rather than gating it on focus.

`Assistant/Views/ChatView.swift:902`, `:1183-1192`

### H5 · There is no way to stop a running turn — **High** · Fixed

While `isSending`, the send button becomes `ComposerWorkingIndicator` and is disabled.
`pollForReply` runs up to 360 attempts at 1.5s — roughly nine minutes.

A spinner in a button's position reads as a progress indicator, not a control. Every
comparable chat client turns that affordance into stop. The accessibility hint even says
"You can continue drafting while the assistant works" — which is true, and you still cannot
send or cancel.

_Fix:_ swap the glyph to a stop square while sending, and cancel `pollTask` on tap.

`Assistant/Views/ChatView.swift:1018-1074`, `Assistant/AppModel.swift:311-320`

### H6 · The menu's grip is anchored to a different edge than the reveal — **High** **[verify]** · Open

The menu is bottom-aligned inside the safe area — its own background comment says so, which
is why the background carries `.ignoresSafeArea(.container, edges: .bottom)` to fill the
strip beneath it. The conversation surface, meanwhile, ignores the safe area entirely and is
translated up by exactly `menuRevealHeight` from the _screen_ bottom.

Those are two different bottom edges, differing by the bottom safe-area inset — 34pt on any
home-indicator iPhone, 0 on an SE. On the former, the top ~34pt of the menu sits behind the
chat surface: the 26pt top padding plus the entire 4pt grip. Since 89d5b01 scoped the
swipe-to-close gesture to the grip alone, the only drag target left is the ~8pt sliver of its
inset hit area that clears the surface's edge.

The `conversationRevealDistance` comment describes tuning this exact offset away because the
extra inset "left a visible air gap" — that gap is the grip's own padding.

_Fix:_ anchor both to the same edge. Give the menu `.ignoresSafeArea(.container, edges: .bottom)`
with `.safeAreaPadding(.bottom)` on its content, so `menuRevealHeight` means the same thing on
both sides.

`Assistant/Views/ChatView.swift:388-394`, `:440-458`, `:484-504`

### M4 · The close detent's haptic disagrees with the threshold that commits — **Medium** · Fixed

The hysteresis band in `onChanged` runs 56.8–84.8pt (threshold ±14). `onEnded` commits at
`closingCommitmentDistance` — 70.8pt, the band's centre.

Drag straight to anywhere in 70.8–84.8 without first crossing 84.8 and the detent still reads
"stays open"; release and it closes. The feedback and the outcome contradict each other inside
a 14pt window.

_Fix:_ commit on release against the same edge the detent last reported, or compare against
`menuDetentReached` directly.

`Assistant/Views/ChatView.swift:735-763`, `:18-28`

### M5 · Picking a destination snaps the menu shut with no animation — **Medium** · Fixed

`openRoute` assigns `menuOpen`, `menuPullDistance` and `menuCloseDragDistance` directly,
outside any transaction — unlike `closePullMenu()`, which springs.

Tapping "Chat" animates closed; tapping "Goals" teleports. The sheet's slide-up covers most
of it, but the first frames of the presentation show a menu that has already vanished, and it
is visible again on dismissal.

_Fix:_ route it through `setPullMenu(open: false)` and present after.

`Assistant/Views/ChatView.swift:812-820`, `:775-795`

### M6 · The expanded crown draws over the error banner — **Medium** · Fixed

The crown is a `RootView` overlay at `zIndex(100)`, offset up into the cutout; the error
banner is a `ChatView` overlay at safe-area top + 4.

Expanded at default type the crown reaches roughly 76pt below its origin, which lands about
23pt into the banner. At accessibility sizes it is 188pt tall and covers the banner outright,
including its dismiss button.

_Fix:_ offset the banner by the crown's current height, or move both into one top-aligned
stack so they cannot overlap.

The banner moved into the root stack, but the offset it was given was measured from the wrong
origin for that stack and left the overlap in place — see H7, which supersedes this.

`Assistant/Views/RootView.swift:77-91`, `Assistant/Views/ChatView.swift:121-131`

---

## Layout, type and consistency

The app has a genuinely careful accessibility story — `@ScaledMetric` throughout, separate
layouts at `isAccessibilitySize`, contrast-aware strokes. These are the places that fall
outside it.

### M7 · Menu tile labels and badges ignore Dynamic Type entirely — **Medium** · Fixed

The tile titles are `.system(size: 11, weight: .semibold, design: .rounded)` and the badge is
`.system(size: 8, weight: .bold)` — absolute sizes.

They stay 11pt and 8pt through every Dynamic Type step until `isAccessibilitySize` flips the
whole grid to a different layout. Everything else in the app scales: the composer, the
bubbles, the capsule all use `@ScaledMetric`. This is the one surface that does not, and 8pt
is below the floor for a badge at any setting.

_Fix:_ `@ScaledMetric(relativeTo: .caption2)` for both, matching the composer's pattern.

`Assistant/Views/ChatView.swift:643-663`

### M8 · The fixed 236pt menu frame is brittle at large type — **Medium** **[verify]** · Open

`menuRevealHeight` is one hardcoded value for everything between `.large` and
`.accessibility1`, and the content measures ~231pt at default type — five points of slack.

Two things eat it at `.xxxLarge`. The header's two strings carry no `lineLimit`, so
"Assistant workspace" plus the autonomy pill can wrap to a second line. And the tile icon is
`.subheadline` (~23pt at that setting) inside `.frame(height: 18)`, so the glyph overlaps its
own label. Since the container is a hard `.frame(height:)`, the overflow clips rather than
growing.

_Fix:_ measure the menu with `onGeometryChange` and drive `menuRevealHeight` from the result,
rather than three constants.

`Assistant/Views/ChatView.swift:58-73`, `:460-486`, `:636-642`

### P2 · Two sub-44pt targets in the menu — **Polish** · Fixed

The autonomy toggle is `.frame(height: 34)`. The grip is 42×4 with a −12pt content-shape
inset, giving 66×28. Both are below the 44pt minimum, and the grip is the one carrying the
close gesture — see H6, which shrinks its usable area further. The rest of the app is
disciplined about this: the composer, send button, error dismiss and jump-to-latest all
explicitly pad out to 44.

_Fix:_ raise the toggle to 44 and widen the grip's content shape vertically.

`Assistant/Views/ChatView.swift:448-458`, `:600-602`

### P3 · Goals shows two trailing toolbar buttons that do the same thing — **Polish** · Fixed

`RootView.destination(for:)` adds an `xmark` at `.topBarTrailing` for every route.
`GoalsView` adds its own "Open chat" bubble item in the same placement. Both dismiss the
sheet. Goals is the only route with the pair, so it also breaks the header rhythm across the
eight sheets.

_Fix:_ drop the Goals-local toolbar item; the card-level "Continue in chat" button already
covers the intent.

`Assistant/Views/GoalsView.swift:31-40`, `Assistant/Views/RootView.swift:114-123`

### P4 · The approvals header jumps when a decision is in flight — **Polish** · Fixed

`approvalCode` swaps a ~26pt-tall short-code badge for a `ProgressView` in a 44×44 frame,
with no transition. The card header grows by about 18pt the instant you confirm, then snaps
back. It is the most consequential moment in the app — approving a real-world action — and it
is the one that twitches.

_Fix:_ give the container a fixed height and cross-fade the two states.

`Assistant/Views/ApprovalsView.swift:139-156`

### P5 · Two different greens for "done", side by side in the same card — **Polish** · Fixed

`ActivityView.color(for: "done")` returns system `.green`. The `StatusPill` in the same row
returns `AssistantTheme.accent`. System green and the brand's `#217A4B` are visibly different
hues, and the activity card puts the icon and the pill within about 200pt of each other.
`ActivityView` uses raw system colors for done / failed / waiting throughout, where
`StatusPill` uses theme tokens.

_Fix:_ route `ActivityView`'s status colors through the same helper the pill uses.

`Assistant/Views/ActivityView.swift:179-187`, `Assistant/Components/StatusPill.swift:42-49`

### P6 · The composer's placeholder is brighter than the text you type — **Polish** · Fixed

`composerPlaceholderColor` is `stageStrong` at full opacity; `composerTextColor` is the same
white at 0.96. A small inversion, but it runs the wrong way — the prompt outweighs the
content. The comment notes the color was matched to the jump-to-latest label on request, so
the pairing may be deliberate; the relative weighting probably is not.

_Fix:_ drop the placeholder to ~0.6 and take the typed text to 1.0.

`Assistant/Views/ChatView.swift:1095-1113`

### P7 · The autonomous notice hardcodes the light-mode warning pair — **Polish** · Fixed

`Color(hex: 0x5C3A0E)` on `Color(hex: 0xFFE9B7)` — the first is `AssistantTheme.warningInk`'s
light value, the second is a fourth amber not in the theme at all. Defensible, since the
notice sits on the always-dark stage rather than the canvas. But it bypasses
`warningInk(for:)` / `warningSurface(for:)`, so a future change to the warning ramp will not
reach it.

_Fix:_ add a stage-context warning pair to `AssistantTheme` and use it here.

`Assistant/Views/ChatView.swift:956-987`, `Assistant/Design/AssistantTheme.swift:26-30`

### P8 · iPad and landscape ship, but nothing is designed for them — **Polish** · Open

`TARGETED_DEVICE_FAMILY = "1,2"`, and `Info.plist` allows landscape on iPhone and all four
orientations on iPad. The crown, the four-column menu grid, the centered empty state and the
transcript's 40pt bubble gutters are all phone-portrait compositions. The only width-aware
element in the app is `ConnectionView`'s 620pt cap. This is the setting behind C1.

_Fix:_ restrict to iPhone portrait until there is a reason not to — one line in each of two
files.

`Assistant.xcodeproj/project.pbxproj` (`TARGETED_DEVICE_FAMILY`), `Assistant/Info.plist:46-58`

---

## Also noted

Dead code and judgement calls. Worth a look, not filed as findings.

- **Dead branch in `expandedWidth`.** _(Fixed.)_ The `usesAccessibilityLayout ? 8.2 : 6.4`
  character-width ternary sits after an early return for exactly that case, so it always
  evaluates 6.4. `ActivityCrown.swift:154-158`
- **`AssistantTheme.stageMuted` is unreferenced** _(Fixed — removed.)_ — the only token in the file with no reader.
  `AssistantTheme.swift:20`
- **Crown width is estimated from character count.** 6.4pt per character holds at default
  type; between `.large` and `.accessibility1` the caption font grows and the label falls back
  to `minimumScaleFactor(0.82)` instead of the box growing. `ActivityCrown.swift:153-165`
- **The pull gain is 1.55×.** The reveal moves faster than the finger, which partly
  compensates for the scroll view's rubber-band resistance. Worth feeling on device now that
  the jitter fix has landed — it is the kind of number that is either exactly right or
  slightly nauseating. `ChatView.swift:416-424`
- **The user bubble's fill is 4.5% white** — effectively transparent, so the 0.8pt border
  carries the entire shape. Intentional asymmetry against the assistant's paper card, but the
  fill is doing nothing the border is not. `MessageBubble.swift:146-162`
- **The crown's tone tint only appears in one of two layouts.** `crownTone` backs the glyph
  with a 13% circle at default sizes and is dropped entirely at accessibility sizes, where the
  state color survives only in the glyph itself. `ActivityCrown.swift:54-64`
