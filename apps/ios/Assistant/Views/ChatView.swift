import SwiftUI
import UIKit

/// Give the transcript and composer separate layout slots before lifting the
/// stage. Clearance must not depend on a later input measurement or scroll inset.
struct ConversationColumn<Transcript: View, Composer: View>: View {
    @ViewBuilder var transcript: Transcript
    @ViewBuilder var composer: Composer

    var body: some View {
        VStack(spacing: PullMenuMotion.transcriptComposerSpacing) {
            transcript
            composer
        }
    }
}

enum PullMenuMotion {
    /// The menu's touch target must fit entirely in the empty layout gap.
    /// Extending it into the transcript blocks the newest message's controls.
    static let transcriptComposerSpacing: CGFloat = 18

    static func menuRowCount(itemCount: Int, columns: Int) -> Int {
        guard itemCount > 0, columns > 0 else { return 0 }
        return (itemCount + columns - 1) / columns
    }
    /// A projected flick still needs enough real travel to read as a swipe.
    /// This keeps a tiny, quick probe from inheriting an exaggerated UIKit
    /// prediction and crossing a detent the finger never approached.
    static let minimumFlickTravel: CGFloat = 32
    static let maximumFlickDuration: TimeInterval = 0.2
    /// Do not decide an axis from the first few noisy touch samples. Real
    /// fingers often move 2–6pt sideways before settling into a vertical
    /// swipe, especially when starting on the composer.
    static let verticalIntentDistance: CGFloat = 10
    static let horizontalLockDistance: CGFloat = 12
    static let axisDominance: CGFloat = 1.15

    static func unit(_ value: CGFloat) -> CGFloat {
        min(max(value, 0), 1)
    }

    static func smoothStep(_ value: CGFloat) -> CGFloat {
        let progress = unit(value)
        return progress * progress * (3 - (2 * progress))
    }

    /// The composer is positioned in the conversation surface's own coordinate
    /// space. This spacing never depends on reveal progress, gesture phase, or
    /// the device safe area; the green surface is the sole owner of vertical
    /// menu motion.
    static let composerSurfaceBottomSpacing: CGFloat = 12

    /// Returns a bottom-up row rank for a row-major collection. Items in the
    /// same visual row share a rank; zero is the first row to become visible.
    static func bottomUpFadeRank(
        itemIndex: Int,
        itemCount: Int,
        columns: Int
    ) -> Int {
        guard itemIndex >= 0, itemCount > 0, columns > 0 else { return 0 }
        let boundedIndex = min(itemIndex, itemCount - 1)
        let rowCount = (itemCount + columns - 1) / columns
        let row = boundedIndex / columns
        return max(rowCount - row - 1, 0)
    }

    /// Converts an upward drag into a stable, bounded menu reveal. Keeping
    /// this independent from the scroll view makes a reversing finger return
    /// along the same path rather than letting UIKit's rubber-band add motion.
    static func openingDistance(translationY: CGFloat, revealHeight: CGFloat) -> CGFloat {
        min(max(-translationY, 0), max(revealHeight, 0))
    }

    /// Resolve the full sheet travel once, including the device's bottom safe
    /// area, instead of adding that inset again as the finger moves.
    static func menuRevealHeight(
        contentHeight: CGFloat,
        bottomSafeAreaInset: CGFloat
    ) -> CGFloat {
        max(contentHeight, 0) + max(bottomSafeAreaInset, 0)
    }

    /// The green conversation is a rigid transform: one point of live reveal
    /// always produces exactly one point of surface movement.
    static func conversationSurfaceOffset(revealDistance: CGFloat) -> CGFloat {
        max(revealDistance, 0)
    }

    static func projectedOpeningDistance(
        translationY: CGFloat,
        predictedEndTranslationY: CGFloat,
        revealHeight: CGFloat
    ) -> CGFloat {
        openingDistance(
            translationY: min(translationY, predictedEndTranslationY),
            revealHeight: revealHeight
        )
    }

    static func closingDistance(translationY: CGFloat, revealHeight: CGFloat) -> CGFloat {
        min(max(translationY, 0), max(revealHeight, 0))
    }

    static func projectedClosingDistance(
        translationY: CGFloat,
        predictedEndTranslationY: CGFloat,
        revealHeight: CGFloat
    ) -> CGFloat {
        closingDistance(
            translationY: max(translationY, predictedEndTranslationY),
            revealHeight: revealHeight
        )
    }

    /// Uses momentum only for an unmistakable flick. Slow or shallow drags
    /// release where the finger actually stopped, which makes both menu
    /// detents feel stable instead of prediction-driven.
    static func releaseDistance(
        actualDistance: CGFloat,
        projectedDistance: CGFloat,
        gestureDuration: TimeInterval?
    ) -> CGFloat {
        guard projectedDistance > actualDistance,
              actualDistance >= minimumFlickTravel,
              gestureDuration.map({ $0 <= maximumFlickDuration }) ?? true
        else { return actualDistance }

        return projectedDistance
    }

    /// Keeps a horizontal accessibility-menu swipe from tugging the sheet.
    /// A diagonal only becomes dismissal once downward travel is dominant.
    static func hasClosingIntent(translationX: CGFloat, translationY: CGFloat) -> Bool {
        translationY >= verticalIntentDistance
            && translationY >= abs(translationX) * axisDominance
    }

    /// The composer is both a text control and the opening grab region. Only
    /// a clearly upward drag should hand that touch to the sheet; horizontal
    /// cursor movement and ambiguous diagonals stay with the text field.
    static func hasOpeningIntent(translationX: CGFloat, translationY: CGFloat) -> Bool {
        -translationY >= verticalIntentDistance
            && -translationY >= abs(translationX) * axisDominance
    }

    /// Locks out a horizontal control only after the sideways movement is
    /// both substantial and clearly dominant. Until then the gesture remains
    /// undecided, allowing an initially wobbly finger to become a valid pull.
    static func hasHorizontalIntent(translationX: CGFloat, translationY: CGFloat) -> Bool {
        abs(translationX) >= horizontalLockDistance
            && abs(translationX) >= abs(translationY) * axisDominance
    }

    static func openingCommitmentDistance(revealHeight: CGFloat) -> CGFloat {
        // Keep the committed pull short and physical rather than scaling it
        // with the whole menu. The normal menu is tall because it holds two
        // rows of destinations, but requiring a third of it made slow drags
        // travel more than 80pt before opening. Accessibility layouts should
        // not need an even longer pull either.
        guard revealHeight > 0 else { return 0 }
        return min(max(revealHeight * 0.25, 48), 60)
    }

    static func closingCommitmentDistance(revealHeight: CGFloat) -> CGFloat {
        guard revealHeight > 0 else { return 0 }
        return min(max(revealHeight * 0.22, 44), 56)
    }

    static func commitsToOpen(revealDistance: CGFloat, revealHeight: CGFloat) -> Bool {
        revealDistance >= openingCommitmentDistance(revealHeight: revealHeight)
    }

    /// Slack around the closing detent, so a drag hovering at the threshold
    /// does not toggle the haptic every point.
    static let detentHysteresis: CGFloat = 12

    /// Retains the opening detent within a small release band. This ensures a
    /// finger that felt the open haptic does not unexpectedly snap closed when
    /// it lifts a few points short of the bare threshold.
    static func holdsOpeningDetent(
        revealDistance: CGFloat,
        revealHeight: CGFloat,
        detentHeld: Bool
    ) -> Bool {
        let threshold = openingCommitmentDistance(revealHeight: revealHeight)
        return detentHeld
            ? revealDistance > threshold - detentHysteresis
            : revealDistance >= threshold
    }

    /// Whether a release at this distance closes the menu.
    ///
    /// Both the live detent and the release decision go through here so they
    /// cannot disagree. They used to: the detent applied the hysteresis and the
    /// release compared against the bare threshold, so a drag that stopped
    /// anywhere in the upper half of the band reported "stays open" and then
    /// closed anyway.
    static func closesOnRelease(
        dragDistance: CGFloat,
        revealHeight: CGFloat,
        detentHeld: Bool
    ) -> Bool {
        let threshold = closingCommitmentDistance(revealHeight: revealHeight)
        return detentHeld
            ? dragDistance >= threshold + detentHysteresis
            : dragDistance > threshold - detentHysteresis
    }
}

struct TranscriptFollowState {
    private(set) var followsLatest = true

    /// Content growth can move the visible bottom before an incoming-message
    /// callback runs. Only reader-driven scrolling changes the follow choice.
    mutating func observe(atBottom: Bool, phase: ScrollPhase) {
        guard phase == .interacting || phase == .decelerating else { return }
        followsLatest = atBottom
    }

    mutating func resume() {
        followsLatest = true
    }

    func shouldPin(userIsDragging: Bool) -> Bool {
        followsLatest && !userIsDragging
    }
}

/// The transcript's live scroll offset, deliberately held in a reference type
/// rather than in `@State`. Jump to latest needs the offset the instant it is
/// pressed, but storing a value that changes on every scrolled frame in view
/// state would re-evaluate the whole conversation at display rate.
///
/// The value is kept in content space — distance from the top of the content,
/// zero at rest against the crown clearance — because `ScrollPosition` offsets
/// the content insets itself, while `ScrollGeometry.contentOffset` does not.
private final class TranscriptScrollTracker {
    var contentPosition: CGFloat = 0
}

/// Resolve each row's preceding user prompt in one pass over the log, avoiding
/// a backwards scan of the transcript for every rendered row.
struct TranscriptContext {
    /// For each message, the nearest user message before it, as its text. The
    /// text is read once per user turn here rather than once per row that asks
    /// for it: joining a message's parts is not free either.
    private let precedingUserPrompts: [String?]

    init(messages: [ChatMessage]) {
        var prompts: [String?] = []
        prompts.reserveCapacity(messages.count)
        var promptSoFar: String?

        for message in messages {
            // Appended before this message is considered, so a user turn is
            // never offered as the prompt for itself.
            prompts.append(promptSoFar)
            if message.role == .user { promptSoFar = message.text }
        }

        precedingUserPrompts = prompts
    }

    func userPrompt(before index: Int) -> String? {
        guard precedingUserPrompts.indices.contains(index) else { return nil }
        return precedingUserPrompts[index]
    }
}

/// The eager transcript has a boundary of its own: typing and pulling the menu
/// must not regroup receipts, resolve prompts, or visit every row builder.
/// Actions capture the same AppModel and state bindings for this screen's life;
/// availability changes are represented by `isSending`, not changing closures.
struct ChatTranscriptRows: View, Equatable {
    let messages: [ChatMessage]
    let isSending: Bool
    let openApprovals: () -> Void
    let send: (String, Bool) -> Void
    let decideApproval: (String, String) async -> Bool
    let rememberApproval: (String) async -> Bool
    let decideSuggestion: (String, SuggestionDecision) async -> String?
    let openActivity: () -> Void
    let refreshCard: (String) async -> String?
    let hideMessage: (ChatMessage) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.messages == rhs.messages && lhs.isSending == rhs.isSending
    }

    var body: some View {
        let items = messages.transcriptItems()
        let context = TranscriptContext(messages: messages)
        VStack(spacing: 0) {
            ForEach(items) { item in
                row(item, context: context)
                    .padding(.top, startsRun(at: item.firstIndex) ? 22 : 7)
                    .transition(
                        reduceMotion ? .opacity : .asymmetric(
                            insertion: .opacity
                                .combined(with: .scale(scale: 0.986, anchor: .bottom))
                                .combined(with: .offset(y: 10)),
                            removal: .opacity
                        )
                    )
                    .id(item.id)
            }
        }
        // Token growth changes content, not this identity list. New messages
        // reveal once without restarting geometry animation for each token.
        .animation(reduceMotion ? nil : .snappy(duration: 0.3, extraBounce: 0.02), value: messages.map(\.id))
    }

    @ViewBuilder
    private func row(_ item: ChatTranscriptItem, context: TranscriptContext) -> some View {
        switch item {
        case let .message(message, index):
            MessageBubble(
                message: message,
                userPrompt: context.userPrompt(before: index),
                isStreaming: message.id.hasPrefix("stream-") && isSending,
                openApprovals: openApprovals,
                runForReal: isSending ? nil : { send($0, true) },
                retry: isSending ? nil : { send($0, false) },
                decideApproval: decideApproval,
                rememberApproval: rememberApproval,
                decideSuggestion: decideSuggestion,
                openActivity: openActivity,
                refreshCard: refreshCard,
                hide: message.isDurableLogRow ? { hideMessage(message) } : nil
            )
            .equatable()
        case let .approvedReceiptGroup(receipts, _):
            ApprovedReceiptGroup(messages: receipts).equatable()
        }
    }

    private func startsRun(at index: Int) -> Bool {
        index == 0 || messages[index - 1].role != messages[index].role
    }
}

struct ChatView: View {
    let safeAreaTopInset: CGFloat
    let safeAreaBottomInset: CGFloat
    let safeAreaLeadingInset: CGFloat
    let safeAreaTrailingInset: CGFloat

    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @ScaledMetric(relativeTo: .body) private var composerFontSize = 16.0
    // The directory labels need the same legibility as the content cards.
    // Scaling from subheadline keeps the two-column sheet readable before it
    // switches to the dedicated extra-large accessibility layout.
    @ScaledMetric(relativeTo: .subheadline) private var menuTileFontSize = 16.0
    @ScaledMetric(relativeTo: .caption2) private var menuBadgeFontSize = 9.0
    @State private var draft = ""
    @State private var draftScope: ComposerDraftScope?
    @State private var isAtBottom = true
    @State private var transcriptFollow = TranscriptFollowState()
    // Opening requires the actual bottom edge. `isAtBottom` deliberately has
    // a wider 64pt tolerance for unread-state UI and is too permissive for
    // deciding whether an upward transcript drag means scroll or menu.
    @State private var isAtMenuOpeningEdge = true
    @State private var hasUnseenMessages = false
    @State private var composerHeight: CGFloat = 0
    @State private var scrollRequest = 0
    // A direct "Jump to latest" owns the scroll position until it has had a
    // chance to supersede an automatic scroll that may already be in flight.
    #if DEBUG
    private var visualReviewMenuIsOpen = false
    #endif
    @State private var latestJumpRequest = 0
    // Unpositioned by default so normal finger scrolling remains authoritative.
    // Jump to latest writes an explicit edge only for that owner action.
    @State private var transcriptScrollPosition = ScrollPosition()
    @State private var transcriptScroll = TranscriptScrollTracker()
    @State private var hasPositionedInitialConversation = false
    @State private var menuPullDistance: CGFloat = 0
    @State private var menuCloseDragDistance: CGFloat = 0
    @State private var menuPullActive = false
    @State private var menuOpenGestureStartedAt: Date?
    @State private var menuOpenGestureIsHorizontal = false
    @State private var menuCloseGestureStartedAt: Date?
    @State private var menuCloseGestureIsHorizontal = false
    // GestureState resets on both release and cancellation. The drag callbacks
    // alone cannot recover when SwiftUI cancels a recognizer during a layout or
    // focus change, leaving the sheet visually closed but still blocking taps.
    @GestureState private var menuOpeningDragActive = false
    @GestureState private var menuClosingDragActive = false
    @State private var menuOpen = false
    // Hold transient overlays back from the first pull until the close
    // spring finishes, including when a closing gesture is reversed.
    @State private var menuSurfaceActive = false
    @State private var menuDetentReached = false
    @State private var menuDetentFeedback = 0
    @State private var menuAutonomyFeedback = 0
    @State private var transcriptScrollPhase: ScrollPhase = .idle
    @State private var sendFeedback = 0
    @State private var jumpFeedback = 0
    // `ComposerTextInput` owns a UIKit responder rather than a SwiftUI view
    // carrying `.focused`. A FocusState without that SwiftUI association is
    // reconciled back to its default on a body update, which resigns the text
    // view after each typed character. Keep this as ordinary view state and
    // let the UIKit delegate report real responder changes instead.
    @State private var composerFocused = false

    // Dictation writes into the composer rather than sending: a misheard word
    // is ordinary, and this assistant acts on what it is told. The draft as it
    // stood when the button went down is kept so speech adds to what was typed
    // instead of replacing it.
    @StateObject private var listener = SpeechListener()
    @State private var draftBeforeDictation = ""
    @State private var dictationScope: ComposerDraftScope?
    @State private var pushToTalkActive = false
    @State private var micPressActive = false
    @GestureState private var micTouchDown = false
    @State private var micHoldConsumed = false
    @State private var micStopping = false
    /// A tap leaves the microphone on without a finger holding it down. The
    /// button stays in its active state until it is tapped again.
    @State private var micLatched = false
    @State private var showingTalk = false

    // The menu is a short, two-column directory rather than a tiny icon grid.
    // Its content follows Dynamic Type; the reveal adds the device bottom inset
    // once so the menu frame and green surface share one physical distance.
    private var menuContentHeight: CGFloat {
        26 + 4 + 11 + menuActionsHeight
    }

    private var menuRevealHeight: CGFloat {
        PullMenuMotion.menuRevealHeight(
            contentHeight: menuContentHeight,
            bottomSafeAreaInset: deviceBottomSafeAreaInset
        )
    }

    private var menuActionsHeight: CGFloat {
        if isLandscape {
            return (3 * menuButtonHeight) + 13 + menuAutonomyHeight
        }
        if usesExtraLargeAccessibilityMenu {
            return menuButtonHeight + 10 + menuAutonomyHeight
        }
        // Count the partially filled final row too. Adding People created a
        // fifth row; a four-row frame left Auto next below the visible sheet.
        let rows = PullMenuMotion.menuRowCount(itemCount: pullMenuItemCount, columns: 2)
        return (CGFloat(rows) * menuButtonHeight) + 26 + menuAutonomyHeight
    }

    private var menuButtonHeight: CGFloat {
        if isLandscape { return 58 }
        if usesExtraLargeAccessibilityMenu { return 92 }
        return dynamicTypeSize.isAccessibilitySize ? 76 : 64
    }

    private var menuAutonomyHeight: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 58 : 50
    }

    private var usesExtraLargeAccessibilityMenu: Bool {
        dynamicTypeSize >= .accessibility4
    }

    private var isLandscape: Bool { verticalSizeClass == .compact }

    private var crownOnLeadingEdge: Bool {
        safeAreaLeadingInset > safeAreaTrailingInset
    }

    private var landscapeCrownClearance: CGFloat {
        isLandscape ? 196 : 0
    }

    var body: some View {
        GeometryReader { viewport in
            ZStack(alignment: .bottom) {
                pullMenu

                conversationSurface
                    // Resolve a stable viewport before the surface is
                    // transformed. A flexible max-height frame was recomputed
                    // as the lifted surface crossed the root safe area, shrinking
                    // the transcript by 96pt while the composer kept moving.
                    .frame(width: viewport.size.width, height: viewport.size.height)
                    // Keep the stage edge-to-edge inside the currently available
                    // chat region while respecting the keyboard safe area.
                    .background(stageBackdrop.ignoresSafeArea(.container))
                    // Use the input's curve rather than inheriting the larger
                    // device corners. The radius follows the live reveal and
                    // goes square above the keyboard so the menu cannot show
                    // through the bottom corners while typing.
                    .clipShape(
                        RoundedRectangle(
                            cornerRadius: menuSheetCornerRadius,
                            style: .continuous
                        )
                    )
                    .shadow(
                        color: .black.opacity(0.17 * menuSurfaceProgress),
                        radius: 28 * menuSurfaceProgress,
                        y: 14 * menuSurfaceProgress
                    )
                    // Resolve the complete green surface edge-to-edge before it is
                    // transformed. When `ignoresSafeArea` wrapped the offset view,
                    // SwiftUI recomputed the ScrollView's bottom content inset as
                    // the sheet crossed the device boundary; the transcript then
                    // slid by roughly one home-indicator inset while the composer
                    // stayed put. With offset outermost, this is one rigid layer.
                    .ignoresSafeArea(.container)
                    .offset(y: -conversationRevealDistance)
                    // At the largest accessibility sizes the destination row is
                    // horizontally scrollable, so the lifted conversation owns
                    // one of the dedicated vertical-close regions instead of a
                    // recognizer spanning that strip.
                    .simultaneousGesture(
                        pullMenuCloseGesture,
                        including: menuOpen && usesExtraLargeAccessibilityMenu ? .all : .subviews
                    )

                if !menuOpen {
                    pullMenuOpenGestureTarget
                }
            }
            .background {
                // The keyboard's rounded corners expose this backing below the
                // chat viewport. Continue the stage gradient's bottom shade;
                // the plain stage green leaves a visible seam at that boundary.
                stageBottomBackdrop
                    .ignoresSafeArea()
            }
            // The conversation surface is visually above the revealed submenu.
            // Once open, observe its vertical dismissal drag across both surfaces
            // without stealing the horizontal swipe used by the extra-large
            // accessibility menu. The 10pt threshold leaves tile taps untouched;
            // Disable only this recognizer while closed. `.none` also disables
            // descendant gestures, including the suggestion and approval buttons.
            .simultaneousGesture(
                pullMenuCloseGesture,
                including: menuOpen && !usesExtraLargeAccessibilityMenu ? .all : .subviews
            )
            .toolbar(.hidden, for: .navigationBar)
            .sensoryFeedback(.selection, trigger: menuDetentFeedback)
            .sensoryFeedback(.selection, trigger: menuAutonomyFeedback)
            .sensoryFeedback(.impact(weight: .light), trigger: sendFeedback)
            .sensoryFeedback(.selection, trigger: jumpFeedback)
            .onChange(of: model.presentedRoute) { _, route in
                // Menu tiles already close themselves before navigating. This
                // catches routes presented from notifications, deep links, or the
                // activity crown so Back never reveals a stale open sheet.
                if route != nil, menuOpen || menuPullActive {
                    closePullMenu()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase != .active else { return }
                settleInterruptedMenuGesture()
            }
            .onChange(of: menuOpeningDragActive) { wasActive, isActive in
                guard wasActive, !isActive else { return }
                settleCancelledMenuGestureAfterRelease()
            }
            .onChange(of: menuClosingDragActive) { wasActive, isActive in
                guard wasActive, !isActive else { return }
                settleCancelledMenuGestureAfterRelease()
            }
            .onAppear {
                synchronizeComposer()
                #if DEBUG
                if visualReviewMenuIsOpen { setPullMenu(open: true) }
                #endif
            }
            .onDisappear {
                if let draftScope { model.saveComposerDraft(draft, in: draftScope) }
                dictationScope = nil
                stopMicrophone(focusingComposer: false)
            }
            .onChange(of: model.composerDraftScope) { _, _ in synchronizeComposer() }
            .onChange(of: draft) { _, text in
                if let draftScope { model.saveComposerDraft(text, in: draftScope) }
            }
            .onChange(of: model.composerRecoveryRevision) { _, _ in
                restoreUnsentMessageIfPossible()
            }
            .onChange(of: model.packDiscussionDraft) { _, requested in
                guard requested != nil, let prompt = model.consumePackDiscussionDraft() else { return }
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft = prompt
                } else {
                    model.errorMessage = "Your current draft is preserved. Send or clear it before discussing the pack."
                }
            }
        }
        // Resolve the full container before reading `viewport.size`; the
        // keyboard is a separate safe-area region and remains respected.
        .ignoresSafeArea(.container)
    }

    /// The transcript and the root error banner clear the Island by exactly the
    /// same distance, from the same origin — both scroll and sit under a stack
    /// that ignores the top safe area. One expression for both, because the two
    /// drifting apart is what previously left the banner behind the pill.
    private var crownContentTopInset: CGFloat {
        if isLandscape { return 0 }
        return ActivityCrown.overlayTopInset(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
            isExpanded: model.activityThought != nil,
            safeAreaTopInset: safeAreaTopInset
        )
    }

    private var stageBottomDepthOpacity: Double {
        colorScheme == .dark ? 0.16 : 0.1
    }

    private var stageBottomBackdrop: some View {
        ZStack {
            AssistantTheme.stage(for: colorScheme)
            AssistantTheme.stageDepth.opacity(stageBottomDepthOpacity)
        }
    }

    private var stageBackdrop: some View {
        ZStack {
            AssistantTheme.stage(for: colorScheme)

            LinearGradient(
                stops: [
                    .init(color: .white.opacity(colorScheme == .dark ? 0.035 : 0.07), location: 0),
                    .init(color: .clear, location: 0.38),
                    .init(color: AssistantTheme.stageDepth.opacity(stageBottomDepthOpacity), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            RadialGradient(
                colors: [
                    .white.opacity(colorScheme == .dark ? 0.035 : 0.075),
                    .clear,
                ],
                center: UnitPoint(x: 0.5, y: 0.04),
                startRadius: 0,
                endRadius: 260
            )
        }
    }

    private var conversationSurface: some View {
        return Group {
            ConversationColumn {
                ScrollView {
                    // Deliberately eager, and the one thing here that is.
                    //
                    // The transcript's viewport ends 18pt above the composer,
                    // and `scrollClipDisabled` below is what lets the strip
                    // under the input keep showing the log. It can only draw
                    // rows that exist, though, and a lazy stack stops vending
                    // one once it leaves that viewport — so a bubble on its way
                    // down was built, drawn under the glass, and then dropped a
                    // few points later, blinking out of existence a whole
                    // composer above the bottom of the screen.
                    //
                    // Building every row costs a long thread real work at open.
                    // The alternative is a viewport that reaches the bottom of
                    // the stage, and that is not free either: it puts the
                    // scroll view in contact with geometry that moves under the
                    // pull menu, and the transcript slid 10pt against the
                    // composer for it. A row that exists cannot flicker.
                    Group {
                        if model.messages.isEmpty {
                            VStack(spacing: 0) { emptyConversation }
                        } else {
                            ChatTranscriptRows(
                                messages: model.messages,
                                isSending: model.isSending,
                                openApprovals: { model.present(.approvals) },
                                send: { model.send($0, force: $1) },
                                decideApproval: { await model.decideApproval(id: $0, decision: $1) },
                                rememberApproval: { await model.approveAndRemember(id: $0) },
                                decideSuggestion: { await model.decideSuggestion(id: $0, decision: $1) },
                                openActivity: { openRoute(.activity) },
                                refreshCard: { await model.refreshSavedCard(id: $0) },
                                hideMessage: { message in Task { await model.hideMessage(message) } }
                            )
                            .equatable()
                        }
                    }
                    .padding(.leading, AssistantTheme.compactGutter + (crownOnLeadingEdge ? landscapeCrownClearance : 0))
                    .padding(.trailing, AssistantTheme.compactGutter + (crownOnLeadingEdge ? 0 : landscapeCrownClearance))
                }
                // Older rows continue beneath the floating input and off the
                // bottom of the screen while scrolling — the stack above is
                // eager so that every one of them is there to draw. Clip at the
                // outer stage, not this shorter viewport.
                .scrollClipDisabled()
                .scrollIndicators(.hidden)
                .scrollPosition($transcriptScrollPosition)
                // Menu reveal is a transform of the parent surface. SwiftUI's
                // automatic content-offset preservation must not counter-transform
                // this child ScrollView as the surface crosses safe-area geometry.
                // Disable that adjustment only while the menu owns the surface;
                // normal message, keyboard, and Dynamic Type updates retain the
                // platform behavior at rest.
                .transaction { transaction in
                    if menuOwnsConversationSurface {
                        transaction.scrollContentOffsetAdjustmentBehavior = .disabled
                    }
                }
                // Reserve real layout room for the crown at the start of the
                // conversation. Unlike the removed clear mask, this cannot slice
                // through a message bubble or its text. The 8pt gap that used to be
                // added here is inside the clearance now — it is the same gap the
                // error banner needs, so it belongs with the geometry.
                .contentMargins(
                    .top,
                    crownContentTopInset,
                    for: .scrollContent
                )
                // Never toggle `scrollDisabled` as the menu moves. That cancels
                // UIScrollView's active pan by changing its environment and makes
                // SwiftUI re-anchor the transcript inside the moving surface.
                .scrollDismissesKeyboard(.interactively)
                // Keep following while replies arrive, including streamed text.
                // Only scrolling away releases the anchor; a growing message
                // must not be mistaken for the reader moving up the transcript.
                // A live transcript belongs at its newest edge. The briefing
                // cards are a dashboard, though, so their first card should be
                // the opening view rather than the prompt launcher at the end.
                .defaultScrollAnchor(
                    model.messages.isEmpty ? .top : (pinsTranscriptToBottom ? .bottom : nil)
                )
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    let contentFits =
                        geometry.contentSize.height <= geometry.containerSize.height + 1
                    return contentFits
                        || geometry.visibleRect.maxY >= geometry.contentSize.height - 64
                } action: { _, atBottom in
                    isAtBottom = atBottom
                    if transcriptScrollPosition.isPositionedByUser {
                        transcriptFollow.observe(atBottom: atBottom, phase: transcriptScrollPhase)
                    }
                    if atBottom {
                        hasUnseenMessages = false
                    }
                }
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    let contentFits =
                        geometry.contentSize.height <= geometry.containerSize.height + 1
                    return contentFits
                        || geometry.visibleRect.maxY >= geometry.contentSize.height - 2
                } action: { _, atOpeningEdge in
                    isAtMenuOpeningEdge = atOpeningEdge
                }
                // Recorded outside view state on purpose — see
                // `TranscriptScrollTracker`. Jump to latest reads it to stop an
                // in-flight scroll exactly where the transcript currently sits.
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    geometry.contentOffset.y + geometry.contentInsets.top
                } action: { _, position in
                    transcriptScroll.contentPosition = position
                }
                .onScrollPhaseChange { oldPhase, newPhase, context in
                    let geometry = context.geometry
                    let atBottom = geometry.contentSize.height <= geometry.containerSize.height + 1
                        || geometry.visibleRect.maxY >= geometry.contentSize.height - 64
                    // Include the final position after a drag or its momentum.
                    // Programmatic scrolls and layout updates do not opt out.
                    if newPhase != .idle || transcriptScrollPosition.isPositionedByUser {
                        transcriptFollow.observe(
                            atBottom: atBottom,
                            phase: newPhase == .idle ? oldPhase : newPhase
                        )
                    }
                    transcriptScrollPhase = newPhase
                }
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 0.22),
                    value: model.activityThought != nil
                )
                .onAppear {
                    positionInitialConversationIfNeeded()
                }
                .onChange(of: model.messages) { oldMessages, newMessages in
                    if newMessages.isEmpty {
                        hasPositionedInitialConversation = false
                    } else if !hasPositionedInitialConversation {
                        positionInitialConversationIfNeeded()
                    } else if transcriptFollow.followsLatest {
                        // While a finger is on the transcript the gesture owns the
                        // scroll position — re-anchoring here would fight the drag.
                        guard !userIsDraggingTranscript else { return }
                        let isStreamingUpdate =
                            newMessages.count == oldMessages.count
                            && newMessages.last?.id.hasPrefix("stream-") == true
                        // Follow token growth without restarting an animation
                        // on every chunk. New messages retain their reveal.
                        scrollToBottom(animated: !isStreamingUpdate)
                    } else {
                        hasUnseenMessages = true
                    }
                }
                .onChange(of: scrollRequest) { _, _ in
                    scrollToBottom()
                }
                .onChange(of: model.latestQuickReplies) { _, replies in
                    // Suggestions only render while the composer is unfocused, and
                    // sendDraft deliberately keeps the keyboard up — so a reply's
                    // quick replies were never reachable without dismissing it by
                    // hand. Yield focus when one actually arrives, unless the
                    // reader has already started typing a follow-up.
                    guard !replies.isEmpty, !model.isSending, draft.isEmpty else { return }
                    composerFocused = false
                }
                .onChange(of: composerHeight) { previousHeight, _ in
                    // Only the first measurement needs help landing on the latest
                    // message. Ongoing changes — the keyboard animating in, the
                    // field growing — are followed automatically by the bottom
                    // scroll anchor inside the keyboard's own animation; an
                    // explicit scroll here stepped the transcript in jumps.
                    guard previousHeight == 0 else { return }
                    var transaction = Transaction()
                    transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        transcriptScrollPosition.scrollTo(edge: .bottom)
                    }
                }

            } composer: {
                // Keep the transcript and composer as siblings. When the
                // composer was a ScrollView overlay, UIKit's pan recognizer
                // still received pulls that began on the input and shifted the
                // transcript before the menu gesture took over.
                composer
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: isLandscape ? 680 : .infinity)
                    .frame(maxWidth: .infinity)
                    // A plain, explicit padding is deliberate. Safe-area
                    // padding is recomputed when this transformed surface
                    // crosses the device safe-area boundary, and an offset
                    // would let transcript cancellation move the field without
                    // moving its green background. The parent surface alone
                    // owns every point of reveal motion.
                    .padding(.bottom, PullMenuMotion.composerSurfaceBottomSpacing)
                    .onGeometryChange(for: CGFloat.self) { geometry in
                        geometry.size.height
                    } action: { height in
                        composerHeight = height
                    }

            }
            .overlay(alignment: .bottom) {
                VStack(spacing: 10) {
                    if showsJumpToLatest {
                        jumpToLatestButton {
                            jumpFeedback += 1
                            jumpToLatest()
                        }
                        .transition(.opacity)
                    }
                    if let undo = model.hiddenMessageUndo {
                        hiddenMessageUndoBar(undo)
                            .transition(.opacity)
                    }
                    if let draftScope, model.hasComposerRecovery(in: draftScope) {
                        VStack(spacing: 5) {
                            Button {
                                restoreUnsentMessageIfPossible()
                                composerFocused = true
                            } label: {
                                Label("Restore unsent message", systemImage: "arrow.uturn.backward")
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 14)
                                    .frame(minHeight: 44)
                                    .background(AssistantTheme.bubblePaper(for: colorScheme), in: Capsule())
                                    .foregroundStyle(AssistantTheme.bubblePaperInk(for: colorScheme))
                            }
                            .buttonStyle(.plain)
                            .disabled(!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityHint("Send or clear your current draft before restoring the message that did not send.")
                            if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text("Send or clear this draft to restore your earlier message.")
                                    .font(.caption)
                                    .foregroundStyle(AssistantTheme.stageSecondary)
                                    .multilineTextAlignment(.center)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 4)
                                    .background(AssistantTheme.stageWell(for: colorScheme), in: Capsule())
                            }
                        }
                    }
                }
                .padding(.bottom, composerHeight + 12)
            }
            .allowsHitTesting(!menuOpen)
            // Match the visual modal state for assistive navigation: the
            // transcript remains mounted behind the lifted sheet, but it
            // should not compete with the revealed destinations.
            .accessibilityHidden(menuOpen)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: showsJumpToLatest)
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.16),
                value: model.hiddenMessageUndo
            )
        }
        // Talk mode takes the whole screen because it is the whole interface:
        // no transcript, no composer, nothing to look at while it is in use.
        .fullScreenCover(isPresented: $showingTalk) {
            TalkView().environmentObject(model)
        }
    }

    private var menuRevealProgress: CGFloat {
        min(max(visibleMenuRevealDistance / menuRevealHeight, 0), 1)
    }

    private var visibleMenuRevealDistance: CGFloat {
        max(0, menuPullDistance - menuCloseDragDistance)
    }

    private var conversationRevealDistance: CGFloat {
        // The safe-area allowance is part of `menuRevealHeight`, so the live
        // surface transform is exactly the finger/reveal distance. Adding an
        // interpolated inset here made the whole conversation outrun the menu.
        PullMenuMotion.conversationSurfaceOffset(
            revealDistance: visibleMenuRevealDistance
        )
    }

    private var deviceBottomSafeAreaInset: CGFloat {
        // This is physical menu geometry, not the view's current layout safe
        // area. GeometryProxy.safeAreaInsets.bottom can expand to include the
        // software keyboard; feeding that height into the always-mounted menu
        // makes the conversation surface keep its full-screen height and leaves
        // the composer behind the keyboard.
        max(
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow)?
                .safeAreaInsets.bottom ?? 0,
            0
        )
    }

    private var composerSurfaceInset: CGFloat { AssistantTheme.compactGutter }

    private var menuSheetCornerRadius: CGFloat {
        // Focus removes the curve before the keyboard arrives; the live inset
        // keeps it square until the keyboard has finished leaving. This also
        // covers an interactive keyboard dismissal after focus has changed.
        guard !composerFocused,
              safeAreaBottomInset <= deviceBottomSafeAreaInset + 1
        else { return 0 }

        let restingRadius: CGFloat = 17
        // The input has the same inset at the sides and bottom. Expanding its
        // radius by that inset gives the open surface the same corner centers.
        let openRadius = AssistantTheme.conversationCornerRadius + composerSurfaceInset
        return restingRadius + (openRadius - restingRadius) * menuSurfaceProgress
    }

    private var menuSurfaceProgress: CGFloat {
        PullMenuMotion.smoothStep(menuRevealProgress)
    }

    private func organicProgress(_ value: CGFloat) -> CGFloat {
        let progress = min(max(value, 0), 1)
        let remaining = 1 - progress
        return 1 - (remaining * remaining * remaining)
    }

    private func menuElementProgress(after start: CGFloat) -> CGFloat {
        guard start < 1 else { return menuRevealProgress >= 1 ? 1 : 0 }
        return min(max((menuRevealProgress - start) / (1 - start), 0), 1)
    }

    private func menuVisibilityProgress(after start: CGFloat) -> CGFloat {
        let progress = menuElementProgress(after: start)
        return progress * progress * (3 - (2 * progress))
    }

    private func finishPullMenu(releasedAt releaseDistance: CGFloat) {
        setPullMenu(
            open: PullMenuMotion.holdsOpeningDetent(
                revealDistance: releaseDistance,
                revealHeight: menuRevealHeight,
                detentHeld: menuDetentReached
            )
        )
    }

    private func pullMenuOpenGesture(
        requiresTranscriptBottom: Bool,
        minimumDistance: CGFloat = 0
    ) -> some Gesture {
        // The empty gap can claim the pan immediately. The input supplies an
        // 8pt threshold so its native tap and text-selection gestures still work.
        // Read the pull in the window coordinate space. The composer travels
        // with the conversation surface while this gesture is active; global
        // coordinates keep that movement from feeding back into the finger's
        // translation and make slow pulls track as cleanly as quick swipes.
        DragGesture(minimumDistance: minimumDistance, coordinateSpace: .global)
            .updating($menuOpeningDragActive) { _, active, _ in
                active = true
            }
            .onChanged { value in
                guard !menuOpen else { return }

                if !menuPullActive {
                    if menuOpenGestureIsHorizontal { return }
                    if PullMenuMotion.hasHorizontalIntent(
                        translationX: value.translation.width,
                        translationY: value.translation.height
                    ) {
                        // Lock an unmistakably horizontal gesture before the
                        // sheet begins moving. This protects cursor placement
                        // in the composer from becoming an accidental reveal.
                        menuOpenGestureIsHorizontal = true
                        return
                    }
                    guard PullMenuMotion.hasOpeningIntent(
                        translationX: value.translation.width,
                        translationY: value.translation.height
                    ) else { return }
                }

                let pullDistance = PullMenuMotion.openingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                // A pull can begin only at the latest message, but once it
                // starts it remains latched even as the ScrollView reports a
                // transient non-bottom geometry during its rubber-band.
                guard menuPullActive
                    || ((!requiresTranscriptBottom || isAtMenuOpeningEdge) && pullDistance > 0)
                else { return }

                if menuOpenGestureStartedAt == nil {
                    menuOpenGestureStartedAt = value.time
                }

                if !menuPullActive {
                    menuPullActive = true
                    composerFocused = false
                    var transaction = Transaction(animation: nil)
                    transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        menuSurfaceActive = true
                    }
                }

                menuPullDistance = pullDistance

                // Hysteresis around the detent: a slow drag hovering at the
                // threshold otherwise toggles the haptic every point.
                let detentReached = PullMenuMotion.holdsOpeningDetent(
                    revealDistance: pullDistance,
                    revealHeight: menuRevealHeight,
                    detentHeld: menuDetentReached
                )
                updateMenuDetent(reached: detentReached)
            }
            .onEnded { value in
                defer {
                    menuOpenGestureStartedAt = nil
                    menuOpenGestureIsHorizontal = false
                }
                guard !menuOpen else { return }
                guard !menuOpenGestureIsHorizontal else { return }

                let actualPull = PullMenuMotion.openingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                let projectedPull = PullMenuMotion.projectedOpeningDistance(
                    translationY: value.translation.height,
                    predictedEndTranslationY: value.predictedEndTranslation.height,
                    revealHeight: menuRevealHeight
                )
                let releasePull = PullMenuMotion.releaseDistance(
                    actualDistance: actualPull,
                    projectedDistance: projectedPull,
                    gestureDuration: menuOpenGestureStartedAt.map {
                        max(0, value.time.timeIntervalSince($0))
                    }
                )
                let usesProjection = releasePull > actualPull
                let projectedX = abs(value.predictedEndTranslation.width) > abs(value.translation.width)
                    ? value.predictedEndTranslation.width
                    : value.translation.width
                let projectedY = min(
                    value.translation.height,
                    value.predictedEndTranslation.height
                )
                guard menuPullActive || PullMenuMotion.hasOpeningIntent(
                    translationX: usesProjection ? projectedX : value.translation.width,
                    translationY: usesProjection ? projectedY : value.translation.height
                ) else { return }
                // A fast swipe may cross the commitment distance between the
                // recognizer's last change sample and its end sample. Do not
                // require a prior live-pull update for that decisive release.
                guard menuPullActive
                    || ((!requiresTranscriptBottom || isAtMenuOpeningEdge) && releasePull > 0)
                else { return }
                if !menuPullActive {
                    composerFocused = false
                }
                finishPullMenu(releasedAt: releasePull)
            }
    }

    /// The target deliberately sits beside—not inside—the moving conversation
    /// surface. Otherwise the target is offset under the finger while a drag
    /// is being sampled, which can make a slow pull re-anchor and flicker.
    private var pullMenuOpenGestureTarget: some View {
        // A nearly transparent fill remains a concrete hit-test surface on
        // device; `Color.clear` can be discarded by UIKit's hit-testing bridge.
        Color.black.opacity(0.001)
            .contentShape(Rectangle())
            .frame(maxWidth: .infinity)
            .frame(height: PullMenuMotion.transcriptComposerSpacing)
            // Only the empty gap above the composer belongs to this target.
            // A taller overlay intercepts action and disclosure taps in the
            // last message. The input also handles menu pulls separately.
            .highPriorityGesture(pullMenuOpenGesture(requiresTranscriptBottom: true))
            .padding(.bottom, composerHeight)
            // When the reader is even slightly above the true bottom, touches
            // in this region belong to transcript scrolling. Keep the target
            // alive after a pull begins so geometry changes cannot cancel it.
            .allowsHitTesting(menuPullActive || (isAtMenuOpeningEdge && !userIsDraggingTranscript))
            .accessibilityHidden(true)
    }

    private var pullMenu: some View {
        let handleProgress = menuElementProgress(after: 0.08)
        let handleVisibility = menuVisibilityProgress(after: 0.08)
        let handleUnfurl = organicProgress(handleProgress)

        return VStack(spacing: 11) {
            // The handle advertises that this sheet can be dragged closed.
            // Its recognizer lives on the shared chat/menu container, so the
            // same downward swipe works from a destination or the chat sheet.
            // Its 10pt threshold leaves ordinary taps untouched.
            Capsule()
                .fill(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.3 : 0.15))
                .frame(width: 42, height: 4)
                .scaleEffect(
                    x: reduceMotion ? 1 : 0.34 + (0.66 * handleUnfurl),
                    y: reduceMotion ? 1 : 1.7 - (0.7 * handleUnfurl),
                    anchor: .center
                )
                .opacity(handleVisibility)

            pullMenuActions
        }
        .padding(.horizontal, 16)
        .padding(.top, 26)
        .frame(height: menuRevealHeight, alignment: .top)
        .background {
            // Bleed into the bottom safe area: the menu is bottom-aligned
            // inside the safe area, so without this the stage color shows
            // through as a strip under the menu by the home indicator.
            ZStack {
                // Keep the submenu's familiar neutral-gray canvas. The green
                // conversation stage remains behind this half-opacity glass,
                // rather than becoming the submenu's own color.
                AssistantTheme.canvas(for: colorScheme)
                LinearGradient(
                    colors: [
                        AssistantTheme.raised(for: colorScheme).opacity(colorScheme == .dark ? 0.19 : 0.36),
                        AssistantTheme.canvas(for: colorScheme).opacity(0.48),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            // The frame already includes the bottom safe-area allowance. Bleed
            // upward only through the sheet's rounded corner so the window
            // backing cannot show through that curve.
            .padding(.top, -max(menuSheetCornerRadius, safeAreaTopInset, deviceBottomSafeAreaInset))
            .ignoresSafeArea(.container, edges: .bottom)
            .allowsHitTesting(false)
        }
        // Hit-testing follows the open flag, which stays true for the whole
        // close drag and flips false the moment the close animation starts —
        // so the composer is reachable as soon as the menu begins to dismiss.
        // Gating on the reveal progress instead cancelled the active close
        // gesture mid-drag once the menu was halfway shut.
        .allowsHitTesting(menuOpen)
        .accessibilityHidden(!menuOpen)
        .accessibilityAction(named: "Close menu") {
            closePullMenu()
        }
    }

    @ViewBuilder
    private var pullMenuActions: some View {
        if isLandscape {
            VStack(spacing: 0) {
                pullMenuRow {
                    pullMenuButton("Chat", icon: "bubble.left", isSelected: true, index: 0) {
                        closePullMenu()
                    }
                    pullMenuButton("Activity", icon: "waveform.path.ecg", index: 1) {
                        openRoute(.activity)
                    }
                    pullMenuButton("Goals", icon: "scope", index: 2) {
                        openRoute(.goals)
                    }
                }
                pullMenuRow {
                    pullMenuButton(
                        "Approvals",
                        icon: "checkmark.shield",
                        badge: model.pendingApprovalCount,
                        index: 3
                    ) {
                        openRoute(.approvals)
                    }
                    pullMenuButton("Chats", icon: "bubble.left.and.bubble.right", index: 4) {
                        openRoute(.chats)
                    }
                    pullMenuButton(
                        "Memory",
                        icon: "brain.head.profile",
                        badge: model.memoryReviewCount,
                        index: 5
                    ) {
                        openRoute(.memory)
                    }
                }
                pullMenuRow {
                    pullMenuButton("Cards", icon: "rectangle.stack", index: 6) {
                        openRoute(.cards)
                    }
                    pullMenuButton("People", icon: "person.2", index: 7) {
                        openRoute(.people)
                    }
                    pullMenuButton("More", icon: "ellipsis", index: 8) {
                        openRoute(.settings)
                    }
                }
                pullMenuDivider
                menuAutonomyToggle
            }
        } else if usesExtraLargeAccessibilityMenu {
            VStack(spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        pullMenuActionButtons
                    }
                    .scrollTargetLayout()
                }
                .contentMargins(.horizontal, 1, for: .scrollContent)
                .scrollTargetBehavior(.viewAligned)
                .scrollClipDisabled()

                menuAutonomyToggle
            }
        } else {
            VStack(spacing: 0) {
                pullMenuRow {
                    pullMenuButton("Chat", icon: "bubble.left", isSelected: true, index: 0) {
                        closePullMenu()
                    }
                    pullMenuButton("Activity", icon: "waveform.path.ecg", index: 1) {
                        openRoute(.activity)
                    }
                }
                pullMenuRow {
                    pullMenuButton("Goals", icon: "scope", index: 2) {
                        openRoute(.goals)
                    }
                    pullMenuButton(
                        "Approvals",
                        icon: "checkmark.shield",
                        badge: model.pendingApprovalCount,
                        index: 3
                    ) {
                        openRoute(.approvals)
                    }
                }

                pullMenuDivider

                pullMenuRow {
                    pullMenuButton("Chats", icon: "bubble.left.and.bubble.right", index: 4) {
                        openRoute(.chats)
                    }
                    pullMenuButton(
                        "Memory",
                        icon: "brain.head.profile",
                        badge: model.memoryReviewCount,
                        index: 5
                    ) {
                        openRoute(.memory)
                    }
                }
                pullMenuRow {
                    pullMenuButton("Cards", icon: "rectangle.stack", index: 6) {
                        openRoute(.cards)
                    }
                    pullMenuButton("People", icon: "person.2", index: 7) {
                        openRoute(.people)
                    }
                }
                // Nine destinations do not pair evenly. More takes the last
                // row alone, which reads as a footer to the directory rather
                // than an orphan beside an empty slot.
                pullMenuRow {
                    pullMenuButton("More", icon: "ellipsis", index: 8) {
                        openRoute(.settings)
                    }
                }

                pullMenuDivider
                menuAutonomyToggle
            }
        }
    }

    private func pullMenuRow<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 8) {
            content()
        }
    }

    private var pullMenuDivider: some View {
        Divider()
            .overlay(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.14 : 0.09))
            .padding(.vertical, 6)
    }

    /// How many destinations the menu reveals. The fade staggers bottom-up by
    /// row, so this has to match the buttons actually rendered below.
    private var pullMenuItemCount: Int { 9 }

    // Nine primary destinations. The lower-traffic areas (Documents, Skills,
    // Costs, Anomalies, Improvements) live under More, keeping this directory
    // focused on the routes people revisit during a conversation.
    @ViewBuilder
    private var pullMenuActionButtons: some View {
        pullMenuButton("Chat", icon: "bubble.left", isSelected: true, index: 0) {
            closePullMenu()
        }
        pullMenuButton("Activity", icon: "waveform.path.ecg", index: 1) {
            openRoute(.activity)
        }
        pullMenuButton("Goals", icon: "scope", index: 2) {
            openRoute(.goals)
        }
        pullMenuButton(
            "Approvals",
            icon: "checkmark.shield",
            badge: model.pendingApprovalCount,
            index: 3
        ) {
            openRoute(.approvals)
        }
        pullMenuButton("Chats", icon: "bubble.left.and.bubble.right", index: 4) {
            openRoute(.chats)
        }
        pullMenuButton(
            "Memory",
            icon: "brain.head.profile",
            badge: model.memoryReviewCount,
            index: 5
        ) {
            openRoute(.memory)
        }
        pullMenuButton("Cards", icon: "rectangle.stack", index: 6) {
            openRoute(.cards)
        }
        pullMenuButton("People", icon: "person.2", index: 7) {
            openRoute(.people)
        }
        pullMenuButton("More", icon: "ellipsis", index: 8) {
            openRoute(.settings)
        }
    }

    private var menuAutonomyToggle: some View {
        Button {
            model.nextMessageAutonomous.toggle()
            menuAutonomyFeedback += 1
        } label: {
            HStack(spacing: 12) {
                Text("Auto next")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                Spacer(minLength: 12)
                Capsule()
                    .fill(
                        model.nextMessageAutonomous
                            ? AssistantTheme.accent
                            : AssistantTheme.sunken(for: colorScheme)
                    )
                    .frame(width: 50, height: 30)
                    .overlay(alignment: model.nextMessageAutonomous ? .trailing : .leading) {
                        Circle()
                            .fill(AssistantTheme.dashboardPaper(for: colorScheme))
                            .frame(width: 24, height: 24)
                            .padding(3)
                            .shadow(color: .black.opacity(0.1), radius: 2, y: 1)
                    }
            }
            .frame(maxWidth: .infinity, minHeight: menuAutonomyHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(
            AssistantTactileButtonStyle(
                reduceMotion: reduceMotion,
                pressedScale: 0.975
            )
        )
        .accessibilityLabel(model.nextMessageAutonomous ? "Turn autonomous work off" : "Turn autonomous work on")
        .accessibilityValue(model.nextMessageAutonomous ? "On" : "Off")
        .accessibilityHint("Applies to the next message only")
        .accessibilityAddTraits(model.nextMessageAutonomous ? .isSelected : [])
        .accessibilityRemoveTraits(model.nextMessageAutonomous ? [] : .isSelected)
    }

    private func pullMenuButton(
        _ title: String,
        icon: String,
        badge: Int = 0,
        isSelected: Bool = false,
        index: Int,
        action: @escaping () -> Void
    ) -> some View {
        // Opacity only: the tiles used to also rise 24pt while fading in,
        // which — uncovered progressively by the lifting sheet — read as the
        // items stretching. Reveal paired rows from the physical bottom edge,
        // matching the order in which the lifting surface exposes them. The
        // extra-large horizontal strip is one row and fades as a group.
        let columns = isLandscape ? 3 : (usesExtraLargeAccessibilityMenu ? pullMenuItemCount : 2)
        let fadeRank = PullMenuMotion.bottomUpFadeRank(
            itemIndex: index,
            itemCount: pullMenuItemCount,
            columns: columns
        )
        let visibility = menuVisibilityProgress(after: 0.18 + (CGFloat(fadeRank) * 0.09))

        return Button(action: action) {
            pullMenuButtonSurface(isSelected: isSelected) {
                HStack(spacing: 12) {
                    Image(systemName: icon)
                        .font(
                            usesExtraLargeAccessibilityMenu
                                ? .headline.weight(.semibold)
                                : .subheadline.weight(.semibold)
                        )
                        // A fixed square slot preserves the same breathing
                        // room around every SF Symbol, including asymmetric
                        // marks such as `ellipsis` and `scope`.
                        .frame(width: 32, height: 32)
                    Text(title)
                        .font(
                            usesExtraLargeAccessibilityMenu
                                ? .subheadline.weight(.semibold)
                                : .system(size: menuTileFontSize, weight: .semibold, design: .rounded)
                        )
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: 0)
                    if badge > 0 {
                        Text(badge > 99 ? "99+" : "\(badge)")
                            .font(.system(size: menuBadgeFontSize, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .frame(minWidth: 24, minHeight: 22)
                            .background(AssistantTheme.notificationBadge, in: Capsule())
                            .accessibilityHidden(true)
                    }
                }
                .foregroundStyle(
                    isSelected ? AssistantTheme.accent(for: colorScheme) : AssistantTheme.ink(for: colorScheme)
                )
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity)
                .frame(height: menuButtonHeight)
            }
        }
        .buttonStyle(
            AssistantTactileButtonStyle(
                reduceMotion: reduceMotion,
                pressedScale: 0.975
            )
        )
        .frame(width: usesExtraLargeAccessibilityMenu && !isLandscape ? 220 : nil)
        .opacity(visibility)
        .accessibilityLabel(title)
        .accessibilityValue(
            badge > 0
                ? "\(badge) pending"
                : (isSelected ? "Selected" : "")
        )
        .accessibilityIdentifier(
            "assistant.chat.menu.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))"
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityRemoveTraits(isSelected ? [] : .isSelected)
    }

    @ViewBuilder
    private func pullMenuButtonSurface<Content: View>(
        isSelected: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: 17, style: .continuous)
        // This is just one ink wash over the menu canvas: enough to group the
        // current destination, without introducing a second green surface.
        let selectedFill = AssistantTheme.ink(for: colorScheme)
            .opacity(colorScheme == .dark ? 0.14 : 0.055)

        content()
            // The current item is slightly grayer than the paper-like sheet;
            // its green icon and label remain the unmistakable active cue.
            .background(
                isSelected ? selectedFill : Color.clear,
                in: shape
            )
    }

    private var pullMenuCloseGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .updating($menuClosingDragActive) { _, active, _ in
                active = true
            }
            .onChanged { value in
                guard menuOpen else { return }
                if menuCloseGestureIsHorizontal {
                    menuCloseDragDistance = 0
                    updateMenuDetent(reached: true)
                    return
                }
                if PullMenuMotion.hasHorizontalIntent(
                    translationX: value.translation.width,
                    translationY: value.translation.height
                ) {
                    // Lock the axis from the first unambiguous sample. The
                    // predicted end occasionally bends a horizontal strip
                    // swipe downward; it must never retroactively become a
                    // sheet dismissal.
                    menuCloseGestureIsHorizontal = true
                    menuCloseDragDistance = 0
                    updateMenuDetent(reached: true)
                    return
                }
                guard PullMenuMotion.hasClosingIntent(
                    translationX: value.translation.width,
                    translationY: value.translation.height
                ) else {
                    menuCloseDragDistance = 0
                    updateMenuDetent(reached: true)
                    return
                }
                if menuCloseGestureStartedAt == nil {
                    menuCloseGestureStartedAt = value.time
                }
                let dragDistance = PullMenuMotion.closingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                menuCloseDragDistance = dragDistance
                // Same hysteresis as the opening detent, mirrored.
                let willClose = PullMenuMotion.closesOnRelease(
                    dragDistance: dragDistance,
                    revealHeight: menuRevealHeight,
                    detentHeld: menuDetentReached
                )
                updateMenuDetent(reached: !willClose)
            }
            .onEnded { value in
                defer {
                    menuCloseGestureStartedAt = nil
                    menuCloseGestureIsHorizontal = false
                }
                guard menuOpen else { return }
                guard !menuCloseGestureIsHorizontal else {
                    setPullMenu(open: true)
                    return
                }
                let actualDistance = PullMenuMotion.closingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                let projectedDistance = PullMenuMotion.projectedClosingDistance(
                    translationY: value.translation.height,
                    predictedEndTranslationY: value.predictedEndTranslation.height,
                    revealHeight: menuRevealHeight
                )
                let releaseDistance = PullMenuMotion.releaseDistance(
                    actualDistance: actualDistance,
                    projectedDistance: projectedDistance,
                    gestureDuration: menuCloseGestureStartedAt.map {
                        max(0, value.time.timeIntervalSince($0))
                    }
                )
                let usesProjection = releaseDistance > actualDistance
                let projectedX = abs(value.predictedEndTranslation.width) > abs(value.translation.width)
                    ? value.predictedEndTranslation.width
                    : value.translation.width
                let projectedY = max(
                    value.translation.height,
                    value.predictedEndTranslation.height
                )
                guard PullMenuMotion.hasClosingIntent(
                    translationX: usesProjection ? projectedX : value.translation.width,
                    translationY: usesProjection ? projectedY : value.translation.height
                ) else {
                    setPullMenu(open: true)
                    return
                }
                // Released against the same edge the detent last reported, so
                // the haptic the finger felt and the outcome always agree.
                setPullMenu(
                    open: !PullMenuMotion.closesOnRelease(
                        dragDistance: releaseDistance,
                        revealHeight: menuRevealHeight,
                        detentHeld: menuDetentReached
                    )
                )
            }
    }

    private func menuTransitionAnimation(
        open: Bool
    ) -> Animation? {
        guard !reduceMotion else { return nil }
        return .interpolatingSpring(
            duration: open ? 0.44 : 0.34,
            bounce: open ? 0.08 : 0.02
        )
    }

    private func setPullMenu(open: Bool) {
        let currentRevealDistance = visibleMenuRevealDistance

        if menuDetentReached != open {
            menuDetentReached = open
            menuDetentFeedback += 1
        }

        var normalizationTransaction = Transaction(animation: nil)
        normalizationTransaction.disablesAnimations = true
        withTransaction(normalizationTransaction) {
            menuPullDistance = currentRevealDistance
            menuCloseDragDistance = 0
            if open {
                menuSurfaceActive = true
            }
        }

        menuOpen = open
        withAnimation(menuTransitionAnimation(open: open)) {
            menuPullActive = false
            menuPullDistance = open ? menuRevealHeight : 0
        } completion: {
            // A close can be reversed before its spring settles. Only clear the
            // presentation gate when the surface is closed and no new pull owns it.
            guard !menuOpen,
                  !menuPullActive,
                  visibleMenuRevealDistance <= 0.5
            else { return }

            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                menuSurfaceActive = false
            }
        }
    }

    private func updateMenuDetent(reached: Bool) {
        guard menuDetentReached != reached else { return }
        menuDetentReached = reached
        menuDetentFeedback += 1
    }

    /// SwiftUI may not deliver onEnded when a drag is cancelled, including
    /// app deactivation. Resolve the partial pull to its current detent and
    /// clear every axis lock so the next touch inherits no stale gesture state.
    private func settleInterruptedMenuGesture() {
        if menuPullActive {
            finishPullMenu(releasedAt: menuPullDistance)
        } else if menuCloseDragDistance > 0 {
            setPullMenu(
                open: !PullMenuMotion.closesOnRelease(
                    dragDistance: menuCloseDragDistance,
                    revealHeight: menuRevealHeight,
                    detentHeld: menuDetentReached
                )
            )
        }

        menuOpenGestureStartedAt = nil
        menuOpenGestureIsHorizontal = false
        menuCloseGestureStartedAt = nil
        menuCloseGestureIsHorizontal = false
    }

    private func settleCancelledMenuGestureAfterRelease() {
        // Let a normal onEnded finish first. A cancelled recognizer has no
        // onEnded, so its live distance or axis lock is still present on the
        // next main-queue turn and needs to be cleared here.
        DispatchQueue.main.async {
            guard !menuOpeningDragActive, !menuClosingDragActive else { return }
            settleInterruptedMenuGesture()
        }
    }

    private func openPullMenu() {
        composerFocused = false
        setPullMenu(open: true)
    }

    private func closePullMenu() {
        setPullMenu(open: false)
    }

    private func openRoute(_ route: AssistantRoute) {
        composerFocused = false
        // Through setPullMenu rather than assigning the state directly, so
        // picking a destination springs shut the way tapping Chat does instead
        // of teleporting under the presenting sheet.
        setPullMenu(open: false)
        model.present(route)
    }

    private var emptyConversation: some View {
        ChatDashboard(
            agentName: model.agentName,
            overview: model.overview,
            pendingApprovalCount: model.pendingApprovalCount,
            needsAttentionCount: model.needsAttentionCount,
            isSending: model.isSending,
            onRoute: openRoute,
            onPrompt: sendPreset
        )
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if !model.latestQuickReplies.isEmpty && !composerFocused && !model.isSending {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.latestQuickReplies, id: \.self) { reply in
                            Button {
                                sendPreset(reply)
                            } label: {
                                Text(reply)
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(AssistantTheme.stageSecondary)
                                    .padding(.horizontal, 14)
                                    .frame(height: 36)
                                    .modifier(
                                        QuickReplySurface(
                                            backgroundOpacity: conversationControlBackgroundOpacity,
                                            glassTintOpacity: conversationControlGlassTintOpacity
                                        )
                                    )
                                    .padding(.vertical, 4)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(
                                AssistantTactileButtonStyle(
                                    reduceMotion: reduceMotion,
                                    pressedScale: 0.97
                                )
                            )
                            .accessibilityHint("Sends this suggested reply")
                        }
                    }
                }
                .scrollClipDisabled()
                .transition(.opacity)
            }

            composerInput
                // The input itself is the bottom-edge grab region. Keeping
                // this recognizer off the outer composer lets the quick-reply
                // strip retain its native horizontal scroll gesture. Observe
                // the pull simultaneously and wait for real movement so the
                // text view and send button retain native tap, caret, and
                // selection handling.
                .simultaneousGesture(
                    pullMenuOpenGesture(
                        requiresTranscriptBottom: false,
                        minimumDistance: 8
                    )
                )
                // The input owns the upward pull that reveals navigation.
                // A clearly downward swipe while it is focused means the
                // opposite: get the keyboard out of the way. Keep this
                // simultaneous so typing, cursor placement, and the pull do
                // not lose their native gesture handling.
                .simultaneousGesture(composerKeyboardDismissGesture)
        }
        // The caret and the ready send button are the only surfaces a [theme:]
        // cue moves, so the mood glides here rather than behind the transcript.
        // 0.6s matches the web client's scoped --accent transition.
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.6), value: model.latestMood)
        .padding(.horizontal, composerSurfaceInset)
        .padding(.top, 14)
        // The column already contributes 12pt below the composer. Together
        // these paddings must equal the side inset for concentric corners.
        .padding(.bottom, composerSurfaceInset - PullMenuMotion.composerSurfaceBottomSpacing)
        .background {
            LinearGradient(
                colors: [
                    .clear,
                    AssistantTheme.stage(for: colorScheme).opacity(0.03),
                    AssistantTheme.stage(for: colorScheme).opacity(0.12),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(.container)
        }
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: model.nextMessageAutonomous
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: composerFocused)
        // The quick-reply strip is gated on this too, so without it the
        // composer changed height in a hard step at the start and end of every
        // turn.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.isSending)
    }

    private var composerKeyboardDismissGesture: some Gesture {
        DragGesture(minimumDistance: PullMenuMotion.verticalIntentDistance)
            .onChanged { value in
                guard composerFocused,
                      PullMenuMotion.hasClosingIntent(
                        translationX: value.translation.width,
                        translationY: value.translation.height
                      )
                else { return }

                composerFocused = false
            }
    }

    private var composerInput: some View {
        composerInputSurface {
            HStack(alignment: .bottom, spacing: 8) {
                if model.nextMessageAutonomous {
                    // Auto mode lives inside the field as a leading affordance
                    // — the pill above the composer read as a separate banner
                    // detached from the message it affects. Tap to cancel.
                    Button {
                        model.nextMessageAutonomous = false
                    } label: {
                        Image(systemName: "bolt.shield.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(AssistantTheme.stageWarningInk)
                            .frame(width: 30, height: 30)
                            .background(AssistantTheme.stageWarningSurface.opacity(0.94), in: Circle())
                            .overlay {
                                Circle().strokeBorder(.white.opacity(0.32), lineWidth: 0.7)
                            }
                    }
                    .buttonStyle(.plain)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                    .padding(.leading, 6)
                    .accessibilityLabel("Auto mode for the next message")
                    .accessibilityHint("Sensitive steps still ask, and budget caps still apply. Activating turns auto mode off.")
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }

                ComposerTextInput(
                    text: $draft,
                    isFocused: Binding(
                        get: { composerFocused },
                        set: { composerFocused = $0 }
                    ),
                    prompt: composerPrompt,
                    fontSize: composerFontSize,
                    textColor: .white,
                    placeholderColor: UIColor(composerPlaceholderColor),
                    cursorColor: UIColor(composerCursorColor),
                    completionColor: UIColor(composerCompletionColor),
                    onSubmit: sendDraft
                )
                    .padding(.leading, 6)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44, alignment: .leading)
                    .layoutPriority(1)
                    // Match the visible capsule instead of leaving its 8pt
                    // top and bottom padding as dead zones. The simultaneous
                    // tap keeps native cursor placement intact while making
                    // first-touch focus explicit.
                    .contentShape(Rectangle().inset(by: -8))
                    .simultaneousGesture(
                        TapGesture().onEnded {
                            composerFocused = true
                        }
                    )
                    .accessibilityHint("Pull up on the input to open the menu.")
                    .accessibilityAction(named: "Open menu") {
                        openPullMenu()
                    }
                    .accessibilityIdentifier("assistant.chat.composer")

                pushToTalkButton

                Button {
                    if model.isSending {
                        model.cancelSend()
                    } else {
                        sendDraft()
                    }
                } label: {
                    ZStack {
                        if model.isSending {
                            // A spinner in a button's position reads as a
                            // progress indicator, not a control. The square
                            // inside the arc says the turn can be stopped.
                            ComposerWorkingIndicator(color: composerTextColor)
                                .overlay {
                                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                                        .fill(composerTextColor)
                                        .frame(width: 8, height: 8)
                                }
                                .transition(.scale(scale: 0.72).combined(with: .opacity))
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                                .transition(.scale(scale: 0.72).combined(with: .opacity))
                        }
                    }
                    .foregroundStyle(
                        model.isSending
                            ? AssistantTheme.stageDepth
                            : (canSend ? AssistantTheme.accent : composerPlaceholderColor)
                    )
                    .frame(width: 44, height: 44)
                    .background(
                        // Readiness is a state change, not a dimmed copy: with
                        // nothing to send the button sits back in the well; a
                        // typed draft lifts it to the solid fill that reads as
                        // the one bright object on the stage. Its arrow takes
                        // the brand green so the white circle stays connected
                        // to the rest of the conversation controls.
                        (canSend && !model.isSending ? sendReadyFill : AssistantTheme.raised(for: colorScheme))
                            .opacity(model.isSending ? 0.28 : (!canSend ? 0.06 : 1)),
                        in: Circle()
                    )
                    .overlay {
                        Circle().strokeBorder(
                            composerTextColor.opacity(model.isSending ? 0.25 : (canSend ? 0.3 : 0.1)),
                            lineWidth: 0.7
                        )
                    }
                    .scaleEffect(model.isSending || canSend ? 1 : 0.92)
                    .shadow(
                        color: AssistantTheme.stageDepth.opacity(
                            model.isSending ? 0.08 : (canSend ? 0.16 : 0)
                        ),
                        radius: 7,
                        y: 3
                    )
                }
                .buttonStyle(.plain)
                .disabled(!canSend && !model.isSending)
                .accessibilityLabel(model.isSending ? "Stop the assistant" : "Send message")
                .accessibilityIdentifier("assistant.chat.send")
                .accessibilityHint(
                    model.isSending
                        ? "Stops this turn and keeps what has arrived so far"
                        : "Sends the current message"
                )
                .animation(
                    reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.76),
                    value: canSend
                )
                .animation(
                    reduceMotion ? nil : .easeOut(duration: 0.18),
                    value: model.isSending
                )
            }
            .padding(.leading, 10)
            .padding(.trailing, 8)
            .padding(.vertical, 8)
            .frame(minHeight: 60)
        }
        // No manual stroke or top highlight on top of the glass: the glass
        // rim already draws the edge, and a static outline layered over the
        // touch-reactive glass is what produced the visible double outline.
        .shadow(
            color: Color(hex: 0x0C2D1B, alpha: composerFocused ? 0.15 : 0.1),
            radius: composerFocused ? 18 : 13,
            y: composerFocused ? 8 : 5
        )
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: composerFocused
        )
    }

    private var composerTextColor: Color {
        // Editable text is true white; auxiliary controls use warm white.
        AssistantTheme.stageStrong
    }

    /// Tap to talk, hold to dictate.
    ///
    /// A hold bounds the listening with the gesture itself — the microphone is
    /// open for exactly as long as a finger is down. A tap latches it on
    /// instead: the button takes the active white fill and keeps it, and the
    /// next tap puts it back to rest. Neither one leaves the conversation; the
    /// words land in the composer and nothing is sent until you send it.
    private var pushToTalkButton: some View {
        let listening = micLatched || pushToTalkActive
        let preparing = listening && listener.state == .preparing
        return Button {
            // A completed hold owns this press; its release must not also
            // trigger the button's tap action and turn listening back on.
            guard !micHoldConsumed else { return }
            toggleMicrophone()
        } label: {
            ZStack {
                if preparing {
                    // On the active fill the indicator has to switch to the dark
                    // ink the icon uses, or it draws white on white.
                    ComposerWorkingIndicator(
                        color: listening ? AssistantTheme.stageDepth : composerTextColor
                    )
                } else {
                    Image(systemName: listening ? "waveform" : "mic.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .symbolEffect(.variableColor, isActive: listening && !reduceMotion)
                }
            }
            .foregroundStyle(listening ? AssistantTheme.stageDepth : composerPlaceholderColor)
            .frame(width: 44, height: 44)
            .background(
                (listening ? sendReadyFill : AssistantTheme.raised(for: colorScheme))
                    .opacity(listening ? 1 : 0.06),
                in: Circle()
            )
            .overlay {
                Circle().strokeBorder(
                    composerTextColor.opacity(listening ? 0.3 : 0.1),
                    lineWidth: 0.7
                )
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .updating($micTouchDown) { _, down, _ in down = true }
                .onChanged { _ in
                    guard !micPressActive else { return }
                    micPressActive = true
                    micHoldConsumed = false
                }
                .onEnded { _ in
                    micPressActive = false
                    if pushToTalkActive {
                        stopMicrophone(focusingComposer: true)
                    }
                }
        )
        .simultaneousGesture(
            LongPressGesture(minimumDuration: ChatView.micTapSeconds)
                .onEnded { _ in
                    micHoldConsumed = true
                    if micLatched {
                        stopMicrophone(focusingComposer: true)
                    } else {
                        beginPushToTalk()
                    }
                }
        )
        .onChange(of: micTouchDown) { _, down in
            // Gesture state also resets when a system gesture cancels the
            // touch, which has no onEnded callback.
            guard !down else { return }
            micPressActive = false
            if pushToTalkActive {
                stopMicrophone(focusingComposer: true)
            }
        }
        .accessibilityLabel(listening ? "Stop listening" : "Tap to talk")
        .accessibilityIdentifier("assistant.chat.microphone")
        .accessibilityHint(
            "Tap to start, tap again to stop, or hold to talk. The words land in the message field; nothing is sent until you send it."
        )
        // A hold and a tap are hard to tell apart under VoiceOver, so the
        // default action is the toggle and the hands-free loop keeps a named
        // action of its own rather than relying on a timing trick.
        .accessibilityAction { toggleMicrophone() }
        .accessibilityAction(named: "Talk to the assistant") {
            stopMicrophone(focusingComposer: false)
            showingTalk = true
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: listening)
        .onChange(of: listener.transcript) { _, heard in
            guard dictationScope == model.composerDraftScope, dictationScope == draftScope,
                  dictationScope != nil,
                  pushToTalkActive || micLatched || listener.isListening else { return }
            draft = draftBeforeDictation.isEmpty
                ? heard
                : (heard.isEmpty ? draftBeforeDictation : "\(draftBeforeDictation) \(heard)")
        }
        .onChange(of: listener.state) { _, state in
            // A refused microphone or a language with no model is worth saying
            // once, through the banner every other failure already uses.
            guard case let .unavailable(reason) = state else { return }
            model.errorMessage = reason
            // Nothing is listening any more, so the button must not be left
            // sitting there in its active state claiming otherwise.
            micLatched = false
            pushToTalkActive = false
            listener.reset()
        }
    }

    private func beginPushToTalk() {
        // A hold must not open a second session while dictation is active
        // or while the previous session is finishing.
        guard !pushToTalkActive, !micLatched, !micStopping,
              let scope = model.composerDraftScope else { return }
        dictationScope = scope
        pushToTalkActive = true
        draftBeforeDictation = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        startDictation(in: scope)
    }

    /// The whole of the button's behaviour in one place, for VoiceOver's
    /// default action: a press-and-hold is a gesture it cannot perform.
    private func toggleMicrophone() {
        guard !micStopping else { return }
        if micLatched || listener.isListening || listener.state == .preparing {
            stopMicrophone(focusingComposer: true)
            return
        }
        guard let scope = model.composerDraftScope else { return }
        dictationScope = scope
        micLatched = true
        draftBeforeDictation = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        startDictation(in: scope)
    }

    private func startDictation(in scope: ComposerDraftScope) {
        Task {
            guard dictationScope == scope, draftScope == scope,
                  model.composerDraftScope == scope, !micStopping else { return }
            await listener.start()
        }
    }

    /// - Parameter focusingComposer: bring the keyboard up on what was heard,
    ///   so a correction is one tap away rather than a re-take.
    private func stopMicrophone(focusingComposer: Bool) {
        guard !micStopping else { return }
        let stoppedScope = dictationScope
        let needsStop = micLatched || pushToTalkActive || listener.isListening || listener.state == .preparing
        micLatched = false
        pushToTalkActive = false
        guard needsStop else { return }
        micStopping = true
        Task {
            _ = await listener.stop()
            micStopping = false
            if focusingComposer, let stoppedScope, stoppedScope == model.composerDraftScope,
               stoppedScope == draftScope { composerFocused = true }
        }
    }

    /// Below this, a press on the microphone was a tap and not a hold.
    private static let micTapSeconds: TimeInterval = 0.35

    private var composerPrompt: String {
        // Short enough to survive the narrowest phones without truncating.
        if !micStopping && listener.isListening { return "Listening…" }
        if !micStopping && listener.state == .preparing { return "Getting speech ready…" }
        return model.isSending ? "Working — keep typing" : "Ask anything…"
    }

    private var composerPlaceholderColor: Color {
        AssistantTheme.stageSecondary
    }

    private var composerCompletionColor: Color {
        // Keep offered text distinguishable from the white draft and readable.
        AssistantTheme.stageSecondary
    }

    /// The ready send button's fill — the one bright object on the stage. With
    /// no cue active this stays the warm white it has always been.
    private var sendReadyFill: Color {
        model.latestMood == .default
            ? AssistantTheme.stageStrong
            : AssistantTheme.chatAccent(mood: model.latestMood)
    }

    private var composerCursorColor: Color {
        colorSchemeContrast == .increased
            ? AssistantTheme.stageStrong
            : AssistantTheme.chatAccent(mood: model.latestMood)
    }

    /// Shared resting tint for controls floating over the conversation stage.
    /// Keeping this as one value prevents Jump to latest from drifting darker
    /// than the composer when either glass treatment is adjusted.
    private var conversationControlGlassTintOpacity: Double { 0.04 }
    private var conversationControlBackgroundOpacity: Double { 1 }

    @ViewBuilder
    private func composerInputSurface<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        let shape = RoundedRectangle(
            cornerRadius: AssistantTheme.conversationCornerRadius,
            style: .continuous
        )

        if reduceTransparency {
            content()
                .background(
                    AssistantTheme.stageWell(for: colorScheme),
                    in: shape
                )
                .overlay {
                    shape.strokeBorder(
                        composerTextColor.opacity(composerFocused ? 0.32 : 0.2),
                        lineWidth: 1
                    )
                }
        } else if #available(iOS 26.0, *) {
            content()
                .background {
                    shape.fill(
                        AssistantTheme.stageWell(for: colorScheme)
                            // Keep the input visually grounded in the green
                            // conversation stage; the liquid glass remains
                            // above an opaque well, so the input remains readable
                            // regardless of the content moving behind it.
                            .opacity(conversationControlBackgroundOpacity)
                    )
                }
                // Not .interactive(): the glass would expand slightly on
                // touch, which read as a duplicated, offset input outline
                // over the field's own edge. Focus already lifts the field
                // via the shadow and tint below.
                .glassEffect(
                    Glass.clear
                        .tint(
                            AssistantTheme.stageWell(for: colorScheme)
                                .opacity(
                                    composerFocused
                                        ? 0.065
                                        : conversationControlGlassTintOpacity
                                )
                        ),
                    in: shape
                )
        } else {
            content()
                .background {
                    ZStack {
                        shape.fill(.ultraThinMaterial)
                        shape.fill(
                            AssistantTheme.stageWell(for: colorScheme)
                                .opacity(0.85)
                        )
                        shape.fill(
                            LinearGradient(
                                colors: [.white.opacity(0.075), .white.opacity(0.012)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                    }
                }
                .overlay {
                    shape.strokeBorder(
                        composerTextColor.opacity(composerFocused ? 0.26 : 0.15),
                        lineWidth: 1
                    )
                }
        }
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // Return can still reach the field while a response is streaming.
        // Preserve the owner's draft instead of clearing text that AppModel
        // will correctly refuse to send during an active turn.
        guard !text.isEmpty, !model.isSending,
              draftScope == model.composerDraftScope, draftScope != nil else { return }
        draft = ""
        if let draftScope { model.saveComposerDraft("", in: draftScope) }
        sendPreparedMessage(text, keepsComposerFocused: true)
    }

    private func sendPreset(_ rawText: String) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !model.isSending else { return }
        sendPreparedMessage(text, keepsComposerFocused: false)
    }

    private func sendPreparedMessage(_ text: String, keepsComposerFocused: Bool) {
        // The draft has just been taken; anything still being transcribed into
        // it belongs to a message that no longer exists.
        dictationScope = nil
        stopMicrophone(focusingComposer: false)
        sendFeedback += 1
        composerFocused = keepsComposerFocused
        requestScrollToBottom()
        model.send(text)
    }

    private func synchronizeComposer() {
        let nextScope = model.composerDraftScope
        guard nextScope != draftScope else { return }
        if let draftScope { model.saveComposerDraft(draft, in: draftScope) }
        dictationScope = nil
        stopMicrophone(focusingComposer: false)
        draftScope = nextScope
        draft = nextScope.map { model.composerDraft(in: $0) } ?? ""
        draftBeforeDictation = ""
        hasUnseenMessages = false
        transcriptFollow.resume()
        hasPositionedInitialConversation = false
        restoreUnsentMessageIfPossible()
        requestScrollToBottom()
    }

    private func restoreUnsentMessageIfPossible() {
        guard let draftScope,
              let restored = model.restoreComposerRecovery(in: draftScope, replacing: draft) else { return }
        draft = restored
    }

    private var showsJumpToLatest: Bool {
        // Visibility tracks the scroll position only. Gating on
        // `errorMessage` let any transient failure — including a non-fatal
        // overview refresh — hide the button for as long as the unrelated
        // banner stayed up, which is why it was sometimes missing.
        !menuPullActive
            && !menuOpen
            && !menuSurfaceActive
            && !isAtBottom
            && !model.messages.isEmpty
    }

    /// The one way back from a hide. Quiet and short-lived on purpose: the
    /// owner asked for a cleaner log, so the confirmation should not become the
    /// next thing cluttering it. Neutral rather than green — this reports what
    /// just happened; the pill above it is the control.
    private func hiddenMessageUndoBar(_ undo: HiddenMessageUndo) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "eye.slash")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .accessibilityHidden(true)
            Text("Message hidden")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            Button {
                Task { await model.undoHiddenMessage() }
            } label: {
                Text("Undo")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    .frame(minHeight: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("assistant.chat.undo-hidden-message")
            .accessibilityHint("Puts the hidden message back in the log.")
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
        .background(AssistantTheme.raised(for: colorScheme), in: Capsule())
        .overlay {
            Capsule().strokeBorder(
                AssistantTheme.inkMuted(for: colorScheme)
                    .opacity(colorSchemeContrast == .increased ? 0.5 : 0.22),
                lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
            )
        }
        .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        .accessibilityElement(children: .contain)
        .id(undo.id)
    }

    private func jumpToLatestButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            jumpToLatestSurface
                .frame(minWidth: 44, minHeight: 44)
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("assistant.chat.jump-to-latest")
        .accessibilityLabel("Jump to latest message")
        .accessibilityHint(
            hasUnseenMessages
                ? "New messages are available"
                : "Scrolls to the bottom of the conversation"
        )
    }

    @ViewBuilder
    private var jumpToLatestSurface: some View {
        if reduceTransparency {
            jumpToLatestLabel
                .foregroundStyle(AssistantTheme.stageStrong)
                .background(
                    AssistantTheme.stageWell(for: colorScheme),
                    in: Capsule()
                )
                .overlay {
                    Capsule().strokeBorder(
                        .white.opacity(colorSchemeContrast == .increased ? 0.5 : 0.28),
                        lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
                    )
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else if #available(iOS 26.0, *) {
            jumpToLatestLabel
                .foregroundStyle(AssistantTheme.stageStrong)
                .background {
                    Capsule().fill(
                        AssistantTheme.stageWell(for: colorScheme)
                            .opacity(conversationControlBackgroundOpacity)
                    )
                }
                .glassEffect(
                    // Glass.clear, matching the composer: .regular laid a
                    // milky material over the stage fill and read as a
                    // solid green pill next to the input's liquid glass.
                    Glass.clear
                        .tint(
                            AssistantTheme.stageWell(for: colorScheme)
                                .opacity(conversationControlGlassTintOpacity)
                        )
                        .interactive(),
                    in: Capsule()
                )
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else {
            jumpToLatestLabel
                .foregroundStyle(AssistantTheme.stageStrong)
                .background {
                    Capsule()
                        .fill(.ultraThinMaterial)
                        .overlay {
                            Capsule().fill(
                                AssistantTheme.stageWell(for: colorScheme)
                                    .opacity(0.85)
                            )
                        }
                }
                .overlay {
                    Capsule()
                        .strokeBorder(
                            .white.opacity(colorSchemeContrast == .increased ? 0.44 : 0.22),
                            lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
                        )
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        }
    }

    private var jumpToLatestLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.down")
                .font(.system(size: 12, weight: .bold))
            Text("Jump to latest")
            if hasUnseenMessages {
                Circle()
                    .fill(AssistantTheme.stageStrong.opacity(0.9))
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 13)
        .frame(height: 36)
    }

    private func requestScrollToBottom() {
        if menuOpen {
            closePullMenu()
        }
        scrollRequest += 1
        transcriptFollow.resume()
        hasUnseenMessages = false
    }

    private func positionInitialConversationIfNeeded() {
        guard !model.messages.isEmpty, !hasPositionedInitialConversation else { return }
        hasPositionedInitialConversation = true
        transcriptFollow.resume()
        DispatchQueue.main.async {
            transcriptScrollPosition.scrollTo(edge: .bottom)
        }
    }

    private var userIsDraggingTranscript: Bool {
        transcriptScrollPhase == .interacting || transcriptScrollPhase == .tracking
    }

    private var pinsTranscriptToBottom: Bool {
        // Menu reveal is a transform of the whole conversation surface, not a
        // transcript state. Keeping it out of this condition prevents the log
        // from dropping its bottom anchor on the first pull sample.
        transcriptFollow.shouldPin(userIsDragging: userIsDraggingTranscript)
    }

    private var menuOwnsConversationSurface: Bool {
        menuPullActive || menuOpen || menuCloseDragDistance > 0
    }

    private func scrollToBottom(animated: Bool = true) {
        if animated && transcriptScrollPhase == .idle {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.26, extraBounce: 0)) {
                transcriptScrollPosition.scrollTo(edge: .bottom)
            }
        } else {
            // An animated scrollTo issued while the transcript still has
            // momentum is deferred until the movement settles, which reads as
            // a stalled transcript. Snap immediately instead — that interrupts
            // the momentum and lands on the latest message. A pressed Jump to
            // latest wants the same takeover with its motion kept, so it goes
            // through `jumpToLatest(using:)` rather than this automatic path.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                transcriptScrollPosition.scrollTo(edge: .bottom)
            }
        }
    }

    /// A direct owner action outranks any transcript motion already under way.
    /// A momentum fling, a reveal animation for a newly arrived message, an
    /// earlier jump still playing out — the press takes all of them over rather
    /// than queueing behind them, then animates down to the newest message.
    ///
    /// The takeover first cancels any active motion, then schedules one
    /// animated command to the native bottom edge. The same ScrollPosition
    /// owns initial positioning, automatic follow, and explicit jumps, so no
    /// content marker competes with viewport/inset calculations.
    private func jumpToLatest() {
        latestJumpRequest &+= 1
        let request = latestJumpRequest
        hasUnseenMessages = false
        transcriptFollow.resume()
        stopTranscriptScroll()

        DispatchQueue.main.async {
            // A subsequent press owns the destination, never a stale tap.
            guard request == latestJumpRequest else { return }
            animateTranscriptToLatest()
        }
    }

    /// Ends an in-flight scroll by committing the transcript to where it
    /// already is. An unanimated point assignment cancels both a SwiftUI scroll
    /// animation and any UIScrollView deceleration underneath it.
    private func stopTranscriptScroll() {
        guard transcriptScrollPhase != .idle else { return }
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            transcriptScrollPosition.scrollTo(y: transcriptScroll.contentPosition)
        }
    }

    private func animateTranscriptToLatest() {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.3, extraBounce: 0)) {
            // Use the native edge after the viewport has reserved the composer.
            // A proxy targeting an in-content spacer used the old viewport
            // during measurement and could leave the last card under input.
            transcriptScrollPosition.scrollTo(edge: .bottom)
        }
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isSending
    }

}

/// A small UIKit bridge gives the composer ownership of the inline-completion
/// layer. Apple's stock prediction glyph is always system gray; rendering our
/// own suffix lets it take the stage's translucent white instead, a step
/// fainter than the prompt so it never reads as text already typed.
private struct ComposerTextInput: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool

    let prompt: String
    let fontSize: CGFloat
    let textColor: UIColor
    let placeholderColor: UIColor
    let cursorColor: UIColor
    let completionColor: UIColor
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> InlineCompletionTextView {
        let textView = InlineCompletionTextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.isOpaque = false
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.autocapitalizationType = .sentences
        textView.autocorrectionType = .yes
        textView.spellCheckingType = .yes
        textView.returnKeyType = .send
        textView.enablesReturnKeyAutomatically = false
        textView.isScrollEnabled = false
        textView.inlinePredictionType = .no
        textView.accessibilityIdentifier = "assistant.chat.composer"
        applyConfiguration(to: textView)
        return textView
    }

    func updateUIView(_ textView: InlineCompletionTextView, context: Context) {
        context.coordinator.parent = self
        applyConfiguration(to: textView)

        // Setting `text` already refreshes the suggestion through the view's
        // own `didSet`; calling it again here bought a second dictionary
        // lookup per pass and nothing else.
        if textView.text != text {
            textView.text = text
        }

        context.coordinator.scheduleResponderSync(for: textView)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView textView: InlineCompletionTextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }

        let fittingSize = textView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        let lineHeight = textView.font?.lineHeight ?? UIFont.systemFont(ofSize: fontSize).lineHeight
        let maximumHeight = (lineHeight * 6) + textView.textContainerInset.top + textView.textContainerInset.bottom
        let height = min(max(fittingSize.height, lineHeight), maximumHeight)
        // SwiftUI treats this as a pure measurement and may call it more than
        // once per layout pass. `isScrollEnabled` changes how a UITextView
        // sizes itself, so writing it unconditionally here fed a different
        // answer back into the next call and dirtied the layout being
        // measured. Only the real crossing of the six-line cap is written.
        let scrolls = fittingSize.height > maximumHeight
        if textView.isScrollEnabled != scrolls {
            textView.isScrollEnabled = scrolls
        }
        return CGSize(width: width, height: ceil(height))
    }

    /// Every write is guarded. `font` carries an overridden `didSet` that
    /// invalidates layout, and SwiftUI re-runs `updateUIView` for any state
    /// change in the composer's parent — including the measured composer
    /// height, which changes the moment the draft wraps to a second line.
    /// Re-applying identical values on each of those passes kept the field
    /// permanently dirty.
    private func applyConfiguration(to textView: InlineCompletionTextView) {
        let font = UIFont.systemFont(ofSize: fontSize, weight: .regular)
        if textView.font != font { textView.font = font }
        if textView.textColor != textColor { textView.textColor = textColor }
        if textView.tintColor != cursorColor { textView.tintColor = cursorColor }
        if textView.placeholderText != prompt { textView.placeholderText = prompt }
        if textView.accessibilityLabel != prompt { textView.accessibilityLabel = prompt }
        if textView.placeholderColor != placeholderColor { textView.placeholderColor = placeholderColor }
        if textView.completionColor != completionColor { textView.completionColor = completionColor }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextInput
        private var responderSyncScheduled = false

        init(parent: ComposerTextInput) {
            self.parent = parent
        }

        /// Responder changes never run inside `updateUIView`. Becoming first
        /// responder there started the keyboard and its safe-area change in
        /// the middle of SwiftUI's update, and `textViewDidBeginEditing`
        /// wrote focus state back into the same pass. The composer then hung
        /// with the layout already shrunk for a keyboard that never drew. It
        /// only happened when the SwiftUI tap set focus before UITextView's
        /// own tap did — always, for a tap on the capsule's padding — which
        /// is why it came and went. The next main-queue turn is outside the
        /// update, and one pending sync covers any number of passes.
        func scheduleResponderSync(for textView: UITextView) {
            guard !responderSyncScheduled, parent.isFocused != textView.isFirstResponder else { return }
            responderSyncScheduled = true
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self else { return }
                self.responderSyncScheduled = false
                guard let textView else { return }
                self.syncResponder(textView)
            }
        }

        private func syncResponder(_ textView: UITextView) {
            if parent.isFocused, !textView.isFirstResponder {
                // Not in a window yet: the next update schedules another try.
                guard textView.window != nil else { return }
                // A refused request (a cover mid-presentation) would leave the
                // state claiming focus the field does not have, hiding quick
                // replies behind a keyboard that is not there.
                if !textView.becomeFirstResponder() {
                    setFocused(false)
                }
            } else if !parent.isFocused, textView.isFirstResponder {
                textView.resignFirstResponder()
            }
        }

        /// UIKit reports every responder change, including the ones the view
        /// state itself asked for. Writing an unchanged value back still
        /// invalidates the whole chat body.
        private func setFocused(_ focused: Bool) {
            guard parent.isFocused != focused else { return }
            parent.isFocused = focused
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            setFocused(true)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            setFocused(false)
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            (textView as? InlineCompletionTextView)?.refreshInlineCompletion()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            (textView as? InlineCompletionTextView)?.refreshInlineCompletion()
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText replacement: String
        ) -> Bool {
            guard replacement == "\n" else { return true }
            parent.onSubmit()
            return false
        }
    }
}

private final class InlineCompletionTextView: UITextView {
    var placeholderText = "" {
        didSet { placeholderLabel.text = placeholderText }
    }
    var placeholderColor: UIColor = .secondaryLabel {
        didSet { placeholderLabel.textColor = placeholderColor }
    }
    var completionColor: UIColor = UIColor.white.withAlphaComponent(0.25) {
        didSet { completionLabel.textColor = completionColor }
    }

    private let placeholderLabel = UILabel()
    private let completionLabel = UILabel()
    private let checker = UITextChecker()
    private var isPositioningCompletion = false
    /// The draft `cachedCompletionSuffix` was computed for. Both delegate
    /// callbacks that ask for a suggestion — text change and selection change —
    /// fire repeatedly for a caret that has not moved, and each miss is a
    /// dictionary lookup.
    private var completionCacheKey: String?
    private var cachedCompletionSuffix: String?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)

        // Every label value below reaches its view through a property
        // observer, and an observer never runs for the value a property is
        // declared with. The configure path then skips any write matching what
        // is already stored, so a default that happens to equal the configured
        // value leaves the observer with nothing to react to — which is how the
        // suggestion suffix ended up on `UILabel`'s own `.label`, black on the
        // green stage. Seeding each one here makes the initial state correct
        // whether or not `didSet` ever fires.
        placeholderLabel.numberOfLines = 1
        placeholderLabel.lineBreakMode = .byTruncatingTail
        placeholderLabel.text = placeholderText
        placeholderLabel.textColor = placeholderColor
        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)

        completionLabel.numberOfLines = 1
        completionLabel.textColor = completionColor
        completionLabel.isAccessibilityElement = false
        completionLabel.isUserInteractionEnabled = false
        addSubview(completionLabel)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var text: String! {
        didSet {
            placeholderLabel.isHidden = !text.isEmpty
            refreshInlineCompletion()
        }
    }

    override var font: UIFont? {
        didSet {
            placeholderLabel.font = font
            completionLabel.font = font
            setNeedsLayout()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let inset = textContainerInset
        let leading = inset.left + textContainer.lineFragmentPadding
        placeholderLabel.frame = CGRect(
            x: leading,
            y: inset.top,
            width: max(0, bounds.width - leading - inset.right - textContainer.lineFragmentPadding),
            height: font?.lineHeight ?? 0
        )

        // Move the suggestion that is already on screen; do not recompute it.
        // This used to call `refreshInlineCompletion()`, which put a
        // `UITextChecker` dictionary lookup on every layout pass and, through
        // `caretRect(for:)`, forced TextKit to lay the text out again from
        // inside `layoutSubviews` — re-entering this method. One wrapped line
        // multiplies how often a UITextView lays out, which is why the
        // composer only locked up once the draft reached a second line.
        positionCompletionLabel()
    }

    func refreshInlineCompletion() {
        placeholderLabel.isHidden = !text.isEmpty

        guard let suffix = suggestedCompletionSuffix(), !suffix.isEmpty else {
            completionLabel.text = nil
            completionLabel.isHidden = true
            return
        }

        // The label's text is what says a suggestion is outstanding; whether
        // it is visible is decided by whether it fits at the caret, which only
        // the layout pass can know.
        completionLabel.text = suffix
        positionCompletionLabel()
    }

    /// Place the suggestion at the caret, or withdraw it when it does not fit.
    /// Cheap enough to run from a layout pass: no spell-checking, and it does
    /// nothing at all when there is no suggestion showing.
    ///
    /// The re-entrancy guard lives here rather than at the call sites because
    /// `caretRect(for:)` can drive a TextKit layout that lands back in
    /// `layoutSubviews`, and this is the only method that asks for one.
    private func positionCompletionLabel() {
        guard !isPositioningCompletion else { return }
        guard !(completionLabel.text ?? "").isEmpty else {
            completionLabel.isHidden = true
            return
        }
        isPositioningCompletion = true
        defer { isPositioningCompletion = false }

        let caret = caretRect(for: endOfDocument)
        guard caret != .zero else {
            completionLabel.isHidden = true
            return
        }

        completionLabel.sizeToFit()
        let availableWidth = bounds.maxX - textContainerInset.right - caret.maxX
        guard completionLabel.bounds.width <= availableWidth else {
            completionLabel.isHidden = true
            return
        }

        completionLabel.frame.origin = CGPoint(
            x: caret.maxX,
            y: caret.midY - (completionLabel.bounds.height / 2)
        )
        // A caret that was not measurable on an earlier pass — the first
        // character typed into a field that has not been laid out yet — left
        // the suggestion hidden with its text still set. Showing it here is
        // what lets the next layout recover it without another lookup.
        completionLabel.isHidden = false
    }

    private func suggestedCompletionSuffix() -> String? {
        let currentText = text ?? ""
        let length = (currentText as NSString).length
        guard selectedRange.length == 0, selectedRange.location == length, length > 1 else {
            return nil
        }
        // The caret is pinned to the end of the draft by the guard above, so
        // the draft alone identifies the answer.
        if completionCacheKey == currentText { return cachedCompletionSuffix }
        let suffix = lookUpCompletionSuffix(in: currentText, length: length)
        completionCacheKey = currentText
        cachedCompletionSuffix = suffix
        return suffix
    }

    private func lookUpCompletionSuffix(in currentText: String, length: Int) -> String? {
        let source = currentText as NSString
        let wordCharacters = CharacterSet.letters.union(.decimalDigits)
        var start = length
        while start > 0 {
            guard let scalar = UnicodeScalar(source.character(at: start - 1)), wordCharacters.contains(scalar)
            else { break }
            start -= 1
        }

        let partialRange = NSRange(location: start, length: length - start)
        guard partialRange.length >= 2 else { return nil }

        let partial = source.substring(with: partialRange)
        let keyboardLanguage = (textInputMode?.primaryLanguage ?? Locale.current.identifier)
            .replacingOccurrences(of: "-", with: "_")
        let language = UITextChecker.availableLanguages.contains(keyboardLanguage)
            ? keyboardLanguage
            : (UITextChecker.availableLanguages.first(where: { $0.hasPrefix("en") }) ?? "en_US")
        let completions = checker.completions(
            forPartialWordRange: partialRange,
            in: currentText,
            language: language
        ) ?? []

        guard let completion = completions.first(where: {
            $0.range(of: partial, options: [.anchored, .caseInsensitive]) != nil
                && $0.count > partial.count
        }), let prefixRange = completion.range(
            of: partial,
            options: [.anchored, .caseInsensitive]
        )
        else { return nil }

        return String(completion[prefixRange.upperBound...])
    }
}

private struct QuickReplySurface: ViewModifier {
    let backgroundOpacity: Double
    let glassTintOpacity: Double

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = Capsule()
        let stage = AssistantTheme.stageWell(for: colorScheme)
        let rimOpacity = colorSchemeContrast == .increased ? 0.5 : 0.28
        let rimWidth = colorSchemeContrast == .increased ? 1.1 : 0.8

        if reduceTransparency {
            content
                .background(stage, in: shape)
                .overlay {
                    shape.strokeBorder(.white.opacity(rimOpacity), lineWidth: rimWidth)
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else if #available(iOS 26.0, *) {
            content
                // Match Jump to latest exactly: each suggestion sits on the
                // same stage-backed Liquid Glass, so moving paper cards never
                // make it read as an unanchored, fading label.
                .background(stage.opacity(backgroundOpacity), in: shape)
                .glassEffect(
                    Glass.clear
                        .tint(stage.opacity(glassTintOpacity))
                        .interactive(),
                    in: shape
                )
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else {
            content
                .background {
                    shape
                        .fill(.ultraThinMaterial)
                        .overlay {
                            shape.fill(stage.opacity(backgroundOpacity))
                        }
                }
                .overlay {
                    shape.strokeBorder(.white.opacity(rimOpacity), lineWidth: rimWidth)
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        }
    }
}

private struct ComposerWorkingIndicator: View {
    let color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // TimelineView keeps the motion smooth even while the transcript
        // re-renders on every streamed token — an animation started in .task
        // stuttered or stalled under that churn. The arc breathes in length
        // while it rotates, which reads calmer than the old rigid comet.
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: reduceMotion)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let rotation = (time / 1.3).truncatingRemainder(dividingBy: 1) * 360
            let breath = 0.5 - (0.5 * cos(2 * Double.pi * (time / 1.7).truncatingRemainder(dividingBy: 1)))
            let arcLength = 0.14 + (0.58 * breath)

            ZStack {
                Circle()
                    .stroke(color.opacity(0.18), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: arcLength)
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(rotation))
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }
}

#if DEBUG
extension ChatView {
    @MainActor static func visualReviewMenu() -> AnyView {
        var view = ChatView(safeAreaTopInset: 62, safeAreaBottomInset: 34, safeAreaLeadingInset: 0, safeAreaTrailingInset: 0)
        view.visualReviewMenuIsOpen = true
        return AnyView(view)
    }
}
#endif
