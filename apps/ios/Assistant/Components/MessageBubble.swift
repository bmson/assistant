import SwiftUI
import UIKit

struct MessageBubble: View {
    let message: ChatMessage
    let userPrompt: String?
    let isStreaming: Bool
    let openApprovals: () -> Void
    /// The off-course card's fix: resend the prompt through the executor.
    /// Nil when another turn is in flight, so a stale rerun can't jump the queue.
    let runForReal: ((String) -> Void)?
    /// A failed turn's recovery: the same words through normal routing.
    /// Same nil-while-sending rule as runForReal.
    let retry: ((String) -> Void)?
    /// Inline approve/decline for pending approval cards — (approvalId, decision).
    let decideApproval: ((String, String) async -> Bool)?
    /// Save the server-described standing approval from an inline card.
    var rememberApproval: ((String) async -> Bool)? = nil
    /// One-tap answers for suggestion cards — (suggestionId, decision). Returns
    /// what the card should say when the answer did not land. Nil outside the
    /// live log, where the question is shown but cannot be answered.
    var decideSuggestion: ((String, SuggestionDecision) async -> String?)? = nil
    /// Where an accepted suggestion's task can be seen. The phone has no page
    /// for a single task, so this is Activity.
    var openActivity: (() -> Void)? = nil
    var refreshCard: ((String, String?) async -> String?)? = nil
    var cardFormActions: NativeCardFormActions? = nil
    var cardFormStateRevision: Int = 0
    var cardFormTaskRevision: Int = 0
    /// Revision-fenced recall-source hide/allow control, available only in the
    /// durable transcript where the server hydrated a current source ref.
    var setRecallSourceSuppressed: ((MessageRecallSource, Bool) async -> RecallSourceControlOutcome)? = nil
    /// Reads the authoritative current setting on demand before offering the
    /// inverse action for an old transcript source.
    var recallSourceSuppressed: ((MessageRecallSource) async -> Bool?)? = nil
    /// Take this card out of the log. Nil while the row is still in flight —
    /// there is nothing for the server to hide until the turn has settled —
    /// and nil wherever a bubble is rendered outside the log, as in snapshots.
    var hide: (() -> Void)? = nil
    /// Called only after a stable assistant row is visible in the native chat.
    var acknowledgeDelivery: (() async -> Bool)? = nil

    @State private var decidingApproval = false
    @State private var approvalFailureID: String?
    @State private var deliveryRowVisible = false
    @State private var deliveryAcknowledgementInFlight = false
    @State private var deliveryAcknowledged = false
    @State private var recallSourceStates: [String: Bool] = [:]
    @State private var recallSourceInFlight = Set<String>()
    @State private var recallControlNotice: String?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var messageFontSize = 14.0
    @ScaledMetric(relativeTo: .body) private var bubbleHorizontalInset: CGFloat = 20
    @ScaledMetric(relativeTo: .body) private var bubbleVerticalInset: CGFloat = 15
    // Tool-result cards support the answer; they must not hide its caveats.

    @ViewBuilder
    var body: some View {
        // The inner menus below cover the prose bubbles; this one catches every
        // other card the stream can draw — decisions, receipts, rich cards — so
        // a long press anywhere on a row offers the same thing. Attached only
        // where there is something to offer, and on a condition that is fixed
        // for the life of a row: a menu appearing mid-stream would rebuild the
        // bubble underneath the reply it is still writing.
        Group {
            if hide != nil {
                card.contextMenu { cardMenu(copyLabel: "Copy message") }
            } else {
                card
            }
        }
        .onScrollVisibilityChange(threshold: 0.5) { visible in
            deliveryRowVisible = visible
            acknowledgeVisibleReplyIfReady()
        }
        .onChange(of: isStreaming) { _, streaming in
            if !streaming { acknowledgeVisibleReplyIfReady() }
        }
    }

    @MainActor
    private func acknowledgeVisibleReplyIfReady() {
        guard deliveryRowVisible,
              message.role == .assistant,
              !isStreaming,
              !deliveryAcknowledgementInFlight,
              !deliveryAcknowledged,
              let acknowledgeDelivery else { return }
        deliveryAcknowledgementInFlight = true
        Task { @MainActor in
            deliveryAcknowledged = await acknowledgeDelivery()
            deliveryAcknowledgementInFlight = false
        }
    }

    private var card: some View {
        // Bubbles are full-width cards like every other surface in the
        // stream: a one-word message gets the same width as a paragraph
        // rather than shrink-wrapping its text.
        VStack(alignment: .leading, spacing: 8) {
            if message.role == .assistant, let approvalSummary = message.approvalSummary {
                approvalSummaryCard(approvalSummary)
            } else if let noticeKind = message.noticeKind,
               message.role == .assistant,
               decisionParts.isEmpty {
                noticeCard(
                    noticeKind,
                    text: message.text,
                    compact: message.noticePresentation,
                    originalText: message.retractedOriginalText,
                    retractionReason: message.retractionReason
                )
            } else if !message.text.isEmpty && !usesPrimaryCards && !message.visibleTextBubbles.isEmpty {
                messageText
                if message.role == .assistant, !message.recallSources.isEmpty {
                    recallNote
                }
            } else if isStreaming {
                HStack {
                    thinkingIndicator
                    Spacer(minLength: 40)
                }
            } else if let fallback = message.outputFallback(isStreaming: false, hasRenderableCards: !responseCards.isEmpty) {
                VStack(alignment: .leading, spacing: 10) {
                    Label(fallback.title, systemImage: "exclamationmark.circle")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    Text(fallback.detail)
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                    if let openActivity {
                        Button("Review Activity", systemImage: "list.bullet", action: openActivity)
                            .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                    }
                }
                .assistantCard(in: colorScheme)
                .accessibilityElement(children: .contain)
            }

            ForEach(decisionParts.indices, id: \.self) { index in
                let part = decisionParts[index]
                if isPendingDecision(part) {
                    VStack(alignment: .leading, spacing: 0) {
                        Button(action: openApprovals) {
                            decisionCard(part)
                        }
                        .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.985))
                        // Approvals answer from the chat row itself; the card tap
                        // still opens the full review sheet for the payload.
                        if part.type == "approval",
                           let decideApproval,
                           let approvalId = part.approvalId,
                           !approvalId.isEmpty {
                            inlineDecisionRow(approvalId: approvalId, rememberLabel: part.rememberLabel, decide: decideApproval)
                                .padding(.horizontal, 15)
                                .padding(.bottom, 15)
                        }
                    }
                    .background(
                        AssistantTheme.warningSurface(for: colorScheme),
                        in: RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
                            .stroke(
                                AssistantTheme.warning(for: colorScheme)
                                    .opacity(colorSchemeContrast == .increased ? 0.58 : 0.3),
                                lineWidth: colorSchemeContrast == .increased ? 1.2 : 1
                            )
                    }
                } else {
                    settledDecisionReceipt(part)
                }
            }

            if message.role == .assistant, !message.suggestionParts.isEmpty {
                SuggestionCard(
                    parts: message.suggestionParts,
                    decide: decideSuggestion,
                    openActivity: openActivity
                )
            }

            if message.role == .assistant, !responseCards.isEmpty, !message.hasSupportingResultCards {
                RichResponseCards(
                    cards: responseCards,
                    onSend: retry,
                    onRefresh: refreshCard,
                    cardFormActions: cardFormActions,
                    cardFormTaskRevision: cardFormTaskRevision
                )
            }

            if message.role == .assistant, message.isOffCourse, !isStreaming {
                offCourseCard
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    /// One menu for every card in the log: take a copy of what it says, or take
    /// it out of the log. Repeated at each bubble that owns its own menu, since
    /// the innermost one is the only one a long press there will reach.
    @ViewBuilder
    private func cardMenu(copyLabel: String, copying text: String? = nil) -> some View {
        let copyable = text ?? message.text
        if !copyable.isEmpty {
            Button {
                UIPasteboard.general.string = copyable
            } label: {
                Label(copyLabel, systemImage: "doc.on.doc")
            }
        }
        // Hearing a reply is the same kind of act as copying one: something the
        // owner asks a particular card for, from the menu that card already
        // has. The menu is built when the long press opens it, so reading the
        // player's state here costs the transcript no redraws.
        if message.role == .assistant, !SpeakableText.passages(for: message).isEmpty {
            if SpeechPlayer.shared.isSpeaking(message.id) {
                Button(action: stopSpeaking) {
                    Label("Stop speaking", systemImage: "speaker.slash")
                }
            } else {
                Button(action: speakAloud) {
                    Label("Speak reply", systemImage: "speaker.wave.2")
                }
            }
        }
        if let hide {
            Button(role: .destructive, action: hide) {
                Label("Hide from log", systemImage: "eye.slash")
            }
        }
    }

    @MainActor
    private func speakAloud() {
        SpeechPlayer.shared.speak(SpeakableText.passages(for: message), for: message.id)
    }

    @MainActor
    private func stopSpeaking() {
        SpeechPlayer.shared.stop()
    }

    @ViewBuilder
    private var messageText: some View {
        if message.role == .assistant {
            // A reply split by [break] cues stacks as separate sheets, the way
            // separate texts from a person stack — one paper bubble per text
            // part, copy still takes the whole reply.
            ForEach(Array(message.visibleTextBubbles.enumerated()), id: \.offset) { index, bubble in
                assistantBubble(
                    bubble,
                    showsSources: message.hasSupportingResultCards && index == message.visibleTextBubbles.count - 1
                )
            }
        } else {
            AssistantMarkdownView(
                source: message.text,
                baseFontSize: messageFontSize,
                ink: AssistantTheme.stageStrong,
                mutedInk: AssistantTheme.stageSecondary,
                codeSurface: .black.opacity(0.16),
                accent: AssistantTheme.stageStrong
            )
                .padding(.horizontal, resolvedBubbleHorizontalInset)
                .padding(.vertical, resolvedBubbleVerticalInset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    AssistantTheme.stageWell(for: colorScheme),
                    in: RoundedRectangle(
                        cornerRadius: AssistantTheme.conversationCornerRadius,
                        style: .continuous
                    )
                )
                .overlay {
                    RoundedRectangle(
                        cornerRadius: AssistantTheme.conversationCornerRadius,
                        style: .continuous
                    )
                        .strokeBorder(
                            .white.opacity(colorSchemeContrast == .increased ? 0.48 : 0.22),
                            lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
                        )
                }
                .contextMenu { cardMenu(copyLabel: "Copy message") }
        }
    }

    @ViewBuilder
    private var thinkingIndicator: some View {
        let dot = AssistantTheme.bubblePaperInk(for: colorScheme)
        let content = HStack(spacing: 5) {
            if reduceMotion {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(dot.opacity(0.46)).frame(width: 5, height: 5)
                }
            } else {
                PhaseAnimator([0, 1, 2]) { phase in
                    HStack(spacing: 5) {
                        ForEach(0..<3, id: \.self) { index in
                            Circle()
                                .fill(dot.opacity(index == phase ? 0.86 : 0.28))
                                .frame(width: 5, height: 5)
                                .offset(y: index == phase ? -1.5 : 0)
                        }
                    }
                } animation: { _ in
                    .easeInOut(duration: 0.42)
                }
            }
        }
        .frame(height: 18)
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(
            AssistantTheme.bubblePaper(for: colorScheme),
            in: Capsule()
        )
        .overlay {
            Capsule().strokeBorder(.white.opacity(colorScheme == .dark ? 0.08 : 0.58), lineWidth: 0.7)
        }
        .shadow(color: AssistantTheme.stageDepth.opacity(0.1), radius: 8, y: 3)

        content
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Assistant is thinking")
    }

    private var resolvedBubbleHorizontalInset: CGFloat {
        min(bubbleHorizontalInset, 28)
    }

    /// One assistant bubble's worth of paper. The whole reply remains the
    /// copy unit no matter how many bubbles it was split into.
    private func assistantBubble(_ text: String, showsSources: Bool) -> some View {
        let shape = RoundedRectangle(
            cornerRadius: AssistantTheme.conversationCornerRadius,
            style: .continuous
        )
        let borderWidth: CGFloat = colorSchemeContrast == .increased ? 1.05 : 0.7

        return VStack(alignment: .leading, spacing: 0) {
            AssistantMarkdownView(
                source: text,
                baseFontSize: messageFontSize,
                ink: AssistantTheme.bubblePaperInk(for: colorScheme),
                mutedInk: AssistantTheme.inkMuted(for: colorScheme),
                codeSurface: AssistantTheme.sunken(for: colorScheme),
                accent: AssistantTheme.accent(for: colorScheme)
            )
            .textSelection(.enabled)
            .padding(.horizontal, resolvedBubbleHorizontalInset)
            .padding(.vertical, resolvedBubbleVerticalInset * 2)
            .frame(maxWidth: .infinity, alignment: .leading)

            if showsSources {
                AnswerSourcesFooter(cards: responseCards, onSend: retry, onRefresh: refreshCard)
            }
        }
            .clipShape(shape.inset(by: borderWidth))
            .background(
                AssistantTheme.bubblePaper(for: colorScheme),
                in: shape
            )
            .overlay {
                shape
                .strokeBorder(
                    .white.opacity(
                        colorSchemeContrast == .increased
                            ? (colorScheme == .dark ? 0.34 : 0.86)
                            : (colorScheme == .dark ? 0.14 : 0.6)
                    ),
                    lineWidth: borderWidth
                )
            }
            .shadow(
                color: AssistantTheme.stageDepth.opacity(colorScheme == .dark ? 0.24 : 0.1),
                radius: 11,
                y: 5
            )
            .contextMenu { cardMenu(copyLabel: "Copy reply") }
    }

    private var recallNote: some View {
        let sources = message.recallSources
        let groups = Array(Set(sources.map(\.displayGroup))).sorted()
        let title = "Drawing on " + groups.joined(separator: " and ")
        let controllable = sources.filter(\.hasCurrentLedgerReference)
        return VStack(alignment: .leading, spacing: 4) {
            Group {
                if setRecallSourceSuppressed != nil, !controllable.isEmpty {
                    Menu {
                        ForEach(controllable) { source in
                            recallSourceMenuSection(source)
                        }
                    } label: {
                        recallPill(title: title, sources: sources)
                    }
                    .accessibilityLabel("Manage recalled sources: \(sources.map(\.label).joined(separator: ", "))")
                    .accessibilityHint("Hide or allow a source in future recalled context.")
                } else {
                    recallPill(title: title, sources: sources)
                }
            }
            if let recallControlNotice {
                Text(recallControlNotice)
                    .font(.caption2)
                    .foregroundStyle(AssistantTheme.stageSecondary)
                    .accessibilityLabel(recallControlNotice)
            }
        }
    }

    private func recallPill(title: String, sources: [MessageRecallSource]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: sources.contains(where: \.isKnowledgeGraph) ? "point.3.connected.trianglepath.dotted" : "clock.arrow.circlepath")
                .font(.caption2.weight(.semibold))
            Text(title)
                .font(.caption2.weight(.semibold))
            Text(sources.prefix(2).map(\.label).joined(separator: " · "))
                .font(.caption2)
                .lineLimit(1)
        }
        .foregroundStyle(AssistantTheme.stageSecondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(AssistantTheme.stageWell(for: colorScheme), in: Capsule())
        .accessibilityLabel("\(title): \(sources.map(\.label).joined(separator: ", "))")
    }

    @ViewBuilder
    private func recallSourceMenuSection(_ source: MessageRecallSource) -> some View {
        let stateKey = recallSourceStateKey(source)
        Section(source.label) {
            if let hidden = recallSourceStates[stateKey] {
                Button(
                    hidden ? "Allow this version in future recall" : "Hide this version from future recall",
                    systemImage: hidden ? "eye" : "eye.slash"
                ) {
                    updateRecallSource(source, suppressed: !hidden)
                }
                .disabled(recallSourceInFlight.contains(stateKey))
            } else {
                Button("Check this version’s setting", systemImage: "arrow.clockwise") {
                    loadRecallSourceState(source)
                }
                .disabled(recallSourceInFlight.contains(stateKey) || recallSourceSuppressed == nil)
            }
        }
    }

    private func updateRecallSource(_ source: MessageRecallSource, suppressed: Bool) {
        guard source.surfaceKey != nil,
              source.hasCurrentLedgerReference,
              !recallSourceInFlight.contains(recallSourceStateKey(source)),
              let setRecallSourceSuppressed else { return }
        let stateKey = recallSourceStateKey(source)
        recallSourceInFlight.insert(stateKey)
        recallControlNotice = nil
        Task { @MainActor in
            let outcome = await setRecallSourceSuppressed(source, suppressed)
            recallSourceInFlight.remove(stateKey)
            switch outcome {
            case .updated:
                recallSourceStates[stateKey] = suppressed
                recallControlNotice = suppressed
                    ? "This version is hidden from future recall."
                    : "This version is allowed in future recall."
            case .stale:
                recallSourceStates.removeValue(forKey: stateKey)
                recallControlNotice = "This source version changed. Refresh the conversation before changing it."
            case .failed:
                recallControlNotice = "Could not update recall settings. Try again."
            case .discarded:
                break
            }
        }
    }

    private func loadRecallSourceState(_ source: MessageRecallSource) {
        guard source.surfaceKey != nil,
              source.hasCurrentLedgerReference,
              !recallSourceInFlight.contains(recallSourceStateKey(source)),
              let recallSourceSuppressed else { return }
        let stateKey = recallSourceStateKey(source)
        recallSourceInFlight.insert(stateKey)
        recallControlNotice = nil
        Task { @MainActor in
            let value = await recallSourceSuppressed(source)
            recallSourceInFlight.remove(stateKey)
            if let value {
                recallSourceStates[stateKey] = value
                recallControlNotice = value
                    ? "This version is hidden from future recall."
                    : "This version is allowed in future recall."
            } else {
                recallControlNotice = "Could not check this source setting. Refresh the conversation and try again."
            }
        }
    }

    private func recallSourceStateKey(_ source: MessageRecallSource) -> String {
        "\(source.surfaceKey ?? ""):\(source.sourceRevision ?? "")"
    }

    private var resolvedBubbleVerticalInset: CGFloat {
        min(bubbleVerticalInset, 22)
    }

    private var decisionParts: [MessagePart] {
        message.decisionParts
    }

    /// Cards arrive composed, from the one place that composes them. The phone
    /// reads a card the runtime sent and draws it; it does not read the reply
    /// and guess at one. The prose-to-card parsers that used to live here —
    /// four hand-written kinds, a regex per fact, and an on-device pass to
    /// pick between them — could only ever produce a shape someone had
    /// already thought of, and re-derived it on every scroll.
    private var responseCards: [MessageResponseCard] {
        let formRendererAvailable = cardFormActions != nil
        let explicit = message.parts.compactMap {
            MessageResponseCard(part: $0, formRendererAvailable: formRendererAvailable)
        }
        guard explicit.isEmpty else {
            return message.responseCards(formRendererAvailable: formRendererAvailable)
        }

        // One exception, and it is not prose interpretation: the proactive
        // pulse still phrases an event alert as a sentence, in an exact
        // format this build wrote itself.
        return MessageResponseCard.inferredLegacy(from: message.text)
    }

    private var usesPrimaryCards: Bool {
        // An answer card avoids a duplicate answer. Raw lookup results never
        // replace the explanation, and neither does a card read off the reply.
        guard message.role == .assistant, !message.hasSupportingResultCards else { return false }
        if MessageResponseCard.allSitUnderProse(message.parts) { return false }
        return MessageResponseCard.replacesProse(responseCards + message.suggestionParts.compactMap(\.suggestionContext))
    }

    private func decisionCard(_ part: MessagePart) -> some View {
        let isApproval = part.type == "approval"
        let headerLayout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 11))
        return VStack(alignment: .leading, spacing: 12) {
            headerLayout {
                Image(systemName: isApproval ? "checkmark.shield.fill" : "creditcard.trianglebadge.exclamationmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 38, height: 38)
                    .background(AssistantTheme.warning(for: colorScheme).opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(isApproval ? "Approval needed" : "Budget decision")
                        .font(.subheadline.weight(.semibold))
                    Text(isApproval ? "Review before continuing." : "The assistant needs more room to continue.")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.76))
                }
                .fixedSize(horizontal: false, vertical: true)
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                if let code = part.shortCode, !code.isEmpty {
                    Text(code)
                        .font(.caption.monospaced().weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 7)
                        .background(AssistantTheme.warning(for: colorScheme).opacity(0.12), in: Capsule())
                }
            }

            Text(part.summary ?? "Review this action before the assistant continues.")
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.leading)
                .lineLimit(4)

            HStack(spacing: 8) {
                Text("Review decision")
                    .font(.caption.weight(.semibold))
                Spacer()
                Image(systemName: "arrow.right")
                    .font(.caption.weight(.bold))
            }
            .padding(.top, 1)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
        }
        .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func approvalSummaryCard(_ summary: ApprovalSummary) -> some View {
        if summary.pendingCount == 0 {
            if summary.outcomes.isEmpty {
                settledDecisionReceipt(.init(type: "approval", summary: summary.purpose, status: "resolved"))
            } else {
                ForEach(summary.outcomes) { outcome in
                    settledDecisionReceipt(.init(type: "approval", approvalId: outcome.id,
                        summary: outcome.summary.isEmpty ? summary.purpose : outcome.summary, status: outcome.status))
                }
            }
        } else {
            pendingApprovalSummaryCard(summary)
        }
    }

    private func pendingApprovalSummaryCard(_ summary: ApprovalSummary) -> some View {
        let actionLabel = summary.pendingCount == 1 ? "action is" : "actions are"
        let answered = summary.outcomes.filter { $0.status != "pending" && $0.status != "snoozed" }.count
        let countLabel = "\(summary.pendingCount) \(actionLabel) waiting for review."
            + (answered > 0 ? " \(answered) already answered." : "")
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)

        return Button(action: openApprovals) {
            VStack(alignment: .leading, spacing: 10) {
                Label("Approval needed to continue", systemImage: "checkmark.shield.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))

                Text(summary.purpose)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                    .multilineTextAlignment(.leading)

                Text(countLabel)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.78))

                HStack(spacing: 8) {
                    Text("Review approvals")
                        .font(.caption.weight(.semibold))
                    Spacer()
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.bold))
                }
                .padding(.top, 1)
                .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AssistantTheme.warningSurface(for: colorScheme), in: shape)
            .overlay {
                shape.stroke(
                    AssistantTheme.warning(for: colorScheme)
                        .opacity(colorSchemeContrast == .increased ? 0.58 : 0.3),
                    lineWidth: colorSchemeContrast == .increased ? 1.2 : 1
                )
            }
        }
        .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.985))
        .accessibilityLabel("Approval needed to continue: \(summary.purpose). \(countLabel)")
        .accessibilityHint("Opens Approvals to review the pending actions.")
    }

    private func isPendingDecision(_ part: MessagePart) -> Bool {
        part.status == nil || part.status == "pending" || part.status == "snoozed"
    }

    private func inlineDecisionRow(
        approvalId: String,
        rememberLabel: String?,
        decide: @escaping (String, String) async -> Bool
    ) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))
        return VStack(spacing: 8) {
            layout {
                AssistantConfirmationButton("Approve", confirmationTitle: "Approve?", systemImage: "checkmark",
                    kind: .primary, hint: "Approves this request and resumes the task.", compact: true, fillsWidth: true) {
                    guard !decidingApproval else { return }
                    decidingApproval = true
                    approvalFailureID = nil
                    let confirmed = await decide(approvalId, "approved")
                    approvalFailureID = confirmed ? nil : approvalId
                    decidingApproval = false
                    AccessibilityNotification.Announcement(confirmed ? "Permission approved" : "Decision couldn’t be confirmed. Review Approvals before trying again.").post()
                }
                AssistantConfirmationButton("Deny", confirmationTitle: "Deny?", systemImage: "xmark",
                    kind: .neutral, hint: "Stops this action.", compact: true, fillsWidth: true) {
                    guard !decidingApproval else { return }
                    decidingApproval = true
                    approvalFailureID = nil
                    let confirmed = await decide(approvalId, "denied")
                    approvalFailureID = confirmed ? nil : approvalId
                    decidingApproval = false
                    AccessibilityNotification.Announcement(confirmed ? "Permission declined" : "Decision couldn’t be confirmed. Review Approvals before trying again.").post()
                }
            }
            if let rememberLabel, let rememberApproval {
                AssistantAlwaysApproveButton(scope: rememberLabel, fillsWidth: true) {
                    guard !decidingApproval else { return }
                    decidingApproval = true
                    approvalFailureID = nil
                    let confirmed = await rememberApproval(approvalId)
                    approvalFailureID = confirmed ? nil : approvalId
                    decidingApproval = false
                    AccessibilityNotification.Announcement(confirmed ? "Standing permission saved" : "Standing permission couldn’t be confirmed. Review Approvals before trying again.").post()
                }
                .accessibilityIdentifier("assistant.chat.\(approvalId).alwaysApprove")
            }
            if approvalFailureID == approvalId {
                AssistantInlineFailure(message: "Couldn’t confirm that decision. Review Approvals before trying again.")
            }
        }
        .id(approvalId)
        .disabled(decidingApproval)
    }

    private func settledDecisionReceipt(_ part: MessagePart) -> some View {
        let presentation = settledDecisionPresentation(part)
        let review = DecisionReceiptPresentation(part: part)
        return VStack(alignment: .leading, spacing: 8) {
            DecisionReceiptCard(title: presentation.title, summary: part.summary ?? presentation.detail,
                detail: presentation.detail, code: part.shortCode, symbol: presentation.symbol, tint: presentation.tint)
            if review.reviewInActivity, let openActivity {
                Button("Review Activity", systemImage: "list.bullet", action: openActivity)
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
            } else if review.reviewInApprovals {
                Button("Review Approvals", systemImage: "checkmark.shield", action: openApprovals)
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
            }
        }
    }

    private func settledDecisionPresentation(
        _ part: MessagePart
    ) -> (title: String, detail: String, symbol: String, tint: Color) {
        let presentation = DecisionReceiptPresentation(part: part)
        let tint: Color = switch presentation.tone {
        case .success: AssistantTheme.success(for: colorScheme)
        case .error: AssistantTheme.errorInk(for: colorScheme)
        case .muted: AssistantTheme.inkMuted(for: colorScheme)
        }
        return (presentation.title, presentation.detail, presentation.symbol, tint)
    }

    /// The honesty guard's marker on a tool-less reply that claimed work it
    /// could not have run: the text above stays (it had already streamed), the
    /// card carries the trust state and the rerun. Mirrored from the web's
    /// off-course-card.tsx — keep the copy in step.
    @ViewBuilder
    private var offCourseCard: some View {
        let tint = AssistantTheme.inkMuted(for: colorScheme)
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
        VStack(alignment: .leading, spacing: 10) {
            Label("Answered without checking", systemImage: "arrow.trianglehead.turn.up.right.circle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(tint)
            Text("That reply came from memory, not from your accounts — no lookup or action actually ran, so don’t take anything it claimed as checked or done.")
                .font(.system(size: messageFontSize, weight: .regular))
                .tracking(-0.08)
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .lineSpacing(2.5)
            if let runForReal, let userPrompt {
                Button {
                    runForReal(userPrompt)
                } label: {
                    Text("Run it for real")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .padding(.horizontal, 14)
                        .frame(height: 36)
                        .background(
                            Capsule().strokeBorder(
                                AssistantTheme.accent(for: colorScheme).opacity(0.35),
                                lineWidth: 1
                            )
                        )
                        .contentShape(Capsule())
                }
                .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.97))
                .accessibilityHint("Sends the same request again as a real task")
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.bubblePaper(for: colorScheme), in: shape)
        .overlay { shape.strokeBorder(tint.opacity(0.25), lineWidth: 0.9) }
    }

    private func noticeCard(
        _ kind: ChatNoticeKind,
        text: String,
        compact: ChatCardPresentation?,
        originalText: String?,
        retractionReason: String?
    ) -> some View {
        let presentation: (label: String, headline: String, summary: String, symbol: String, tint: Color) = switch kind {
        case .responseContract:
            (
                "Needs review",
                text.hasPrefix("Completed:") ? "Partially completed" : "Result not confirmed",
                text,
                "exclamationmark.circle",
                AssistantTheme.warning(for: colorScheme)
            )
        case .parked:
            (
                "Paused",
                "Work paused",
                compact?.summary ?? "This work will resume automatically when its limit resets.",
                "pause.circle.fill",
                AssistantTheme.warning(for: colorScheme)
            )
        case .needsAttention:
            (
                "Needs your attention",
                "Your input is needed",
                compact?.summary ?? CardText.compactSummary(text),
                "exclamationmark.triangle.fill",
                AssistantTheme.warning(for: colorScheme)
            )
        case .providerFailed:
            (
                "Response interrupted",
                "Response interrupted",
                compact?.summary ?? "The model service was unavailable. Review Activity before trying again.",
                "xmark.circle.fill",
                AssistantTheme.inkMuted(for: colorScheme)
            )
        case .turnFailed:
            (
                "Couldn’t finish",
                "Reply not completed",
                compact?.summary ?? "Review Activity for any work that started before trying again.",
                "xmark.circle.fill",
                AssistantTheme.inkMuted(for: colorScheme)
            )
        case .retracted:
            (
                "Retracted response",
                "Response retracted",
                compact?.summary ?? "This response was removed because its claims were not sufficiently supported.",
                "arrow.uturn.backward.circle.fill",
                AssistantTheme.inkMuted(for: colorScheme)
            )
        }
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.chatCardCornerRadius, style: .continuous)
        let diagnostics = kind == .responseContract ? [] : (compact?.diagnostics ?? (text == presentation.summary ? [] : [text]))
        return VStack(alignment: .leading, spacing: 10) {
            Label(presentation.label, systemImage: presentation.symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(presentation.tint)
            Text(kind == .responseContract ? presentation.headline : (compact?.headline ?? presentation.headline))
                .font(.body.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            Text(presentation.summary)
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .lineLimit(kind == .responseContract ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
            if let facts = compact?.facts?.prefix(3), !facts.isEmpty {
                AssistantFlowLayout(spacing: 8) {
                    ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                        Text("\(fact.label)  \(fact.value)")
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                }
            }
            if kind == .turnFailed || kind == .providerFailed, let openActivity {
                Button("Review Activity", systemImage: "list.bullet", action: openActivity)
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
            }
            // Retry is deliberate: interruption can follow work already done.
            if kind == .turnFailed, let retry, let userPrompt {
                Button {
                    retry(userPrompt)
                } label: {
                    Text("Try again")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(
                            Capsule().strokeBorder(
                                AssistantTheme.accent(for: colorScheme).opacity(0.35),
                                lineWidth: 1
                            )
                        )
                        .contentShape(Capsule())
                }
                .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.97))
                .accessibilityHint("Sends the same message again")
            }
            if kind == .retracted {
                CardDisclosure(collapsedLabel: "View original response", expandedLabel: "Hide original response") {
                    if let retractionReason {
                        Text(retractionReason)
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                    if let originalText, !originalText.isEmpty {
                        Text(originalText)
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 6)
                    }
                }
                .font(.caption.weight(.medium))
            }
            if kind != .retracted,
               !diagnostics.isEmpty {
                CardDisclosure(collapsedLabel: compact?.detailLabel ?? "Details", expandedLabel: "Hide details") {
                    Text(diagnostics.joined(separator: "\n\n"))
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(
                            AssistantTheme.sunken(for: colorScheme).opacity(0.58),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                }
                .font(.caption.weight(.medium))
            }
        }
        .padding(16)
        .padding(.leading, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.bubblePaper(for: colorScheme), in: shape)
        .overlay { shape.strokeBorder(presentation.tint.opacity(0.25), lineWidth: 0.9) }
        .contextMenu { cardMenu(copyLabel: "Copy notice", copying: text) }
    }
}

/// The chat transport can send a `data-card` part when the result already has
/// shape. A conservative text fallback covers existing servers while keeping
/// unrelated prose as prose. Both paths share the same visual system below.
extension MessagePart {
    var suggestionContext: MessageResponseCard? {
        guard type == "suggestion", let contextCard,
              case let .object(data) = contextCard,
              data["kind"]?.string == "proactive-alert",
              let id = data["id"]?.string, !id.isEmpty,
              let title = data["title"]?.string, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let card = MessageResponseCard(part: .init(type: "data-card", data: contextCard)),
              case .proactiveAlert = card else { return nil }
        return card
    }

    var suggestionActionLabel: String {
        let label = actionLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return label.isEmpty ? "Start task" : label
    }

    var suggestionTitle: String {
        if case let .proactiveAlert(_, _, _, title, _, _, _, _)? = suggestionContext { return title }
        return summary ?? "Suggestion"
    }
}

extension ChatMessage {
    var standaloneResponseCards: [MessageResponseCard] {
        responseCards(formRendererAvailable: false)
    }

    func responseCards(formRendererAvailable: Bool) -> [MessageResponseCard] {
        let paired = Set(suggestionParts.compactMap { $0.suggestionContext?.id })
        return parts.compactMap {
            MessageResponseCard(part: $0, formRendererAvailable: formRendererAvailable)
        }.filter { card in
            if case .proactiveAlert = card { return !paired.contains(card.id) }
            return true
        }
    }
}

enum MessageResponseCard: Identifiable {
    struct AgendaItem: Identifiable {
        let time: String
        let title: String
        let detail: String
        var id: String { "\(time)-\(title)" }
    }

    /// The forecast as numbers (`days`/`current` on the payload), drawn as
    /// fixed-column rows that never wrap. Empty on an older payload, which
    /// keeps rendering its text `details`.
    struct WeatherForecast: Hashable {
        struct Day: Hashable {
            let weekday: String
            let lowC: Double
            let highC: Double
            let precipPct: Double?
            let description: String
            let symbol: String
        }
        struct Current: Hashable {
            let windKmh: Double?
            let humidity: Double?
            let precipPct: Double?
        }
        var days: [Day] = []
        var current: Current?

        init(days: [Day] = [], current: Current? = nil) {
            self.days = days
            self.current = current
        }

        init(data: [String: JSONValue]) {
            func number(_ value: JSONValue?, in range: ClosedRange<Double>) -> Double? {
                if case let .number(number)? = value, number.isFinite, range.contains(number) { return number }
                return nil
            }
            if case let .array(values)? = data["days"] {
                days = values.compactMap { value in
                    guard case let .object(day) = value,
                          let weekday = day["weekday"]?.string, !weekday.isEmpty,
                          let low = number(day["lowC"], in: -150...100),
                          let high = number(day["highC"], in: -150...100) else { return nil }
                    return Day(
                        weekday: weekday,
                        lowC: low,
                        highC: high,
                        precipPct: number(day["precipPct"], in: 0...100),
                        description: day["description"]?.string ?? "",
                        symbol: day["symbol"]?.string ?? ""
                    )
                }
            }
            if case let .object(reading)? = data["current"] {
                current = Current(
                    windKmh: number(reading["windKmh"], in: 0...500),
                    humidity: number(reading["humidity"], in: 0...100),
                    precipPct: number(reading["precipPct"], in: 0...100)
                )
            }
        }
    }

    struct WeatherDetail: Identifiable {
        let label: String
        let value: String
        /// The sky this row describes, named by the server ("rain", "fog") so
        /// the app does not re-parse prose. Empty on an older payload, and on
        /// a row that describes no sky at all ("Wind", "Humidity").
        var symbol: String = ""
        var id: String { label.lowercased() }
    }

    struct Detail: Identifiable {
        let label: String
        let value: String
        var id: String { label.lowercased() }
    }

    struct EmailResult: Identifiable {
        let id: String
        let sender: String
        let recipient: String
        let subject: String
        let date: String
        let snippet: String
    }

    struct DocumentPassage: Identifiable {
        let id: String
        let document: String
        let source: String
        let snippet: String
        let similarity: Double?
    }

    struct DriveFile: Identifiable {
        let id: String
        let name: String
        let mimeType: String
        let modifiedTime: String
        let size: String
        let url: String
    }

    struct SearchResult: Identifiable {
        let id: String
        let title: String
        let url: String
        let snippet: String
    }

    struct BusyBlock: Identifiable {
        let start: String
        let end: String
        let calendar: String

        var id: String { "\(start)-\(end)-\(calendar)" }
    }

    struct ThreadMessage: Identifiable {
        let id: String
        let sender: String
        let date: String
        let excerpt: String
    }

    struct KnowledgeEdge: Identifiable {
        let id: String
        let subject: String
        let predicate: String
        let object: String
        let evidence: String
        let source: String
        let confidence: Double?
        let ownerConfirmed: Bool
    }

    struct ConflictEvent: Identifiable {
        let id: String
        let title: String
        let start: String
        let end: String
        let calendar: String
        let location: String
    }

    struct CalendarConflict: Identifiable {
        let id: String
        let overlapStart: String
        let overlapEnd: String
        let groups: [[ConflictEvent]]
        var evidenceNote: String? = nil
    }

    struct GeneratedFact: Identifiable {
        let id: String
        let label: String
        let value: String
        let sensitive: Bool
    }

    struct GeneratedBlock: Identifiable {
        let id: String
        let type: String
        let values: [String: JSONValue]

        /// A section's blocks. Sections hold leaf blocks only, one level deep.
        var children: [GeneratedBlock] {
            guard type == "section", case let .array(values)? = values["blocks"] else { return [] }
            return values.enumerated().compactMap { index, value in
                guard case let .object(child) = value,
                      let childType = child["type"]?.string, childType != "section" else { return nil }
                return .init(id: "\(id)-\(index)-\(childType)", type: childType, values: child)
            }
        }
    }

    struct GeneratedAction: Identifiable {
        let id: String
        let type: String
        let label: String
        let factId: String?
        let prompt: String?
        /// add_to_calendar: fact ids of zoned instants and a place.
        var startFact: String? = nil
        var endFact: String? = nil
        var locationFact: String? = nil
    }

    /// One call behind a composed card, as the runtime reported it
    /// (core/workflow/card-steps.ts). The lookups that fed the card no longer
    /// arrive as cards of their own — they arrive as these.
    struct CardStep: Identifiable {
        let id: String
        let tool: String
        let count: String
        let detail: String
        let failed: Bool
        let error: String
    }

    /// The daily briefing: a lead and labelled sections, all pre-formatted
    /// in the owner's zone by the server.
    struct BriefingCard: Hashable {
        struct AgendaItem: Hashable {
            let day: String
            let time: String
            let title: String
            let location: String
            let flag: String
            let note: String
        }
        struct ListItem: Hashable {
            let title: String
            let detail: String
            let meta: String
        }
        enum Section: Hashable {
            case agenda(title: String, complete: Bool, items: [AgendaItem])
            case weather(title: String, location: String, temperature: String, condition: String, symbol: String, detail: String)
            case list(kind: String, title: String, items: [ListItem])
        }
        let id: String
        let date: String
        let lead: String
        let sections: [Section]

        init?(data: [String: JSONValue]) {
            guard let id = data["id"]?.string else { return nil }
            func text(_ object: [String: JSONValue], _ key: String) -> String { object[key]?.string ?? "" }
            var sections: [Section] = []
            if case let .array(values)? = data["sections"] {
                for value in values {
                    guard case let .object(section) = value else { continue }
                    let items: [[String: JSONValue]] = {
                        guard case let .array(rows)? = section["items"] else { return [] }
                        return rows.compactMap { if case let .object(row) = $0 { return row } else { return nil } }
                    }()
                    switch text(section, "type") {
                    case "agenda":
                        let rows = items.map { AgendaItem(day: text($0, "day"), time: text($0, "time"), title: text($0, "title"),
                                                          location: text($0, "location"), flag: text($0, "flag"), note: text($0, "note")) }
                            .filter { !$0.title.isEmpty }
                        if !rows.isEmpty {
                            sections.append(.agenda(title: text(section, "title"), complete: section["complete"] != .bool(false), items: rows))
                        }
                    case "weather":
                        guard !text(section, "temperature").isEmpty else { continue }
                        let detail = [text(section, "range"), text(section, "rain")].filter { !$0.isEmpty }.joined(separator: " · ")
                        sections.append(.weather(title: text(section, "title"), location: text(section, "location"),
                                                 temperature: text(section, "temperature"), condition: text(section, "condition"),
                                                 symbol: text(section, "symbol"), detail: detail))
                    case let kind where !kind.isEmpty:
                        let rows = items.map { ListItem(title: text($0, "title"), detail: text($0, "detail"), meta: text($0, "meta")) }
                            .filter { !$0.title.isEmpty }
                        if !rows.isEmpty { sections.append(.list(kind: kind, title: text(section, "title"), items: rows)) }
                    default:
                        continue
                    }
                }
            }
            let lead = text(data, "lead")
            guard !lead.isEmpty || !sections.isEmpty else { return nil }
            self.id = id
            self.date = text(data, "date")
            self.lead = lead
            self.sections = sections
        }
    }

    struct GeneratedCard {
        let id: String
        var revisionId: String? = nil
        /// The composer read this card out of the reply rather than out of a
        /// lookup, so the card heads the answer instead of replacing it.
        let groundedOnAnswer: Bool
        let title: String
        let subtitle: String
        let sourceLabel: String
        let icon: String
        let accessibilityLabel: String
        let facts: [GeneratedFact]
        let blocks: [GeneratedBlock]
        let actions: [GeneratedAction]
        let form: NativeCardForm?
        var steps: [CardStep]
        var updatedAt: String? = nil
        var stale: Bool? = nil
        var refreshState: String? = nil
        var refreshError: String? = nil
        var refreshable: Bool = false
        var nativeCompositionCompleteOverride: Bool? = nil

        var hasCompleteNativeComposition: Bool {
            nativeCompositionCompleteOverride ??
                NativeGeneratedCardCatalog.supportsComplete(blocks, facts: Set(facts.map(\.id)))
        }

        /// The clocks a journey block already shows, top level or in a section.
        var journeyClockFacts: Set<String> {
            Set((blocks + blocks.flatMap(\.children))
                .filter { $0.type == "journey" }
                .flatMap { [$0.values["departFact"]?.string, $0.values["arriveFact"]?.string].compactMap { $0 } })
        }

        var blockSections: (preview: [GeneratedBlock], details: [GeneratedBlock]) {
            var preview: [GeneratedBlock] = []
            var details: [GeneratedBlock] = []
            for block in blocks where !(form != nil && block.type == "form") {
                guard preview.count < 2 else { details.append(block); continue }
                let ids = block.values["factIds"]?.arrayStrings ?? []
                if ["facts", "timeline"].contains(block.type), ids.count > 4 {
                    var first = block.values
                    first["factIds"] = .array(ids.prefix(4).map(JSONValue.string))
                    preview.append(.init(id: block.id, type: block.type, values: first))
                    var remaining = block.values
                    remaining["factIds"] = .array(ids.dropFirst(4).map(JSONValue.string))
                    remaining["startIndex"] = .number(5)
                    details.append(.init(id: block.id + "-continued", type: block.type, values: remaining))
                } else {
                    preview.append(block)
                }
            }
            return (preview, details)
        }
    }

    case agenda(title: String, subtitle: String, items: [AgendaItem])
    case event(id: String, start: String, time: String, title: String, location: String, attendees: [String], calendars: [String], calendarLinkURL: String?, meetingLinkURL: String?)
    case weather(location: String, temperature: String, condition: String, details: [WeatherDetail], symbol: String, forecast: WeatherForecast = .init())
    case duration(title: String, duration: String, detail: String?, confidence: String?)
    case reminder(id: String, title: String, schedule: String, nextFires: String, enabled: Bool)
    case emails(id: String, title: String, query: String, mailbox: String, complete: Bool, matchingMessagesEstimate: Int?, messages: [EmailResult])
    case documents(id: String, title: String, query: String, passages: [DocumentPassage])
    case drive(id: String, title: String, query: String, files: [DriveFile])
    case search(id: String, title: String, query: String, results: [SearchResult])
    case availability(id: String, timeMin: String, timeMax: String, busy: [BusyBlock], calendarsChecked: [String], complete: Bool, note: String?)
    case thread(id: String, subject: String, messageCount: Int, messages: [ThreadMessage])
    case sheetRows(id: String, sheetName: String, rows: [[String]], totalRows: Int, linkURL: String?)
    case resource(id: String, resourceType: String, title: String, subtitle: String, details: [Detail], linkLabel: String?, linkURL: String?)
    case status(id: String, title: String, detail: String, symbol: String, details: [Detail], linkLabel: String?, linkURL: String?)
    case knowledgeGraph(id: String, title: String, edges: [KnowledgeEdge], complete: Bool)
    case calendarConflicts(id: String, title: String, conflicts: [CalendarConflict], complete: Bool)
    case proactiveAlert(id: String, category: String, urgency: String, title: String, summary: String, startsAt: String, dueAt: String, details: [Detail])
    case generated(GeneratedCard)
    case briefing(BriefingCard)
    case scoreboard(id: String, title: String, games: [ScoreGame], fetchedAt: Date?, pollSeconds: Int, live: Bool)
    case route(RouteInfo)

    var id: String {
        switch self {
        case let .agenda(title, _, _): "agenda-\(title)"
        case let .event(id, _, _, _, _, _, _, _, _): id
        case let .weather(location, temperature, _, details, _, _):
            // Per-day forecast cards share their location and can share a
            // reading; the day name keeps each card's identity distinct.
            "weather-\(location)-\(details.first { $0.label.caseInsensitiveCompare("Day") == .orderedSame }?.value ?? "")-\(temperature)"
        case let .duration(title, duration, _, _): "duration-\(title)-\(duration)"
        case let .reminder(id, _, _, _, _): id
        case let .emails(id, _, _, _, _, _, _): id
        case let .documents(id, _, _, _): id
        case let .drive(id, _, _, _): id
        case let .search(id, _, _, _): id
        case let .availability(id, _, _, _, _, _, _): id
        case let .thread(id, _, _, _): id
        case let .sheetRows(id, _, _, _, _): id
        case let .resource(id, _, _, _, _, _, _): id
        case let .status(id, _, _, _, _, _, _): id
        case let .knowledgeGraph(id, _, _, _): id
        case let .calendarConflicts(id, _, _, _): id
        case let .proactiveAlert(id, _, _, _, _, _, _, _): id
        case let .generated(card): card.id
        case let .briefing(card): card.id
        case let .scoreboard(id, _, _, _, _, _): id
        case let .route(route): route.id
        }
    }

    init?(part: MessagePart) {
        self.init(part: part, formRendererAvailable: false)
    }

    init?(part: MessagePart, formRendererAvailable: Bool) {
        guard part.type == "data-card", case let .object(data)? = part.data,
              let kind = data["kind"]?.string else { return nil }
        switch kind {
        case "calendar-event":
            guard let title = data["title"]?.string else { return nil }
            let rawStart = data["start"]?.string ?? ""
            let allDay = data["allDay"] == .bool(true)
            let start = allDay ? String(rawStart.prefix(10)) : rawStart
            let time = allDay ? "All day" : CalendarEventPresentation.timeLabel(start: start,
                end: data["end"]?.string, fallback: data["time"]?.string ?? "Time unavailable")
            let attendees = data["attendees"]?.arrayStrings ?? []
            let calendars = data["calendars"]?.arrayStrings ?? []
            let calendarLink = data["calendarLink"]?.objectValue
            let meetingLink = data["meetingLink"]?.objectValue
            let legacyURL = data["link"]?.objectValue?["url"]?.string
            self = .event(
                id: data["id"]?.string ?? "calendar-\(title)-\(time)",
                start: start, time: time, title: title,
                location: data["location"]?.string ?? "", attendees: attendees, calendars: calendars,
                calendarLinkURL: calendarLink?["url"]?.string
                    ?? (Self.isCalendarEventURL(legacyURL) ? legacyURL : nil),
                meetingLinkURL: meetingLink?["url"]?.string
                    ?? (Self.isMeetingURL(legacyURL) ? legacyURL : nil)
            )
        case "calendar", "agenda":
            let items: [AgendaItem] = {
                guard case let .array(values)? = data["items"] else { return [] }
                return values.compactMap { value in
                    guard case let .object(item) = value,
                          let time = item["time"]?.string,
                          let title = item["title"]?.string else { return nil }
                    return .init(time: time, title: title, detail: item["detail"]?.string ?? "")
                }
            }()
            guard !items.isEmpty else { return nil }
            self = .agenda(
                title: data["title"]?.string ?? "Today",
                subtitle: data["subtitle"]?.string ?? "Your schedule",
                items: Array(items.prefix(6))
            )
        case "weather":
            guard let temperature = data["temperature"]?.string,
                  let condition = data["condition"]?.string else { return nil }
            let details = Self.weatherDetails(from: data)
            self = .weather(
                location: data["location"]?.string ?? "Right now",
                temperature: temperature,
                condition: condition,
                details: details,
                symbol: data["symbol"]?.string ?? "",
                forecast: WeatherForecast(data: data)
            )
        case "duration", "time-estimate":
            guard let duration = data["duration"]?.string else { return nil }
            self = .duration(
                title: data["title"]?.string ?? "Time estimate",
                duration: duration,
                detail: data["detail"]?.string,
                confidence: data["confidence"]?.string
            )
        case "reminder":
            guard let title = data["title"]?.string else { return nil }
            self = .reminder(
                id: data["id"]?.string ?? "reminder-\(title)",
                title: title,
                schedule: data["schedule"]?.string ?? "",
                nextFires: data["nextFires"]?.string ?? "",
                enabled: data["enabled"]?.boolValue ?? true
            )
        case "email-results":
            let messages: [EmailResult] = {
                guard case let .array(values)? = data["messages"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(message) = value else { return nil }
                    return .init(
                        id: message["id"]?.string ?? "email-\(index)",
                        sender: message["sender"]?.string ?? "",
                        recipient: message["recipient"]?.string ?? "",
                        subject: message["subject"]?.string ?? "No subject",
                        date: message["date"]?.string ?? "",
                        snippet: message["snippet"]?.string ?? ""
                    )
                }
            }()
            self = .emails(
                id: data["id"]?.string ?? "email-results",
                title: data["title"]?.string ?? "Email results",
                query: data["query"]?.string ?? "",
                mailbox: data["mailbox"]?.string ?? "",
                complete: data["complete"]?.boolValue ?? true,
                matchingMessagesEstimate: data["matchingMessagesEstimate"]?.integerValue,
                messages: messages
            )
        case "document-results":
            let passages: [DocumentPassage] = {
                guard case let .array(values)? = data["passages"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(passage) = value else { return nil }
                    return .init(
                        id: passage["id"]?.string ?? "passage-\(index)",
                        document: passage["document"]?.string ?? "Untitled document",
                        source: passage["source"]?.string ?? "",
                        snippet: passage["snippet"]?.string ?? "",
                        similarity: passage["similarity"]?.numberValue.flatMap { (0...1).contains($0) ? $0 : nil }
                    )
                }
            }()
            self = .documents(
                id: data["id"]?.string ?? "document-results",
                title: data["title"]?.string ?? "Document matches",
                query: data["query"]?.string ?? "",
                passages: passages
            )
        case "drive-results":
            let files: [DriveFile] = {
                guard case let .array(values)? = data["files"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(file) = value else { return nil }
                    return .init(
                        id: file["id"]?.string ?? "file-\(index)",
                        name: file["name"]?.string ?? "Untitled file",
                        mimeType: file["mimeType"]?.string ?? "",
                        modifiedTime: file["modifiedTime"]?.string ?? "",
                        size: file["size"]?.string ?? "",
                        url: file["url"]?.string ?? ""
                    )
                }
            }()
            guard !files.isEmpty else { return nil }
            self = .drive(
                id: data["id"]?.string ?? "drive-results",
                title: data["title"]?.string ?? "Drive files",
                query: data["query"]?.string ?? "",
                files: files
            )
        case "knowledge-graph":
            guard case let .array(nodeValues)? = data["nodes"] else { return nil }
            let nodePairs = nodeValues.compactMap { value -> (String, String)? in
                guard case let .object(node) = value,
                      let id = node["id"]?.string, !id.isEmpty else { return nil }
                return (id, node["label"]?.string ?? "Unknown")
            }
            guard nodePairs.count == nodeValues.count,
                  Set(nodePairs.map(\.0)).count == nodePairs.count else { return nil }
            let nodes = Dictionary(nodePairs, uniquingKeysWith: { first, _ in first })
            let edges: [KnowledgeEdge] = {
                guard case let .array(values)? = data["edges"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(edge) = value else { return nil }
                    return .init(
                        id: edge["id"]?.string ?? "edge-\(index)",
                        subject: nodes[edge["from"]?.string ?? ""] ?? "Unknown",
                        predicate: edge["label"]?.string ?? "connected to",
                        object: nodes[edge["to"]?.string ?? ""] ?? "Unknown",
                        evidence: edge["evidenceQuote"]?.string ?? "",
                        source: edge["source"]?.string ?? "",
                        confidence: edge["confidence"]?.numberValue.flatMap { (0...1).contains($0) ? $0 : nil },
                        ownerConfirmed: edge["ownerConfirmed"]?.boolValue ?? false
                    )
                }
            }()
            guard !edges.isEmpty else { return nil }
            self = .knowledgeGraph(
                id: data["id"]?.string ?? "knowledge-graph",
                title: data["title"]?.string ?? "Saved connections",
                edges: edges,
                complete: data["complete"]?.boolValue ?? true
            )
        case "calendar-conflicts":
            let conflicts: [CalendarConflict] = {
                guard case let .array(values)? = data["conflicts"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(conflict) = value,
                          case let .array(groupValues)? = conflict["groups"] else { return nil }
                    let groups = groupValues.compactMap { groupValue -> [ConflictEvent]? in
                        guard case let .object(group) = groupValue,
                              case let .array(eventValues)? = group["events"] else { return nil }
                        return eventValues.enumerated().compactMap { eventIndex, eventValue in
                            guard case let .object(event) = eventValue else { return nil }
                            return .init(
                                id: event["id"]?.string ?? "event-\(eventIndex)",
                                title: event["title"]?.string ?? "Untitled event",
                                start: event["start"]?.string ?? "",
                                end: event["end"]?.string ?? "",
                                calendar: event["calendar"]?.string ?? "Calendar",
                                location: event["location"]?.string ?? ""
                            )
                        }
                    }
                    guard groups.count == 2 else { return nil }
                    return .init(
                        id: conflict["id"]?.string ?? "conflict-\(index)",
                        overlapStart: conflict["overlapStart"]?.string ?? "",
                        overlapEnd: conflict["overlapEnd"]?.string ?? "",
                        groups: groups,
                        evidenceNote: conflict["evidenceNote"]?.string
                    )
                }
            }()
            guard !conflicts.isEmpty else { return nil }
            self = .calendarConflicts(
                id: data["id"]?.string ?? "calendar-conflicts",
                title: data["title"]?.string ?? "Schedule conflict",
                conflicts: conflicts,
                complete: data["complete"]?.boolValue ?? true
            )
        case "web-search-results":
            let results: [SearchResult] = {
                guard case let .array(values)? = data["results"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(result) = value else { return nil }
                    let url = result["url"]?.string ?? ""
                    guard !url.isEmpty else { return nil }
                    return .init(
                        id: result["id"]?.string ?? "result-\(index)",
                        title: result["title"]?.string ?? url,
                        url: url,
                        snippet: result["snippet"]?.string ?? ""
                    )
                }
            }()
            self = .search(
                id: data["id"]?.string ?? "web-search-results",
                title: data["title"]?.string ?? "Web results",
                query: data["query"]?.string ?? "",
                results: results
            )
        case "availability":
            let rawBusy: [JSONValue]?
            if case let .array(values)? = data["busy"] {
                rawBusy = values
            } else {
                rawBusy = nil
            }
            let busy: [BusyBlock] = rawBusy?.compactMap { value in
                guard case let .object(slot) = value,
                      let start = slot["start"]?.string,
                      let startDate = CardText.timestamp(start),
                      let end = slot["end"]?.string,
                      let endDate = CardText.timestamp(end),
                      endDate > startDate else { return nil }
                return .init(start: start, end: end, calendar: slot["calendar"]?.string ?? "")
            } ?? []
            let checkedCalendars = (data["calendarsChecked"]?.arrayStrings ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            let allBusyRowsUsable = rawBusy.map { busy.count == $0.count } ?? false
            self = .availability(
                id: data["id"]?.string ?? "availability",
                timeMin: data["timeMin"]?.string ?? "",
                timeMax: data["timeMax"]?.string ?? "",
                busy: busy,
                calendarsChecked: checkedCalendars,
                complete: data["complete"]?.boolValue == true
                    && !checkedCalendars.isEmpty
                    && allBusyRowsUsable,
                note: data["note"]?.string
            )
        case "email-thread":
            let messages: [ThreadMessage] = {
                guard case let .array(values)? = data["messages"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(message) = value else { return nil }
                    return .init(
                        id: message["id"]?.string ?? "message-\(index)",
                        sender: message["sender"]?.string ?? "",
                        date: message["date"]?.string ?? "",
                        excerpt: message["excerpt"]?.string ?? ""
                    )
                }
            }()
            self = .thread(
                id: data["id"]?.string ?? "email-thread",
                subject: data["subject"]?.string ?? "Email thread",
                messageCount: data["messageCount"]?.integerValue ?? messages.count,
                messages: messages
            )
        case "sheet-rows":
            let rows: [[String]] = {
                guard case let .array(values)? = data["rows"] else { return [] }
                return values.compactMap { value in
                    guard case let .array(cells) = value else { return nil }
                    return cells.map { cell in
                        switch cell {
                        case let .string(text): text
                        case let .number(value):
                            value.rounded() == value
                                ? (JSONValue.number(value).integerValue.map(String.init) ?? String(value))
                                : String(value)
                        case let .bool(flag): flag ? "TRUE" : "FALSE"
                        default: ""
                        }
                    }
                }
            }()
            self = .sheetRows(
                id: data["id"]?.string ?? "sheet-rows",
                sheetName: data["sheetName"]?.string ?? "Sheet",
                rows: rows,
                totalRows: data["totalRows"]?.integerValue ?? rows.count,
                linkURL: data["link"]?.objectValue?["url"]?.string
            )
        case "resource":
            guard let title = data["title"]?.string else { return nil }
            let link = data["link"]?.objectValue
            self = .resource(
                id: data["id"]?.string ?? "resource-\(title)",
                resourceType: data["resourceType"]?.string ?? "resource",
                title: title,
                subtitle: data["subtitle"]?.string ?? "Ready",
                details: Self.details(from: data),
                linkLabel: link?["label"]?.string,
                linkURL: link?["url"]?.string
            )
        case "status":
            guard let title = data["title"]?.string else { return nil }
            let link = data["link"]?.objectValue
            self = .status(
                id: data["id"]?.string ?? "status-\(title)",
                title: title,
                detail: data["detail"]?.string ?? "",
                symbol: data["symbol"]?.string ?? "checkmark.circle.fill",
                details: Self.details(from: data),
                linkLabel: link?["label"]?.string,
                linkURL: link?["url"]?.string
            )
        case "proactive-alert":
            guard let title = data["title"]?.string else { return nil }
            self = .proactiveAlert(
                id: data["id"]?.string ?? "proactive-alert-\(title)",
                category: data["category"]?.string ?? "event",
                urgency: data["urgencyLabel"]?.string ?? "Worth your attention",
                title: title,
                summary: data["summary"]?.string ?? "",
                startsAt: data["startsAt"]?.string ?? "",
                dueAt: data["dueAt"]?.string ?? "",
                details: Self.details(from: data)
            )
        case "briefing":
            guard let card = BriefingCard(data: data) else { return nil }
            self = .briefing(card)
        case "route":
            guard let route = RouteInfo(data: data) else { return nil }
            self = .route(route)
        case "scoreboard":
            guard let id = data["id"]?.string, case let .array(values)? = data["games"] else { return nil }
            let games = values.compactMap(ScoreGame.init)
            guard !games.isEmpty else { return nil }
            let live = data["live"]?.objectValue
            let poll: Int = {
                if let seconds = live?["pollSeconds"]?.integerValue, (5...300).contains(seconds) { return seconds }
                return 30
            }()
            self = .scoreboard(
                id: id,
                title: data["title"]?.string ?? "Scores",
                games: games,
                fetchedAt: (data["fetchedAt"]?.string).flatMap(ISO8601DateFormatter.flexible),
                pollSeconds: poll,
                live: live != nil
            )
        case "generated-card":
            guard let spec = data["spec"]?.objectValue,
                  spec["version"]?.integerValue == 1,
                  let title = spec["title"]?.string, !title.isEmpty else { return nil }
            let facts: [GeneratedFact] = {
                guard case let .array(values)? = spec["facts"] else { return [] }
                return values.compactMap { value in
                    guard case let .object(fact) = value,
                          let id = fact["id"]?.string,
                          let value = fact["value"]?.string else { return nil }
                    return .init(
                        id: id,
                        label: fact["label"]?.string ?? "Detail",
                        value: value,
                        sensitive: fact["sensitive"]?.boolValue ?? false
                    )
                }
            }()
            let blocks: [GeneratedBlock] = {
                guard case let .array(values)? = spec["blocks"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(block) = value,
                          let type = block["type"]?.string else { return nil }
                    return .init(id: "\(index)-\(type)", type: type, values: block)
                }
            }()
            let nativeForm: NativeCardForm? = {
                guard let revisionId = data["revisionId"]?.string,
                      let candidate = NativeCardFormParser.forms(
                        in: spec,
                        cardId: data["id"]?.string ?? "",
                        revisionId: revisionId
                      ).first else { return nil }
                let factsById = Dictionary(facts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                guard candidate.warningFactIds.allSatisfy({ factsById[$0]?.sensitive == false && factsById[$0] != nil }) else {
                    return nil
                }
                return candidate
            }()
            let actions: [GeneratedAction] = {
                guard case let .array(values)? = spec["actions"] else { return [] }
                return values.compactMap { value in
                    guard case let .object(action) = value,
                          let id = action["id"]?.string,
                          let type = action["type"]?.string,
                          let label = action["label"]?.string else { return nil }
                    return .init(
                        id: id,
                        type: type,
                        label: label,
                        factId: action["factId"]?.string,
                        prompt: action["prompt"]?.string,
                        startFact: action["startFact"]?.string,
                        endFact: action["endFact"]?.string,
                        locationFact: action["locationFact"]?.string
                    )
                }
            }()
            // Provenance rides on the card payload, not on the spec: the spec
            // is the model-authored layout, and the trail is read off the tool
            // ledger. A build that sends no steps simply has no row to show.
            let steps: [CardStep] = {
                guard case let .array(values)? = data["steps"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(step) = value,
                          let tool = step["tool"]?.string, !tool.isEmpty else { return nil }
                    return .init(
                        id: "\(index)-\(tool)",
                        tool: tool,
                        count: step["count"]?.string ?? "",
                        detail: step["detail"]?.string ?? "",
                        failed: step["failed"]?.boolValue ?? false,
                        error: step["error"]?.string ?? ""
                    )
                }
            }()
            guard !facts.isEmpty, !blocks.isEmpty else { return nil }
            self = .generated(.init(
                id: data["id"]?.string ?? "generated-\(title)",
                revisionId: data["revisionId"]?.string,
                // Grounding rides on the payload beside the trail, not in the
                // model-authored spec: which corpus a card stands on is the
                // runtime's finding, never the composer's claim. An older
                // build sends none, and a lookup card is the safe default.
                // A card from the owner's own message heads the reply the same way.
                groundedOnAnswer: ["answer", "message"].contains(data["grounding"]?.string ?? ""),
                title: title,
                subtitle: spec["subtitle"]?.string ?? "",
                sourceLabel: spec["sourceLabel"]?.string ?? "Assistant card",
                icon: spec["icon"]?.string ?? "generic",
                accessibilityLabel: spec["accessibilityLabel"]?.string ?? title,
                facts: facts,
                blocks: blocks,
                actions: actions,
                form: nativeForm,
                steps: steps,
                updatedAt: data["updatedAt"]?.string,
                stale: data["stale"]?.boolValue,
                refreshState: data["refreshState"]?.string,
                refreshError: data["refreshError"]?.string,
                refreshable: spec["refreshable"]?.boolValue ?? actions.contains { $0.type == "refresh" },
                nativeCompositionCompleteOverride: NativeGeneratedCardCatalog.supportsComplete(
                    spec: spec,
                    validatedNativeForm: formRendererAvailable ? nativeForm : nil
                )
            ))
        default:
            return nil
        }
    }

    private static func isCalendarEventURL(_ value: String?) -> Bool {
        guard let url = value.flatMap(URL.init(string:)), let host = url.host?.lowercased() else {
            return false
        }
        return host == "calendar.google.com" || host.hasSuffix(".calendar.google.com")
    }

    private static func isMeetingURL(_ value: String?) -> Bool {
        guard let url = value.flatMap(URL.init(string:)), let host = url.host?.lowercased() else {
            return false
        }
        return ["zoom.us", "meet.google.com", "teams.microsoft.com", "webex.com"].contains { domain in
            host == domain || host.hasSuffix(".\(domain)")
        }
    }

    /// Whether these cards stand in for the reply or merely head it.
    ///
    /// A card grounded in a lookup carries the answer, so prose beside it
    /// would only repeat it. A card the composer read out of the reply itself
    /// is different: it redraws part of an answer that also explains the
    /// route, the caveats, and when to leave. It summarizes the reply, and
    /// replacing the reply with it would delete the rest of the answer.
    /// Whether the server marked every card on the message to sit under the
    /// reply — each card of a multi-part answer, where one card alone cannot
    /// speak for the rest. Honoured for any kind, as the web does.
    static func allSitUnderProse(_ parts: [MessagePart]) -> Bool {
        let cardParts = parts.filter { $0.type == "data-card" }
        return !cardParts.isEmpty && cardParts.allSatisfy { part in
            guard case let .object(data)? = part.data else { return false }
            return data["accompaniesProse"] == .bool(true)
        }
    }

    static func replacesProse(_ cards: [Self]) -> Bool {
        guard !cards.isEmpty else { return false }
        // A card is allowed to replace prose only when this native build can
        // render every requested block and every reference it needs. This is
        // the text fallback for an older or partially compatible schema.
        if cards.contains(where: { card in
            if case let .generated(generated) = card { return !generated.hasCompleteNativeComposition }
            return false
        }) { return false }
        return !cards.allSatisfy(\.summarizesAnswer)
    }

    var summarizesAnswer: Bool {
        if case let .generated(card) = self { return card.groundedOnAnswer }
        // A scoreboard sits under the reply's one-line takeaway, not in place of it.
        if case .scoreboard = self { return true }
        // The reply carries "leave by 2:40"; the route card is its map.
        if case .route = self { return true }
        return false
    }
    static func inferredLegacy(from text: String) -> [Self] {
        if let alert = inferredLegacyAlert(text) { return [alert] }
        if let agenda = inferredNumberedAgenda(text) { return [agenda] }
        return []
    }

    private static func inferredLegacyAlert(_ text: String) -> Self? {
        let pattern = #"^\"([^\"]{1,120})\" starts in (\d{1,3}) minutes?(?: at (.*?))?\.\s+"#
        guard let expression = NSRegularExpression.cached(pattern, options: [.caseInsensitive]),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let titleRange = Range(match.range(at: 1), in: text),
              let minutesRange = Range(match.range(at: 2), in: text) else { return nil }
        let title = String(text[titleRange])
        let minutes = String(text[minutesRange])
        let location = Range(match.range(at: 3), in: text).map { String(text[$0]) } ?? ""
        return .proactiveAlert(
            id: "legacy-event-\(title)-\(minutes)",
            category: "event",
            urgency: "Starts in \(minutes) min",
            title: title,
            summary: "",
            startsAt: "",
            dueAt: "",
            details: location.isEmpty ? [] : [.init(label: "Location", value: location)]
        )
    }

    private static func inferredNumberedAgenda(_ text: String) -> Self? {
        let marker = NSRegularExpression.cached(#"(?:^|\s)(\d+)\)\s"#)
        guard let marker else { return nil }
        let fullRange = NSRange(text.startIndex..., in: text)
        let matches = marker.matches(in: text, range: fullRange)
        guard matches.count >= 2 else { return nil }
        var items: [AgendaItem] = []
        for index in matches.indices {
            guard let start = Range(matches[index].range, in: text)?.upperBound else { return nil }
            let end: String.Index
            if index + 1 < matches.count,
               let next = Range(matches[index + 1].range, in: text)?.lowerBound {
                end = next
            } else {
                end = text.endIndex
            }
            let chunk = String(text[start..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let item = numberedAgendaItem(chunk) else { return nil }
            items.append(item)
        }
        guard let firstMarker = Range(matches[0].range, in: text)?.lowerBound else { return nil }
        let lead = String(text[..<firstMarker]).lowercased()
        return .agenda(
            title: lead.contains("tomorrow") ? "Tomorrow" : "Your schedule",
            subtitle: "\(items.count) upcoming events",
            items: Array(items.prefix(10))
        )
    }

    private static func numberedAgendaItem(_ value: String) -> AgendaItem? {
        let clock = #"\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?"#
        let patterns = [
            #"^(.*?)\s+from\s+("# + clock + #"\s*[–-]\s*"# + clock + #")(?:\s+at\s+(.+?))?\.?$"#,
            #"^(.*?)\s+at\s+("# + clock + #")(?:\s+at\s+(.+?))?\.?$"#,
        ]
        for pattern in patterns {
            guard let expression = NSRegularExpression.cached(pattern, options: [.caseInsensitive]),
                  let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
                  let titleRange = Range(match.range(at: 1), in: value),
                  let timeRange = Range(match.range(at: 2), in: value) else { continue }
            let detail = Range(match.range(at: 3), in: value)
                .map { String(value[$0]).trimmingCharacters(in: CharacterSet(charactersIn: " .")) } ?? ""
            return .init(
                time: String(value[timeRange])
                    .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                    .uppercased(),
                title: String(value[titleRange]).trimmingCharacters(in: .whitespacesAndNewlines),
                detail: detail
            )
        }
        return nil
    }

    private static func isWeatherCardDetail(_ label: String) -> Bool {
        let normalized = label
            .lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized != "source",
              !normalized.contains("current weather"),
              !normalized.hasPrefix("here's the weather") else { return false }
        // A metric names itself in a word or three — "Wind", "Rain chance",
        // "Dew point". A sentence cut at its first colon does not: "For your
        // 11:00 Zoom meeting: ideal indoor conditions" would otherwise become a
        // row labelled "For your 11", which is prose broken in half rather than
        // a fact. That sentence belongs to the reply, and stays there.
        let words = normalized.split(separator: " ")
        return (1...3).contains(words.count)
            && normalized.rangeOfCharacter(from: .decimalDigits) == nil
            && !prosaicDetailOpeners.contains(String(words[0]))
    }

    /// A row that opens like a sentence is a sentence. These are the words an
    /// aside starts with, never the first word of a weather metric.
    private static let prosaicDetailOpeners: Set<String> = [
        "a", "also", "and", "as", "at", "because", "but", "by", "for", "given", "heads",
        "if", "in", "note", "on", "one", "overall", "plus", "recommendation", "reminder",
        "since", "so", "the", "tip", "to", "want", "what", "when", "with", "you", "your",
    ]

    /// New cards carry an explicit list of weather metrics. Older server
    /// cards remain useful by promoting their range and one legacy detail.
    private static func weatherDetails(from data: [String: JSONValue]) -> [WeatherDetail] {
        if case let .array(values)? = data["details"] {
            let details = values.compactMap { value -> WeatherDetail? in
                guard case let .object(detail) = value,
                      let label = detail["label"]?.string,
                      let value = detail["value"]?.string,
                      !label.isEmpty, !value.isEmpty,
                      isWeatherCardDetail(label) else { return nil }
                return .init(label: label, value: value, symbol: detail["symbol"]?.string ?? "")
            }
            if !details.isEmpty { return details }
        }

        var details: [WeatherDetail] = []
        if let low = data["low"]?.string, let high = data["high"]?.string {
            details.append(.init(label: "Today", value: "\(low)–\(high)"))
        }
        if let detail = data["detail"]?.string, !detail.isEmpty {
            details.append(.init(label: "Details", value: detail))
        }
        return details
    }

    private static func details(from data: [String: JSONValue]) -> [Detail] {
        guard case let .array(values)? = data["details"] else { return [] }
        return values.compactMap { value in
            guard case let .object(detail) = value,
                  let label = detail["label"]?.string,
                  let value = detail["value"]?.string,
                  !label.isEmpty, !value.isEmpty else { return nil }
            return .init(label: label, value: value)
        }
    }
}

/// The device locale picks the one temperature unit the card shows — "17°C
/// (63°F)" side by side reads as clutter, not thoroughness. Sources send
/// Celsius-first strings, so every rendered temperature passes through here.
enum WeatherUnits {
    static var prefersFahrenheit: Bool {
        // The US measurement system is the one that defaults to °F; .uk and
        // .metric both read weather in Celsius.
        Locale.current.measurementSystem == .us
    }

    static func fahrenheit(fromCelsius value: Int) -> Int {
        Int((Double(value) * 9 / 5 + 32).rounded())
    }

    static func celsius(fromFahrenheit value: Int) -> Int {
        Int(((Double(value) - 32) * 5 / 9).rounded())
    }

    /// Rewrites every temperature in the text to the preferred unit: paired
    /// readings ("17°C (63°F)") collapse to the preferred side, and bare
    /// readings ("17–20°C", "17°C") convert when they aren't already in it.
    static func localized(_ text: String, preferFahrenheit: Bool) -> String {
        var result = collapsePairs(in: text, celsiusFirst: true, preferFahrenheit: preferFahrenheit)
        result = collapsePairs(in: result, celsiusFirst: false, preferFahrenheit: preferFahrenheit)
        result = convertRanges(in: result, preferFahrenheit: preferFahrenheit)
        return convertSingles(in: result, preferFahrenheit: preferFahrenheit)
    }

    private static let celsiusToken = #"(-?\d{1,3}(?:\s*[–-]\s*-?\d{1,3})?)\s*[°º]\s*C"#
    private static let fahrenheitToken = #"(-?\d{1,3}(?:\s*[–-]\s*-?\d{1,3})?)\s*[°º]\s*F"#

    private static func collapsePairs(in text: String, celsiusFirst: Bool, preferFahrenheit: Bool) -> String {
        let first = celsiusFirst ? celsiusToken : fahrenheitToken
        let second = celsiusFirst ? fahrenheitToken : celsiusToken
        return rewrite(text, pattern: first + #"\s*\("# + second + #"\)"#) { match, source in
            guard let firstRange = Range(match.range(at: 1), in: source),
                  let secondRange = Range(match.range(at: 2), in: source) else { return nil }
            let celsius = celsiusFirst ? source[firstRange] : source[secondRange]
            let fahrenheit = celsiusFirst ? source[secondRange] : source[firstRange]
            let picked = preferFahrenheit ? fahrenheit : celsius
            return "\(picked.replacingOccurrences(of: " ", with: ""))°\(preferFahrenheit ? "F" : "C")"
        }
    }

    private static func convertRanges(in text: String, preferFahrenheit: Bool) -> String {
        rewrite(text, pattern: #"(-?\d{1,3})\s*[–-]\s*(-?\d{1,3})\s*[°º]\s*([CF])\b"#) { match, source in
            guard let lowRange = Range(match.range(at: 1), in: source),
                  let highRange = Range(match.range(at: 2), in: source),
                  let unitRange = Range(match.range(at: 3), in: source),
                  let low = Int(source[lowRange]),
                  let high = Int(source[highRange]) else { return nil }
            let convertedLow = converted(low, unit: String(source[unitRange]), preferFahrenheit: preferFahrenheit)
            let convertedHigh = converted(high, unit: String(source[unitRange]), preferFahrenheit: preferFahrenheit)
            return "\(convertedLow.value)–\(convertedHigh.value)°\(convertedLow.unit)"
        }
    }

    private static func convertSingles(in text: String, preferFahrenheit: Bool) -> String {
        rewrite(text, pattern: #"(-?\d{1,3})\s*[°º]\s*([CF])\b"#) { match, source in
            guard let valueRange = Range(match.range(at: 1), in: source),
                  let unitRange = Range(match.range(at: 2), in: source),
                  let value = Int(source[valueRange]) else { return nil }
            let result = converted(value, unit: String(source[unitRange]), preferFahrenheit: preferFahrenheit)
            return "\(result.value)°\(result.unit)"
        }
    }

    private static func converted(_ value: Int, unit: String, preferFahrenheit: Bool) -> (value: Int, unit: String) {
        let normalized = unit.uppercased()
        if preferFahrenheit, normalized == "C" { return (fahrenheit(fromCelsius: value), "F") }
        if !preferFahrenheit, normalized == "F" { return (celsius(fromFahrenheit: value), "C") }
        return (value, normalized)
    }

    /// Replacements run against matches in reverse order so earlier ranges
    /// stay valid while later text shifts underneath them.
    private static func rewrite(
        _ text: String,
        pattern: String,
        transform: (NSTextCheckingResult, String) -> String?
    ) -> String {
        guard let expression = NSRegularExpression.cached(pattern, options: [.caseInsensitive]) else { return text }
        var result = text
        let matches = expression.matches(in: result, range: NSRange(result.startIndex..., in: result))
        for match in matches.reversed() {
            guard let full = Range(match.range, in: result),
                  let replacement = transform(match, result) else { continue }
            result.replaceSubrange(full, with: replacement)
        }
        return result
    }
}

/// Splits flat weather facts into current conditions and a per-day forecast:
/// labels that start with a day name ("Saturday", "Sat", "Tomorrow") leave
/// the metric list and group under their day instead.
enum WeatherPresentation {
    struct DayFacts {
        let day: String
        let facts: [MessageResponseCard.WeatherDetail]
    }

    private static let dayExpression = try? NSRegularExpression(
        pattern: #"^(saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow|sat|sun|mon|tue|wed|thu|fri)\b[:\s–-]*(.*)$"#,
        options: [.caseInsensitive]
    )

    static func split(
        _ details: [MessageResponseCard.WeatherDetail]
    ) -> (current: [MessageResponseCard.WeatherDetail], days: [DayFacts]) {
        guard let expression = dayExpression else { return (details, []) }
        var current: [MessageResponseCard.WeatherDetail] = []
        var order: [String] = []
        var byDay: [String: [MessageResponseCard.WeatherDetail]] = [:]
        for detail in details {
            let range = NSRange(detail.label.startIndex..., in: detail.label)
            guard let match = expression.firstMatch(in: detail.label, range: range),
                  let dayRange = Range(match.range(at: 1), in: detail.label) else {
                current.append(detail)
                continue
            }
            let day = String(detail.label[dayRange]).capitalized
            let rest = Range(match.range(at: 2), in: detail.label)
                .map { String(detail.label[$0]).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
            if byDay[day] == nil { order.append(day) }
            byDay[day, default: []].append(.init(
                label: rest.isEmpty ? "Forecast" : rest.capitalized,
                value: detail.value,
                symbol: detail.symbol
            ))
        }
        return (current, order.map { DayFacts(day: $0, facts: byDay[$0] ?? []) })
    }

    /// One compact current-conditions reading for the metrics row.
    struct Metric {
        let label: String
        let value: String
        let symbol: String
    }

    /// Wind, humidity, and rain chance from the numeric reading; a dated card
    /// without one shows its remaining text facts ("Rain chance 1%") instead.
    static func metrics(
        _ current: MessageResponseCard.WeatherForecast.Current?,
        fallback: [MessageResponseCard.WeatherDetail]
    ) -> [Metric] {
        if let current {
            return [
                current.windKmh.map { Metric(label: "Wind", value: "\(Int($0.rounded())) km/h", symbol: "wind") },
                current.humidity.map { Metric(label: "Humidity", value: "\(Int($0.rounded()))%", symbol: "humidity") },
                current.precipPct.map { Metric(label: "Rain chance", value: "\(Int($0.rounded()))%", symbol: "umbrella") },
            ].compactMap { $0 }
        }
        return fallback
            .filter { $0.label.caseInsensitiveCompare("Today") != .orderedSame }
            .map { detail in
                let lower = detail.label.lowercased()
                let symbol = lower.contains("rain") ? "umbrella" : lower.contains("wind") ? "wind"
                    : lower.contains("humid") ? "humidity" : "thermometer.medium"
                return Metric(label: detail.label, value: detail.value, symbol: symbol)
            }
    }

    /// The named parts of a day ("Thu Morning") among the day groups. Plain
    /// per-day rows are drawn from the numeric days instead, so they drop out.
    static func windowGroups(_ groups: [DayFacts]) -> [DayFacts] {
        groups.compactMap { group in
            let facts = group.facts.filter { $0.label != "Forecast" }
            return facts.isEmpty ? nil : DayFacts(day: group.day, facts: facts)
        }
    }

    /// The card's top-right stamp: a per-day forecast card names its day
    /// ("Saturday"), a current card shows its freshness time, and anything
    /// else falls back to the plain Today/Forecast label.
    static func caption(
        details: [MessageResponseCard.WeatherDetail],
        hasForecast: Bool
    ) -> String {
        if let day = details.first(where: { $0.label.caseInsensitiveCompare("Day") == .orderedSame })?.value,
           !day.isEmpty {
            return day
        }
        guard let updated = details.first(where: { $0.label.caseInsensitiveCompare("Updated") == .orderedSame })?.value,
              !updated.isEmpty else {
            return hasForecast ? "Forecast" : "Today"
        }
        return "Today · \(updated)"
    }
}

/// Persisted labels may have been formatted in the server's timezone. Native
/// schedules use device-local instants, while date-only events keep their day.
enum CalendarEventPresentation {
    static func timestamp(_ value: String) -> Date? {
        ISO8601DateFormatter.assistant.date(from: value)
            ?? AssistantFormatters.internetDateTime.date(from: value)
    }

    static func timeLabel(start: String, end: String?, fallback: String,
                          timeZone: TimeZone = .current, locale: Locale = .autoupdatingCurrent) -> String {
        if start.count == 10, AssistantFormatters.calendarDay.date(from: start) != nil { return "All day" }
        guard let date = timestamp(start) else { return fallback }
        let style = Date.FormatStyle(locale: locale, timeZone: timeZone).hour().minute()
        let first = date.formatted(style)
        guard let end, let last = timestamp(end), last > date else { return first }
        return "\(first)–\(last.formatted(style))"
    }

    static func dateCaption(_ start: String, timeZone: TimeZone = .current,
                            locale: Locale = .autoupdatingCurrent) -> String? {
        var zone = timeZone
        let date: Date?
        if start.count == 10 {
            // Noon UTC makes a date-only value a calendar day, never an instant
            // to shift into the previous day in the Americas.
            date = timestamp("\(start)T12:00:00Z")
            zone = TimeZone(secondsFromGMT: 0)!
        } else {
            date = timestamp(start)
        }
        return date?.formatted(Date.FormatStyle(locale: locale, timeZone: zone)
            .weekday(.abbreviated).month(.abbreviated).day().year())
    }
}

enum CardFreshnessPresentation {
    static func label(stale: Bool?, state: String?, hasTimestamp: Bool) -> String {
        if state == "refreshing" { return "Refreshing…" }
        if state == "failed" { return "Refresh failed" }
        if stale == true { return "May be out of date" }
        if stale == false && hasTimestamp { return "Current" }
        return "Saved snapshot"
    }
}

struct GeneratedCardFreshness: View {
    let card: MessageResponseCard.GeneratedCard
    let refresh: ((String, String?) async -> String?)?
    @State private var requesting = false
    @State private var failure: String?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var refreshing: Bool { requesting || card.refreshState == "refreshing" }

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 8))
        VStack(alignment: .leading, spacing: 7) {
            layout {
                HStack(alignment: .center, spacing: 8) {
                    if refreshing { ProgressView().controlSize(.small) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(requesting ? "Starting refresh…" : CardFreshnessPresentation.label(
                            stale: card.stale, state: card.refreshState,
                            hasTimestamp: card.updatedAt.flatMap(CalendarEventPresentation.timestamp) != nil))
                            .font(.caption.weight(.semibold))
                        if let stamp = card.updatedAt, let date = CalendarEventPresentation.timestamp(stamp) {
                            Text("Checked \(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")
                                .font(.caption2)
                        }
                    }
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                }
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                if let refresh, card.refreshable {
                    Button {
                        guard !refreshing else { return }
                        requesting = true
                        failure = nil
                        Task {
                            failure = await refresh(card.id, card.revisionId)
                            requesting = false
                        }
                    } label: {
                        Text(card.refreshState == "failed" || failure != nil ? "Try again" : "Refresh")
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .neutral, compact: true))
                    .disabled(refreshing)
                    .accessibilityIdentifier("assistant.card.\(card.id).refresh")
                    .accessibilityHint("Checks the source again and updates this card in place.")
                }
            }
            if let error = failure ?? card.refreshError, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

struct RichResponseCards: View {
    @State private var copiedAction: String?
    private struct EventRow: Identifiable {
        let id: String
        let start: String
        let time: String
        let title: String
        let location: String
        let attendees: [String]
        let calendar: String
        let calendarLinkURL: String?
        let meetingLinkURL: String?
    }

    private enum DisplayItem: Identifiable {
        case day(EventDayGroup)
        case card(MessageResponseCard)

        var id: String {
            switch self {
            case let .day(group): "day-\(group.id)"
            case let .card(card): "card-\(card.id)"
            }
        }
    }

    private struct EventAttendee: Identifiable {
        let name: String
        let status: String?

        var id: String { "\(name)-\(status ?? "")" }
    }

    let cards: [MessageResponseCard]
    let onSend: ((String) -> Void)?
    let onRefresh: ((String, String?) async -> String?)?
    let cardFormActions: NativeCardFormActions?
    let cardFormTaskRevision: Int

    init(cards: [MessageResponseCard], onSend: ((String) -> Void)? = nil,
         onRefresh: ((String, String?) async -> String?)? = nil,
         cardFormActions: NativeCardFormActions? = nil,
         cardFormTaskRevision: Int = 0) {
        self.cards = cards
        self.onSend = onSend
        self.onRefresh = onRefresh
        self.cardFormActions = cardFormActions
        self.cardFormTaskRevision = cardFormTaskRevision
    }

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    /// Calendar responses arrive as individual, durable data cards. Present
    /// consecutive events as one paper schedule so a weekly answer scans like
    /// an itinerary instead of a column of unrelated tiles.
    private var eventRows: [EventRow] {
        cards.compactMap { card in
            guard case let .event(id, start, time, title, location, attendees, calendars, calendarLinkURL, meetingLinkURL) = card else {
                return nil
            }
            return .init(
                id: id,
                start: start,
                time: time,
                title: title,
                location: locationWithoutInlineURLs(location),
                attendees: attendees,
                calendar: calendars.first ?? "",
                calendarLinkURL: calendarLinkURL,
                meetingLinkURL: meetingLinkURL ?? meetingURL(in: location)
            )
        }
    }

    private var nonEventCards: [MessageResponseCard] {
        cards.filter { card in
            if case .event = card { return false }
            return true
        }
    }

    private var displayItems: [DisplayItem] {
        eventDayGroups.map(DisplayItem.day) + nonEventCards.map(DisplayItem.card)
    }

    var body: some View {
        let preview = Array(displayItems.prefix(3))
        let overflow = Array(displayItems.dropFirst(3))
        VStack(alignment: .leading, spacing: 10) {
            ForEach(preview) { item in
                displayItem(item)
            }
            if !overflow.isEmpty {
                CardDisclosure(collapsedLabel: "Show \(overflow.count) more \(overflow.count == 1 ? "result" : "results")",
                    expandedLabel: "Showing all \(displayItems.count) results", standalone: true, showsBottomCollapse: true) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(overflow) { item in
                            displayItem(item)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func displayItem(_ item: DisplayItem) -> some View {
        switch item {
        case let .day(group):
            eventDayCard(group)
        case let .card(card):
            switch card {
            case let .agenda(title, subtitle, items):
                agendaCard(title: title, subtitle: subtitle, items: items)
            case .event:
                EmptyView()
            case let .weather(location, temperature, condition, details, symbol, forecast):
                weatherCard(location: location, temperature: temperature, condition: condition, details: details, symbol: symbol, forecast: forecast)
            case let .duration(title, duration, detail, confidence):
                durationCard(title: title, duration: duration, detail: detail, confidence: confidence)
            case let .reminder(_, title, schedule, nextFires, enabled):
                reminderCard(title: title, schedule: schedule, nextFires: nextFires, enabled: enabled)
            case let .emails(_, title, query, mailbox, complete, estimate, messages):
                emailResultsCard(title: title, query: query, mailbox: mailbox, complete: complete, estimate: estimate, messages: messages)
            case let .documents(_, title, query, passages):
                documentResultsCard(title: title, query: query, passages: passages)
            case let .drive(_, title, query, files):
                driveResultsCard(title: title, query: query, files: files)
            case let .search(_, title, query, results):
                searchResultsCard(title: title, query: query, results: results)
            case let .availability(_, timeMin, timeMax, busy, calendarsChecked, complete, note):
                availabilityCard(timeMin: timeMin, timeMax: timeMax, busy: busy, calendarsChecked: calendarsChecked, complete: complete, note: note)
            case let .thread(_, subject, messageCount, messages):
                threadCard(subject: subject, messageCount: messageCount, messages: messages)
            case let .sheetRows(_, sheetName, rows, totalRows, linkURL):
                sheetRowsCard(sheetName: sheetName, rows: rows, totalRows: totalRows, linkURL: linkURL)
            case let .resource(_, resourceType, title, subtitle, details, linkLabel, linkURL):
                resourceCard(resourceType: resourceType, title: title, subtitle: subtitle, details: details, linkLabel: linkLabel, linkURL: linkURL)
            case let .status(_, title, detail, symbol, details, linkLabel, linkURL):
                statusCard(title: title, detail: detail, symbol: symbol, details: details, linkLabel: linkLabel, linkURL: linkURL)
            case let .knowledgeGraph(_, title, edges, complete):
                knowledgeGraphCard(title: title, edges: edges, complete: complete)
            case let .calendarConflicts(_, title, conflicts, complete):
                calendarConflictsCard(title: title, conflicts: conflicts, complete: complete)
            case let .proactiveAlert(_, category, urgency, title, summary, startsAt, dueAt, details):
                proactiveAlertCard(
                    category: category,
                    urgency: urgency,
                    title: title,
                    summary: summary,
                    startsAt: startsAt,
                    dueAt: dueAt,
                    details: details
                )
            case let .generated(card):
                generatedCard(card)
            case let .briefing(card):
                BriefingCardView(card: card)
                    .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 22)
            case let .scoreboard(_, title, games, fetchedAt, pollSeconds, live):
                ScoreboardCardView(title: title, initialGames: games, fetchedAt: fetchedAt,
                                   pollSeconds: pollSeconds, live: live)
                    .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
            case let .route(route):
                RouteCardView(route: route)
                    .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 16)
            }
        }
    }

    private struct EventDayGroup: Identifiable {
        let date: String
        let events: [EventRow]

        var id: String { date.isEmpty ? "undated" : date }
    }

    /// Multi-day answers read as one card per day rather than a single long
    /// itinerary: the day owns the card header and only its events live inside.
    private var eventDayGroups: [EventDayGroup] {
        var order: [String] = []
        var byDate: [String: [EventRow]] = [:]
        for row in eventRows {
            let key = eventDateCaption(row.start) ?? ""
            if byDate[key] == nil { order.append(key) }
            byDate[key, default: []].append(row)
        }
        return order.map { EventDayGroup(date: $0, events: byDate[$0] ?? []) }
    }

    private func eventDayCard(_ group: EventDayGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !group.date.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(group.date)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    Spacer(minLength: 8)
                    if group.events.count > 1 {
                        Text("\(group.events.count) events")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                }
            }
            ForEach(group.events) { event in
                eventRow(event)
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 16)
    }

    private func eventRow(_ event: EventRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(event.time)
                    .font(.caption.monospacedDigit().weight(.medium))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                if let imminence = eventImminence(event) {
                    Text(imminence)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: Capsule())
                        .accessibilityLabel(imminence == "Now" ? "Happening now" : "Starts \(imminence.lowercased())")
                }
                Spacer(minLength: 4)
                if let meetingLinkURL = event.meetingLinkURL, let url = URL(string: meetingLinkURL) {
                    Link(destination: url) {
                        Label("Join", systemImage: "video.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    }
                    .accessibilityLabel("Join video meeting for \(event.title)")
                }
            }
            Text(AssistantMarkdown.inlineAttributed(event.title))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)

            calendarEventLabel(event)

            if !event.location.isEmpty {
                Text(AssistantMarkdown.inlineAttributed(event.location))
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            let attendees = event.attendees.map(eventAttendee)
            if !attendees.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(attendees) { attendee in
                        HStack(spacing: 6) {
                            if let status = attendee.status {
                                let presentation = attendeeStatusPresentation(status)
                                Image(systemName: presentation.symbol)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                    .accessibilityLabel(presentation.label)
                            }
                            Text(attendee.name)
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }
            }
        }
    }

    /// The one thing on a schedule that changes what you do next: what is
    /// happening right now or starts within the hour.
    private func eventImminence(_ event: EventRow) -> String? {
        guard let start = cardTimestamp(event.start) else { return nil }
        let minutes = Int((start.timeIntervalSinceNow / 60).rounded(.down))
        if minutes > 0, minutes <= 60 { return "In \(minutes) min" }
        if minutes <= 0, minutes >= -15 { return "Now" }
        return nil
    }

    /// The owning calendar is useful context, not a headline — a quiet caption
    /// beside the time keeps the event itself in focus.
    @ViewBuilder
    private func calendarEventLabel(_ event: EventRow) -> some View {
        let label = event.calendar.isEmpty ? "Calendar" : event.calendar
        let content = Label(label, systemImage: "calendar")
            .font(.caption)
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            .lineLimit(1)
        if let calendarLinkURL = event.calendarLinkURL, let url = URL(string: calendarLinkURL) {
            Link(destination: url) { content }
                .accessibilityLabel("Open \(event.title) in calendar")
        } else if !event.calendar.isEmpty {
            content
        } else {
            EmptyView()
        }
    }

    private func eventDateCaption(_ start: String) -> String? {
        CalendarEventPresentation.dateCaption(start)
    }

    private func eventAttendee(_ value: String) -> EventAttendee {
        guard let range = value.range(of: #"\s*\([^()]+\)\s*$"#, options: .regularExpression) else {
            return .init(name: value, status: nil)
        }
        let suffix = String(value[range])
        let status = suffix
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "()"))
        let name = String(value[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return .init(name: name.isEmpty ? value : name, status: status.isEmpty ? nil : status)
    }

    /// RSVP status is a small grayscale glyph next to the name; the spoken
    /// label keeps VoiceOver users on the same footing without a loud pill.
    private func attendeeStatusPresentation(_ status: String) -> (label: String, symbol: String) {
        switch status.lowercased().replacingOccurrences(of: " ", with: "") {
        case "accepted":
            ("Accepted", "checkmark.circle.fill")
        case "needsaction", "pending":
            ("Needs action", "clock.fill")
        case "denied":
            ("Denied", "xmark.circle.fill")
        case "declined":
            ("Declined", "xmark.circle.fill")
        case "tentative":
            ("Tentative", "questionmark.circle.fill")
        default:
            (status, "circle.fill")
        }
    }

    private func meetingURL(in location: String) -> String? {
        inlineURLs(in: location).first(where: isMeetingURL)
    }

    private func locationWithoutInlineURLs(_ location: String) -> String {
        let withoutURLs = inlineURLs(in: location).reduce(location) { result, url in
            result.replacingOccurrences(of: url, with: "")
        }
        return withoutURLs
            .replacingOccurrences(of: " · ", with: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: " ·,\n"))
    }

    private func inlineURLs(in value: String) -> [String] {
        let pattern = #"https?://[^\s<>\"']+"#
        guard let expression = NSRegularExpression.cached(pattern, options: [.caseInsensitive]) else {
            return []
        }
        let range = NSRange(value.startIndex..., in: value)
        return expression.matches(in: value, range: range).compactMap { match in
            Range(match.range, in: value).map { String(value[$0]) }
        }
    }

    private func isMeetingURL(_ value: String) -> Bool {
        guard let host = URL(string: value)?.host?.lowercased() else { return false }
        return ["zoom.us", "meet.google.com", "teams.microsoft.com", "webex.com"].contains { domain in
            host == domain || host.hasSuffix(".\(domain)")
        }
    }

    private func agendaCard(title: String, subtitle: String, items: [MessageResponseCard.AgendaItem]) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(AssistantMarkdown.inlineAttributed(title))
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    Text(AssistantMarkdown.inlineAttributed(subtitle))
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                Spacer()
                Text("\(items.count) \(items.count == 1 ? "event" : "events")")
                    .font(.caption.monospacedDigit().weight(.medium))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }

            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    HStack(alignment: .top, spacing: 12) {
                        Text(item.time)
                            .font(.subheadline.monospacedDigit().weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: usesAccessibilityLayout ? 90 : 80, alignment: .leading)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(AssistantMarkdown.inlineAttributed(item.title))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                            if !item.detail.isEmpty {
                                Text(AssistantMarkdown.inlineAttributed(item.detail))
                                    .font(.subheadline)
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.bottom, index < items.count - 1 ? 18 : 0)
                }
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 24)
    }

    private func weatherCard(
        location: String,
        temperature: String,
        condition: String,
        details: [MessageResponseCard.WeatherDetail],
        symbol: String = "",
        forecast: MessageResponseCard.WeatherForecast = .init()
    ) -> some View {
        let preferFahrenheit = WeatherUnits.prefersFahrenheit
        let reading = weatherTemperatureReading(temperature, preferFahrenheit: preferFahrenheit)
        let split = WeatherPresentation.split(weatherFacts(details, preferFahrenheit: preferFahrenheit))
        // A payload with numeric days draws them as rows; its text details
        // then only add what the rows cannot say — named parts of a day.
        let dayRows = forecast.days
        let windows = dayRows.isEmpty ? split.days : WeatherPresentation.windowGroups(split.days)
        let hasForecast = !split.days.isEmpty || !dayRows.isEmpty
        let metrics = dayRows.isEmpty ? [] : WeatherPresentation.metrics(forecast.current, fallback: split.current)

        return VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(AssistantMarkdown.inlineAttributed(location))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                Spacer(minLength: 8)
                Text(WeatherPresentation.caption(details: details, hasForecast: hasForecast))
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(1)
            }

            weatherHeadline(reading: reading, condition: condition, symbol: symbol)

            if !metrics.isEmpty {
                weatherMetricsRow(metrics)
            } else if dayRows.isEmpty, !split.current.isEmpty {
                Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(split.current.enumerated()), id: \.offset) { _, fact in
                        weatherFactRow(fact)
                    }
                }
            }

            if !windows.isEmpty {
                Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(windows, id: \.day) { group in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(group.day)
                                .font(.caption.weight(.bold))
                                .tracking(0.5)
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            ForEach(Array(group.facts.enumerated()), id: \.offset) { _, fact in
                                weatherFactRow(fact)
                            }
                        }
                    }
                }
            }

            if !dayRows.isEmpty {
                Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                weatherDayList(dayRows, preferFahrenheit: preferFahrenheit)
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 22)
    }

    /// The big reading beside its condition and sky. The condition keeps one
    /// line — scaling down before it wraps — and at accessibility sizes moves
    /// under the reading instead of squeezing beside it.
    @ViewBuilder
    private func weatherHeadline(reading: (value: String, unit: String), condition: String, symbol: String) -> some View {
        let temperature = HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(reading.value)
                .font(.system(size: 52, weight: .regular, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            if !reading.unit.isEmpty {
                Text(reading.unit)
                    .font(.title2.weight(.medium))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
        }
        .fixedSize(horizontal: true, vertical: false)
        let conditionText = Text(AssistantMarkdown.inlineAttributed(condition))
            .font(.title3.weight(.semibold))
            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
        let icon = Image(systemName: weatherSymbol(condition, symbol: symbol))
            .font(.system(size: 27, weight: .medium))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            .frame(width: 54, height: 54)
            .background(AssistantTheme.sunken(for: colorScheme), in: Circle())

        let stacked = VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 14) {
                temperature
                Spacer(minLength: 0)
                icon
            }
            conditionText.fixedSize(horizontal: false, vertical: true)
        }
        if usesAccessibilityLayout {
            stacked
        } else {
            // Beside the reading only while it fits on one line; otherwise it
            // moves underneath whole rather than wrapping or truncating.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 14) {
                    temperature
                    conditionText.lineLimit(1).fixedSize()
                    Spacer(minLength: 0)
                    icon
                }
                stacked
            }
        }
    }

    /// Wind, humidity, and rain as one quiet row; it falls back to a stacked
    /// list only when the row cannot fit, never to a wrapped half-row.
    private func weatherMetricsRow(_ metrics: [WeatherPresentation.Metric]) -> some View {
        let chip = { (metric: WeatherPresentation.Metric) in
            HStack(spacing: 5) {
                Image(systemName: metric.symbol)
                    .font(.caption)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    .accessibilityHidden(true)
                Text(metric.value)
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            }
            .lineLimit(1)
            .fixedSize()
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(metric.label) \(metric.value)")
        }
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                ForEach(metrics, id: \.label) { chip($0) }
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(metrics, id: \.label) { chip($0) }
            }
        }
    }

    /// Apple-Weather-style day rows: weekday, sky, rain chance, and the day's
    /// low–high placed on a bar spanning the whole list's range. Every column
    /// is fixed-width and single-line, so no row can wrap on a narrow phone.
    private func weatherDayList(_ days: [MessageResponseCard.WeatherForecast.Day], preferFahrenheit: Bool) -> some View {
        let convert = { (celsius: Double) -> Int in
            let rounded = Int(celsius.rounded())
            return preferFahrenheit ? WeatherUnits.fahrenheit(fromCelsius: rounded) : rounded
        }
        let floor = Double(days.map { convert($0.lowC) }.min() ?? 0)
        let ceiling = Double(days.map { convert($0.highC) }.max() ?? 0)
        return VStack(alignment: .leading, spacing: usesAccessibilityLayout ? 12 : 9) {
            ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                let low = convert(day.lowC)
                let high = convert(day.highC)
                let rain = day.precipPct.flatMap { $0 >= 30 ? "\(Int($0.rounded()))%" : nil }
                if usesAccessibilityLayout {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text(day.weekday).font(.subheadline.weight(.semibold))
                            Image(systemName: weatherSymbol(day.description, symbol: day.symbol))
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        }
                        Text([ "\(low)°–\(high)°", rain.map { "\($0) rain" } ].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                } else {
                    HStack(spacing: 10) {
                        Text(day.weekday)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                            .frame(width: 50, alignment: .leading)
                        Image(systemName: weatherSymbol(day.description, symbol: day.symbol))
                            .font(.subheadline)
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: 24)
                            .accessibilityHidden(true)
                        Text(rain ?? "")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: 36, alignment: .leading)
                        Text("\(low)°")
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .frame(width: 34, alignment: .trailing)
                        WeatherRangeBar(low: Double(low), high: Double(high), floor: floor, ceiling: ceiling,
                                        track: AssistantTheme.sunken(for: colorScheme),
                                        fill: AssistantTheme.accent(for: colorScheme))
                            .frame(height: 5)
                        Text("\(high)°")
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                            .frame(width: 34, alignment: .leading)
                    }
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(day.weekday), \(day.description), low \(low), high \(high)\(rain.map { ", \($0) chance of rain" } ?? "")")
                }
            }
        }
    }

    /// The big reading and its unit sit on one baseline — "63°F", never a
    /// number on one line and a lone "F" stranded underneath it.
    private func weatherTemperatureReading(_ temperature: String, preferFahrenheit: Bool) -> (value: String, unit: String) {
        let localized = WeatherUnits.localized(temperature, preferFahrenheit: preferFahrenheit)
        let pattern = #"(-?\d{1,3})\s*[°º]\s*([CF])"#
        guard let expression = NSRegularExpression.cached(pattern, options: [.caseInsensitive]),
              let match = expression.firstMatch(in: localized, range: NSRange(localized.startIndex..., in: localized)),
              let valueRange = Range(match.range(at: 1), in: localized),
              let unitRange = Range(match.range(at: 2), in: localized) else {
            return (localized.trimmingCharacters(in: .whitespacesAndNewlines), "")
        }
        return (String(localized[valueRange]), "°\(localized[unitRange].uppercased())")
    }

    /// One fact per row keeps longer forecasts (weekend mornings/afternoons)
    /// scannable instead of joining everything into a single run of text.
    private func weatherFacts(_ details: [MessageResponseCard.WeatherDetail], preferFahrenheit: Bool) -> [MessageResponseCard.WeatherDetail] {
        details.compactMap { detail in
            let label = detail.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let value = WeatherUnits.localized(
                weatherFirstPhrase(detail.value.replacingOccurrences(of: "**", with: "")),
                preferFahrenheit: preferFahrenheit
            )
            let normalized = label.lowercased()
            guard !label.isEmpty, !value.isEmpty, normalized != "updated", normalized != "source", normalized != "day" else {
                return nil
            }
            return MessageResponseCard.WeatherDetail(label: label, value: value, symbol: detail.symbol)
        }
    }

    private func weatherFactRow(_ fact: MessageResponseCard.WeatherDetail) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(fact.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .frame(width: usesAccessibilityLayout ? 104 : 88, alignment: .leading)
            if let symbol = weatherFactSymbol(fact) {
                Image(systemName: symbol)
                    .font(.caption)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    .accessibilityHidden(true)
            }
            Text(AssistantMarkdown.inlineAttributed(fact.value))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The value up to its first sentence end. A period followed by a space
    /// ends a phrase; one inside a number ("3.5 mm") does not.
    private func weatherFirstPhrase(_ value: String) -> String {
        let phrase = value.range(of: #"\.(\s|$)"#, options: .regularExpression)
            .map { String(value[..<$0.lowerBound]) } ?? value
        return phrase.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func durationCard(title: String, duration: String, detail: String?, confidence: String?) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: "timer")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 44, height: 44)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(duration)
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if let confidence, !confidence.isEmpty {
                Text(confidence)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    private func interviewBullet(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Circle()
                .fill(AssistantTheme.accent(for: colorScheme))
                .frame(width: 4, height: 4)
                .accessibilityHidden(true)
            Text(AssistantMarkdown.inlineAttributed(text))
                .font(.caption)
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .multilineTextAlignment(.leading)
        }
    }

    private func reminderCard(title: String, schedule: String, nextFires: String, enabled: Bool) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: enabled ? "bell.badge.fill" : "bell.slash.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 42, height: 42)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(enabled ? "Reminder" : "Reminder paused")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(AssistantMarkdown.inlineAttributed(title))
                    .font(.headline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                if !nextFires.isEmpty {
                    Label(cardDate(nextFires), systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                // Legacy one-time cards used the ISO next-run instant as their
                // schedule line. Keep transport timestamps out of the UI;
                // `nextFires` is already localized above.
                if !schedule.isEmpty && cardTimestamp(schedule) == nil {
                    Text(schedule)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            }
            Spacer(minLength: 0)
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    @ViewBuilder
    private func compactResultRows<Item: Identifiable, Row: View>(
        _ items: [Item],
        @ViewBuilder row: @escaping (Item) -> Row
    ) -> some View {
        let preview = Array(items.prefix(3))
        let overflow = Array(items.dropFirst(3))
        VStack(alignment: .leading, spacing: 10) {
            resultRows(preview, row: row)
            if !overflow.isEmpty {
                CardDisclosure(collapsedLabel: "Show \(overflow.count) more",
                    expandedLabel: "Showing all \(items.count)", showsBottomCollapse: true) {
                    Divider()
                    resultRows(overflow, row: row)
                }
            }
        }
    }

    @ViewBuilder
    private func resultRows<Item: Identifiable, Row: View>(
        _ items: [Item],
        @ViewBuilder row: @escaping (Item) -> Row
    ) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Divider().padding(.vertical, 12)
                }
                row(item)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func emailResultsCard(
        title: String,
        query: String,
        mailbox: String,
        complete: Bool,
        estimate: Int?,
        messages: [MessageResponseCard.EmailResult]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(
                title: title,
                subtitle: query.isEmpty ? mailbox : query,
                countLabel: emailCountLabel(messages: messages, estimate: estimate, complete: complete),
                subtitleStyle: .query
            )
            if messages.isEmpty {
                Text("No matching messages.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                compactResultRows(messages) { message in
                    if let url = CardText.gmailURL(id: message.id, mailbox: mailbox) {
                        Link(destination: url) { emailRow(message) }
                            .accessibilityHint("Opens in Gmail")
                    } else {
                        emailRow(message)
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func documentResultsCard(
        title: String,
        query: String,
        passages: [MessageResponseCard.DocumentPassage]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(title: title, subtitle: query, countLabel: "\(passages.count) \(passages.count == 1 ? "match" : "matches")")
            if passages.isEmpty {
                Text("No matching passages.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                compactResultRows(passages) { passage in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(AssistantMarkdown.inlineAttributed(passage.document))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 6)
                            if let similarity = passage.similarity {
                                Text("\(Int((similarity * 100).rounded()))% match")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            }
                        }
                        if !passage.source.isEmpty {
                            Text(AssistantMarkdown.inlineAttributed(passage.source))
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        }
                        if !passage.snippet.isEmpty {
                            Text(AssistantMarkdown.inlineAttributed(passage.snippet))
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .lineLimit(2)
                        }
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func driveResultsCard(
        title: String,
        query: String,
        files: [MessageResponseCard.DriveFile]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(title: title, subtitle: query, countLabel: "\(files.count) \(files.count == 1 ? "file" : "files")")
            if files.isEmpty {
                Text("No matching files.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                compactResultRows(files) { file in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: fileSymbol(file.mimeType))
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 4) {
                            if let url = URL(string: file.url) {
                                Link(destination: url) {
                                    Text(AssistantMarkdown.inlineAttributed(file.name))
                                        .font(.subheadline.weight(.semibold))
                                }
                            } else {
                                Text(AssistantMarkdown.inlineAttributed(file.name))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                            }
                            let metadata = [file.mimeType, file.size, file.modifiedTime.isEmpty ? "" : cardDate(file.modifiedTime)]
                                .filter { !$0.isEmpty }
                                .joined(separator: " · ")
                            if !metadata.isEmpty {
                                Text(metadata)
                                    .font(.caption)
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func knowledgeGraphCard(
        title: String,
        edges: [MessageResponseCard.KnowledgeEdge],
        complete: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            resultHeader(
                title: title,
                subtitle: complete ? "Active, source-backed" : "Showing the closest matches",
                countLabel: "\(edges.count) \(edges.count == 1 ? "connection" : "connections")"
            )
            ForEach(edges) { edge in
                HStack(alignment: .top, spacing: 10) {
                    Capsule()
                        .fill(AssistantTheme.accent(for: colorScheme).opacity(0.42))
                        .frame(width: 2)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Text(edge.subject)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 7)
                                .background(AssistantTheme.accent(for: colorScheme).opacity(0.10), in: Capsule())
                            Text("—\(edge.predicate)→")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            Text(edge.object)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 7)
                                .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        if !edge.evidence.isEmpty {
                            Text("“\(edge.evidence)”")
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text([
                            edge.source.isEmpty ? nil : "Source: \(edge.source)",
                            edge.confidence.map { "Confidence: \(Int(($0 * 100).rounded()))%" },
                            edge.ownerConfirmed ? "Owner-confirmed" : "Not owner-confirmed"
                        ].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func calendarConflictsCard(
        title: String,
        conflicts: [MessageResponseCard.CalendarConflict],
        complete: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            resultHeader(
                title: title,
                subtitle: complete ? "Calendar coverage is complete" : "Calendar coverage is partial",
                countLabel: "\(conflicts.count)"
            )
            ForEach(conflicts) { conflict in
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        "Overlap \(cardTime(conflict.overlapStart))–\(cardTime(conflict.overlapEnd))",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    Text(conflict.evidenceNote ?? "The times overlap; personal attendance and event identity are unverified.")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    ForEach(Array(conflict.groups.enumerated()), id: \.offset) { _, events in
                        if let event = events.first {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(event.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                Text("\(cardTime(event.start))–\(cardTime(event.end))")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                HStack(spacing: 5) {
                                    ForEach(events) { source in
                                        Text(events.count > 1 ? "\(source.calendar) · \(source.title) · \(cardTime(source.start))–\(cardTime(source.end))" : source.calendar)
                                            .font(.caption2.weight(.medium))
                                            .padding(.horizontal, 7)
                                            .padding(.vertical, 6)
                                            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                                    }
                                }
                                if !event.location.isEmpty {
                                    Label(event.location, systemImage: "mappin.and.ellipse")
                                        .font(.caption)
                                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(AssistantTheme.sunken(for: colorScheme).opacity(0.52), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func searchResultsCard(
        title: String,
        query: String,
        results: [MessageResponseCard.SearchResult]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(
                title: title,
                subtitle: query,
                countLabel: "\(results.count) \(results.count == 1 ? "result" : "results")"
            )
            if results.isEmpty {
                Text("No results found.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                compactResultRows(results) { result in
                    VStack(alignment: .leading, spacing: 4) {
                        if let url = URL(string: result.url) {
                            Link(destination: url) {
                                Text(CardText.readableSnippet(result.title))
                                    .font(.subheadline.weight(.semibold))
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else {
                            Text(CardText.readableSnippet(result.title))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Text(searchResultHost(result.url))
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .lineLimit(1)
                        if !result.snippet.isEmpty {
                            Text(CardText.readableSnippet(result.snippet))
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .lineLimit(usesAccessibilityLayout ? nil : 3)
                        }
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func searchResultHost(_ url: String) -> String {
        var host = URL(string: url)?.host ?? url
        if host.hasPrefix("www.") { host.removeFirst(4) }
        return host
    }

    private func availabilityCard(
        timeMin: String,
        timeMax: String,
        busy: [MessageResponseCard.BusyBlock],
        calendarsChecked: [String],
        complete: Bool,
        note: String?
    ) -> some View {
        let spansMultipleDays = availabilitySpansMultipleDays(timeMin: timeMin, timeMax: timeMax)
        return VStack(alignment: .leading, spacing: 13) {
            resultHeader(
                title: "Availability",
                subtitle: availabilityWindowCaption(timeMin: timeMin, timeMax: timeMax),
                countLabel: busy.isEmpty
                    ? (complete ? "Free" : "Unconfirmed")
                    : "\(busy.count) busy"
            )
            if busy.isEmpty {
                Text(complete
                    ? "Nothing on the calendar in this window."
                    : calendarsChecked.isEmpty
                        ? "Availability is unconfirmed for this window."
                        : "No conflicts found in the calendars that were checked.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityLabel(complete
                        ? "Nothing on the calendar in this window."
                        : calendarsChecked.isEmpty
                            ? "Availability is unconfirmed for this window."
                            : "No conflicts found in the calendars that were checked.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(busy.enumerated()), id: \.element.id) { index, block in
                        let interval = Text(availabilityTimeLabel(start: block.start, end: block.end, spansMultipleDays: spansMultipleDays))
                            .font(.subheadline.monospacedDigit().weight(.semibold))
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        let calendar = Text(block.calendar)
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        let stacked = VStack(alignment: .leading, spacing: 10) {
                            interval.fixedSize(horizontal: false, vertical: true)
                            if !block.calendar.isEmpty {
                                calendar.fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Group {
                            if usesAccessibilityLayout {
                                stacked
                            } else {
                                ViewThatFits(in: .horizontal) {
                                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                                        interval
                                            .lineLimit(1)
                                            .fixedSize(horizontal: true, vertical: false)
                                        Spacer(minLength: 6)
                                        if !block.calendar.isEmpty {
                                            calendar
                                                .lineLimit(1)
                                                .fixedSize(horizontal: true, vertical: false)
                                        }
                                    }
                                    stacked
                                }
                            }
                        }
                        .padding(.vertical, index == 0 ? 0 : 10)
                        if index < busy.count - 1 {
                            Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        }
                    }
                }
            }
            let coverage = availabilityCoverage(calendarsChecked: calendarsChecked, complete: complete, note: note)
            if !coverage.isEmpty {
                Text(coverage)
                    .font(.caption2)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    /// Multi-day windows prefix each block with its weekday so "Tue" never
    /// reads as if it belonged to the first day of the range.
    private func availabilityTimeLabel(start: String, end: String, spansMultipleDays: Bool) -> String {
        let range = "\(cardTime(start))–\(cardTime(end))"
        guard spansMultipleDays, let date = cardTimestamp(start) else { return range }
        return "\(date.formatted(.dateTime.weekday(.abbreviated))) · \(range)"
    }

    private func availabilityWindowCaption(timeMin: String, timeMax: String) -> String {
        let start = eventDateCaption(timeMin) ?? timeMin
        guard availabilitySpansMultipleDays(timeMin: timeMin, timeMax: timeMax),
              let end = eventDateCaption(timeMax) else {
            return start
        }
        return "\(start) – \(end)"
    }

    private func availabilitySpansMultipleDays(timeMin: String, timeMax: String) -> Bool {
        guard let start = cardTimestamp(timeMin), let end = cardTimestamp(timeMax) else {
            return false
        }
        return !Calendar.current.isDate(start, inSameDayAs: end)
    }

    private func availabilityCoverage(calendarsChecked: [String], complete: Bool, note: String?) -> String {
        var parts: [String] = []
        if !calendarsChecked.isEmpty {
            let suffix = complete ? "" : " (partial coverage)"
            parts.append("Checked \(calendarsChecked.count) \(calendarsChecked.count == 1 ? "calendar" : "calendars")\(suffix)")
        }
        if let note, !note.isEmpty { parts.append(note) }
        return parts.joined(separator: " · ")
    }

    private func threadCard(
        subject: String,
        messageCount: Int,
        messages: [MessageResponseCard.ThreadMessage]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(
                title: "Email thread",
                subtitle: subject,
                countLabel: "\(messageCount) \(messageCount == 1 ? "message" : "messages")"
            )
            if messages.isEmpty {
                Text("No messages in this thread.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(CardText.senderName(message.sender))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer(minLength: 6)
                                if let stamp = CardText.compactDateLabel(message.date) {
                                    Text(stamp)
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                        .lineLimit(1)
                                        .fixedSize(horizontal: true, vertical: false)
                                }
                            }
                            if !message.excerpt.isEmpty {
                                Text(message.excerpt)
                                    .font(.caption)
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                    .lineLimit(usesAccessibilityLayout ? nil : 3)
                                    .truncationMode(.tail)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, index == 0 ? 0 : 12)
                        if index < messages.count - 1 {
                            Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        }
                    }
                }
                if messageCount > messages.count {
                    Text("Showing the first \(messages.count) messages.")
                        .font(.caption2)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func sheetRowsCard(
        sheetName: String,
        rows: [[String]],
        totalRows: Int,
        linkURL: String?
    ) -> some View {
        let visibleRows = rows.filter { row in row.contains { !$0.isEmpty } }
        return VStack(alignment: .leading, spacing: 13) {
            resultHeader(
                title: sheetName,
                subtitle: "Google Sheet",
                countLabel: "\(totalRows) \(totalRows == 1 ? "row" : "rows")"
            )
            if visibleRows.isEmpty {
                Text("This sheet is empty.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 7) {
                    ForEach(Array(visibleRows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(AssistantMarkdown.inlineAttributed(cell))
                                    .font(index == 0 ? .caption.weight(.semibold) : .caption)
                                    .foregroundStyle(
                                        index == 0
                                            ? AssistantTheme.ink(for: colorScheme)
                                            : AssistantTheme.inkMuted(for: colorScheme)
                                    )
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
                        if index == 0, visibleRows.count > 1 {
                            Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        }
                    }
                }
                if totalRows > visibleRows.count {
                    Text("Showing the first \(visibleRows.count) of \(totalRows) rows.")
                        .font(.caption2)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                if let linkURL, let url = URL(string: linkURL) {
                    Link("Open spreadsheet", destination: url)
                        .font(.caption.weight(.semibold))
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func resourceCard(
        resourceType: String,
        title: String,
        subtitle: String,
        details: [MessageResponseCard.Detail],
        linkLabel: String?,
        linkURL: String?
    ) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: resourceSymbol(resourceType))
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 42, height: 42)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(CardText.presentationLabel(subtitle))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(AssistantMarkdown.inlineAttributed(title))
                    .font(.headline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                detailRows(details)
                if let linkURL, let url = URL(string: linkURL) {
                    Link(linkLabel ?? "Open", destination: url)
                        .font(.caption.weight(.semibold))
                }
            }
            Spacer(minLength: 0)
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    private func statusCard(
        title: String,
        detail: String,
        symbol: String,
        details: [MessageResponseCard.Detail],
        linkLabel: String?,
        linkURL: String?
    ) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 42, height: 42)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text("Complete")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(AssistantMarkdown.inlineAttributed(title))
                    .font(.headline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                if !detail.isEmpty {
                    Text(AssistantMarkdown.inlineAttributed(detail))
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
                detailRows(details)
                if let linkURL, let url = URL(string: linkURL) {
                    Link(linkLabel ?? "Open", destination: url)
                        .font(.caption.weight(.semibold))
                }
            }
            Spacer(minLength: 0)
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    private func proactiveAlertCard(
        category: String,
        urgency: String,
        title: String,
        summary: String,
        startsAt: String,
        dueAt: String,
        details: [MessageResponseCard.Detail]
    ) -> some View {
        ProactiveAlertContent(category: category, urgency: urgency, title: title, summary: summary,
            startsAt: startsAt, dueAt: dueAt, details: details)
            .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    private func generatedCard(_ card: MessageResponseCard.GeneratedCard) -> some View {
        let facts = Dictionary(card.facts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let sections = card.blockSections
        return VStack(alignment: .leading, spacing: CardStyle.blockSpacing) {
            if usesAccessibilityLayout {
                VStack(alignment: .leading, spacing: 6) {
                    Text(card.title)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                    if !card.subtitle.isEmpty {
                        Text(card.subtitle)
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(CardText.presentationLabel(card.sourceLabel))
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Spacer(minLength: 0)
                        ShareLink(item: GeneratedCardValue.shareText(card)) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("Share \(card.title)")
                    }
                }
            } else {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: generatedSymbol(card.icon))
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .frame(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(CardText.presentationLabel(card.sourceLabel))
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        Text(card.title)
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        if !card.subtitle.isEmpty {
                            Text(card.subtitle)
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        }
                    }
                    Spacer(minLength: 8)
                    ShareLink(item: GeneratedCardValue.shareText(card)) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Share \(card.title)")
                }
            }

            ForEach(sections.preview) { block in
                generatedBlock(block, facts: facts, cardId: card.id, shownElsewhere: card.journeyClockFacts)
            }
            if !sections.details.isEmpty {
                DisclosureGroup("More details") {
                    VStack(alignment: .leading, spacing: CardStyle.blockSpacing) {
                        ForEach(sections.details) { block in
                            generatedBlock(block, facts: facts, cardId: card.id, shownElsewhere: card.journeyClockFacts)
                        }
                    }
                    .padding(.top, 12)
                }
                .font(.caption.weight(.semibold))
                .tint(AssistantTheme.accent(for: colorScheme))
            }

            if let form = card.form, let cardFormActions {
                NativeCardFormView(
                    form: form,
                    warningFacts: form.warningFactIds.compactMap { facts[$0] },
                    actions: cardFormActions,
                    stateRevision: cardFormTaskRevision
                )
                .padding(.top, 4)
            }

            GeneratedCardFreshness(card: card, refresh: onRefresh)

            // A revealed secret is a value, not a button, so it sits above
            // the row. Everything else shares one row of equal tiles.
            let actions = card.actions.filter { $0.type != "refresh" }
            ForEach(actions.filter { $0.type == "reveal_sensitive" }) { action in
                generatedAction(action, card: card, facts: facts)
            }
            let tiles = actions.filter { $0.type != "reveal_sensitive" && actionAvailable($0, facts: facts) }
            if !tiles.isEmpty {
                let perRow = dynamicTypeSize.isAccessibilitySize ? 1 : 3
                Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                    ForEach(Array(stride(from: 0, to: tiles.count, by: perRow)), id: \.self) { start in
                        GridRow {
                            ForEach(tiles[start..<min(start + perRow, tiles.count)]) { action in
                                generatedAction(action, card: card, facts: facts)
                            }
                        }
                    }
                }
                .environment(\.cardActionSolo, tiles.count == 1)
            }

            // Last in the card, after the actions: the answer, then what acts
            // on it, then — for whoever wants it — where it came from.
            if !card.steps.isEmpty {
                Divider()
                GeneratedCardSteps(steps: card.steps)
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(SpeakableText.safeAccessibilityLabel(for: card))
    }

    @ViewBuilder
    private func generatedBlock(
        _ block: MessageResponseCard.GeneratedBlock,
        facts: [String: MessageResponseCard.GeneratedFact],
        cardId: String,
        shownElsewhere: Set<String> = []
    ) -> some View {
        if block.type == "section" {
            VStack(alignment: .leading, spacing: 12) {
                if let title = block.values["title"]?.string, !title.isEmpty {
                    Text(CardText.presentationLabel(title))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(block.children) { child in
                    generatedLeafBlock(child, facts: facts, cardId: cardId, shownElsewhere: shownElsewhere)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            generatedLeafBlock(block, facts: facts, cardId: cardId, shownElsewhere: shownElsewhere)
        }
    }

    @ViewBuilder
    private func generatedLeafBlock(
        _ block: MessageResponseCard.GeneratedBlock,
        facts: [String: MessageResponseCard.GeneratedFact],
        cardId: String,
        shownElsewhere: Set<String> = []
    ) -> some View {
        switch block.type {
        case "hero":
            // The one thing the card is about, set large; no rules around it,
            // the spacing does the separating.
            if let id = block.values["titleFact"]?.string, let fact = facts[id] {
                VStack(alignment: .leading, spacing: CardStyle.labelSpacing) {
                    if fact.sensitive {
                        SensitiveCardValue(fact: fact, prominent: true)
                    } else {
                        Text(fact.value)
                            .font(.title2.weight(.bold))
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    if let subtitleId = block.values["subtitleFact"]?.string,
                       let subtitle = facts[subtitleId] {
                        if subtitle.sensitive {
                            SensitiveCardValue(fact: subtitle)
                        } else {
                            Text(subtitle.value)
                                .font(CardStyle.body)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case "facts":
            let ids = block.values["factIds"]?.arrayStrings ?? []
            // A lone fact owns the row. At large text sizes, keep each value
            // readable instead of squeezing a reference into half a card.
            LazyVGrid(
                columns: CardStyle.columns(min(ids.count, 2), accessibility: dynamicTypeSize.isAccessibilitySize),
                alignment: .leading,
                spacing: CardStyle.partSpacing + 4
            ) {
                ForEach(ids, id: \.self) { id in
                    if let fact = facts[id] {
                        VStack(alignment: .leading, spacing: CardStyle.labelSpacing) {
                            CardEyebrow(fact.label)
                            generatedFactValue(fact, prominent: false)
                        }
                    }
                }
            }
        case "timeline":
            let ids = block.values["factIds"]?.arrayStrings ?? []
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(ids.enumerated()), id: \.offset) { index, id in
                    if let fact = facts[id] {
                        HStack(alignment: .top, spacing: 12) {
                            VStack(spacing: 0) {
                                Text("\((block.values["startIndex"]?.integerValue ?? 1) + index)")
                                    .font(.caption2.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                                    .frame(width: 22, height: 22)
                                    .background(AssistantTheme.accent(for: colorScheme).opacity(0.1), in: Circle())
                                    .accessibilityHidden(true)
                                if index < ids.count - 1 {
                                    Rectangle().fill(AssistantTheme.accent(for: colorScheme).opacity(0.2))
                                        .frame(width: 1)
                                }
                            }
                            .padding(.top, 5)
                            VStack(alignment: .leading, spacing: CardStyle.labelSpacing) {
                                CardEyebrow(fact.label)
                                generatedFactValue(fact, prominent: false)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.bottom, index < ids.count - 1 ? 16 : 0)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case "score":
            HStack(spacing: 12) {
                scoreSide(label: facts[block.values["leftLabelFact"]?.string ?? ""], value: facts[block.values["leftValueFact"]?.string ?? ""])
                Text("—").foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                scoreSide(label: facts[block.values["rightLabelFact"]?.string ?? ""], value: facts[block.values["rightValueFact"]?.string ?? ""])
            }
            .padding(12)
            .background(AssistantTheme.sunken(for: colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case "code":
            if let id = block.values["valueFact"]?.string, let fact = facts[id] {
                if fact.sensitive {
                    SensitiveCardValue(fact: fact, format: block.values["format"]?.string ?? "")
                } else {
                    Text(fact.value).font(.callout.monospaced().weight(.semibold)).textSelection(.enabled)
                }
            }
        case "note":
            if let id = block.values["factId"]?.string, let fact = facts[id] {
                generatedFactValue(fact, prominent: false)
            }
        case "image":
            if let id = block.values["urlFact"]?.string, let fact = facts[id] {
                if fact.sensitive {
                    SensitiveCardValue(fact: fact, format: "")
                } else if let url = URL(string: fact.value),
                          ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                    let alt = block.values["altFact"]?.string.flatMap { facts[$0] }
                    let label = alt.map { $0.sensitive ? "Open image" : "Open image: \($0.value)" } ?? "Open image"
                    Link(destination: url) { Label(label, systemImage: "photo") }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .frame(minHeight: 44, alignment: .leading)
                        .accessibilityHint("Opens the source image.")
                }
            }
        default:
            // The layout blocks added since (GeneratedCardBlocks.swift); a
            // type neither knows draws nothing and leaves the card intact.
            GeneratedCardBlockView(block: block, facts: facts, cardId: cardId, shownElsewhere: shownElsewhere)
        }
    }

    @ViewBuilder
    private func generatedFactValue(_ fact: MessageResponseCard.GeneratedFact, prominent: Bool) -> some View {
        if fact.sensitive {
            // It used to be a disclosure labeled "Reveal" — no idea what it was
            // about to reveal, and no way to put the number away again.
            SensitiveCardValue(fact: fact, prominent: prominent)
        } else {
            Text(fact.value)
                .font(prominent ? .title3.weight(.semibold) : CardStyle.value)
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func scoreSide(
        label: MessageResponseCard.GeneratedFact?,
        value: MessageResponseCard.GeneratedFact?
    ) -> some View {
        VStack(spacing: 4) {
            Text(label?.value ?? "").font(.caption).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            Text(value?.value ?? "").font(.title2.monospaced().weight(.bold))
        }
        .frame(maxWidth: .infinity)
    }

    private func generatedSymbol(_ icon: String) -> String {
        switch icon {
        case "ticket": "ticket.fill"
        case "plane": "airplane"
        case "sport": "trophy.fill"
        case "package": "shippingbox.fill"
        case "calendar": "calendar"
        case "map": "map.fill"
        case "music": "music.note"
        case "star": "star.fill"
        case "train": "tram.fill"
        case "car": "car.fill"
        case "hotel": "bed.double.fill"
        case "food": "fork.knife"
        case "money": "creditcard.fill"
        case "health": "heart.fill"
        case "weather": "cloud.sun.fill"
        case "checklist": "checklist"
        default: "sparkles"
        }
    }

    /// Whether an action can be drawn from what the card holds; one that
    /// cannot takes no tile in the row.
    private func actionAvailable(
        _ action: MessageResponseCard.GeneratedAction,
        facts: [String: MessageResponseCard.GeneratedFact]
    ) -> Bool {
        let fact = action.factId.flatMap { facts[$0] }
        switch action.type {
        case "open_url":
            guard let value = fact?.value, let url = URL(string: value) else { return false }
            return ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        case "copy_value": return fact != nil
        case "directions": return fact.map { !$0.sensitive } ?? false
        case "add_to_calendar":
            guard let start = action.startFact.flatMap({ facts[$0] }), !start.sensitive else { return false }
            return GeneratedCardValue.instant(start.value) != nil
        case "ask_assistant": return !(action.prompt ?? "").isEmpty && onSend != nil
        default: return false
        }
    }

    @ViewBuilder
    private func generatedAction(
        _ action: MessageResponseCard.GeneratedAction,
        card: MessageResponseCard.GeneratedCard,
        facts: [String: MessageResponseCard.GeneratedFact]
    ) -> some View {
        let fact = action.factId.flatMap { facts[$0] }
        if action.type == "open_url",
           let value = fact?.value,
           let url = URL(string: value),
           ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            Link(destination: url) { Label(action.label, systemImage: "arrow.up.right.square") }
                .buttonStyle(CardActionButtonStyle())
        } else if action.type == "reveal_sensitive", let fact {
            SensitiveCardValue(fact: fact, format: "")
        } else if action.type == "copy_value", let fact {
            let copied = copiedAction == "\(card.id)-\(action.id)"
            Button {
                UIPasteboard.general.string = fact.value
                copiedAction = "\(card.id)-\(action.id)"
                AccessibilityNotification.Announcement("Copied").post()
            } label: {
                Label(copied ? "Copied" : action.label, systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(CardActionButtonStyle())
        } else if action.type == "add_to_calendar",
                  let start = action.startFact.flatMap({ facts[$0] }), !start.sensitive,
                  let draft = CalendarDraft(
                      identity: "\(card.id):\(action.id)",
                      title: card.title,
                      start: start.value,
                      end: action.endFact.flatMap { facts[$0]?.value },
                      location: action.locationFact.flatMap { facts[$0] }.flatMap { $0.sensitive ? nil : $0.value }
                  ) {
            AddToCalendarButton(label: action.label, draft: draft)
        } else if action.type == "directions", let fact, !fact.sensitive,
                  let url = GeneratedCardValue.directionsURL(fact.value) {
            Link(destination: url) {
                Label(action.label, systemImage: "arrow.triangle.turn.up.right.diamond")
            }
            .buttonStyle(CardActionButtonStyle())
            .accessibilityHint("Opens directions in Maps.")
        } else if action.type == "ask_assistant", let prompt = action.prompt, !prompt.isEmpty {
            Button { onSend?(prompt) } label: {
                Label(action.label, systemImage: "bubble.left.and.text.bubble.right")
            }
            .buttonStyle(CardActionButtonStyle())
            .disabled(onSend == nil)
        }
    }

    @ViewBuilder
    private func detailRows(_ details: [MessageResponseCard.Detail]) -> some View {
        if !details.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(details) { detail in
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text("\(detail.label): ")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        Text(AssistantMarkdown.inlineAttributed(detail.value))
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    }
                }
            }
        }
    }

    /// Not every subtitle is a sentence. A Gmail query or a filter string is
    /// machine input — it belongs on the card as provenance, but it must never
    /// out-shout an actual result.
    private enum ResultHeaderSubtitle {
        case prominent
        case query
    }

    private func resultHeader(
        title: String,
        subtitle: String,
        countLabel: String,
        subtitleStyle: ResultHeaderSubtitle = .prominent
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(CardText.presentationLabel(title))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                Spacer(minLength: 4)
                Text(countLabel)
                    .font(.caption2.monospacedDigit().weight(.medium))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !subtitle.isEmpty {
                switch subtitleStyle {
                case .prominent:
                    Text(AssistantMarkdown.inlineAttributed(subtitle))
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                case .query:
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(usesAccessibilityLayout ? 3 : 2)
                        .truncationMode(.tail)
                }
            }
        }
    }

    /// One found message. Every field here is a raw mail header or a snippet a
    /// stranger wrote, so all three render as plain text — see `CardText`.
    private func emailRow(_ message: MessageResponseCard.EmailResult) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(CardText.senderName(message.sender.isEmpty ? message.recipient : message.sender))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(1)
                    // Tail, not middle: the front of a name carries the identity.
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                if let stamp = CardText.compactDateLabel(message.date) {
                    Text(stamp)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(1)
                        // A few glyphs of fact. The sender is the field with
                        // slack in it, so the sender is what gives way — without
                        // this the stack happily clips the date to `19:0…`.
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            Text(message.subject)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .lineLimit(usesAccessibilityLayout ? nil : 2)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !message.snippet.isEmpty {
                Text(CardText.compactSummary(CardText.readableSnippet(message.snippet)))
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(usesAccessibilityLayout ? nil : 2)
                    .truncationMode(.tail)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .contentShape(Rectangle())
        // One email per VoiceOver swipe rather than four fragments.
        .accessibilityElement(children: .combine)
    }

    private func emailCountLabel(messages: [MessageResponseCard.EmailResult], estimate: Int?, complete: Bool) -> String {
        if !complete { return "Partial · \(estimate ?? messages.count)" }
        return "\(messages.count) \(messages.count == 1 ? "email" : "emails")"
    }

    private func cardDate(_ value: String) -> String {
        guard let date = cardTimestamp(value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func cardTime(_ value: String) -> String {
        guard let date = cardTimestamp(value) else { return value }
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// ISO 8601 from the Google APIs, or a raw RFC 5322 header off a Gmail
    /// message. Not ISO-only any more, so not named as if it were.
    private func cardTimestamp(_ value: String) -> Date? { CardText.timestamp(value) }

    private func resourceSymbol(_ resourceType: String) -> String {
        switch resourceType {
        case "document": "doc.text.fill"
        case "spreadsheet": "tablecells.fill"
        default: "doc.fill"
        }
    }

    private func fileSymbol(_ mimeType: String) -> String {
        let lower = mimeType.lowercased()
        if lower.contains("pdf") { return "doc.richtext.fill" }
        if lower.contains("sheet") || lower.contains("spreadsheet") { return "tablecells.fill" }
        if lower.contains("presentation") || lower.contains("slide") { return "rectangle.on.rectangle.angled" }
        if lower.contains("image") { return "photo.fill" }
        return "doc.fill"
    }

    /// The sky names the server sends (response-cards.ts), mapped to SF
    /// Symbols. The wire vocabulary stays client-agnostic — the web maps the
    /// same names to its own icon set — and a name this build does not know
    /// falls through to the prose reading below.
    private static let weatherSymbols: [String: String] = [
        "clear": "sun.max.fill",
        "partly-cloudy": "cloud.sun.fill",
        "cloudy": "cloud.fill",
        "fog": "cloud.fog.fill",
        "drizzle": "cloud.drizzle.fill",
        "rain": "cloud.rain.fill",
        "sleet": "cloud.sleet.fill",
        "snow": "cloud.snow.fill",
        "thunderstorm": "cloud.bolt.rain.fill",
    ]

    /// `symbol` is the server's own classification and is trusted first. The
    /// prose reading behind it still has to be right: it serves payloads from
    /// before symbols existed, and it used to answer "fog" with a bright sun
    /// because nothing matched.
    private func weatherSymbol(_ condition: String, symbol: String = "") -> String {
        if let named = Self.weatherSymbols[symbol.lowercased()] { return named }
        let lower = condition.lowercased()
        if lower.contains("thunder") || lower.contains("storm") { return "cloud.bolt.rain.fill" }
        if lower.contains("snow") { return "cloud.snow.fill" }
        if lower.contains("freezing rain") || lower.contains("sleet") { return "cloud.sleet.fill" }
        if lower.contains("drizzle") { return "cloud.drizzle.fill" }
        if lower.contains("rain") { return "cloud.rain.fill" }
        if lower.contains("fog") || lower.contains("mist") || lower.contains("haze") { return "cloud.fog.fill" }
        if lower.contains("partly cloudy") || lower.contains("mostly clear") { return "cloud.sun.fill" }
        if lower.contains("cloud") || lower.contains("overcast") { return "cloud.fill" }
        if lower.contains("wind") { return "wind" }
        return "sun.max.fill"
    }

    /// A forecast row draws its own sky only when it describes one: a day or a
    /// part of a day does, "Wind" and "Humidity" do not, and a glyph guessed
    /// for those would be a reading the row never made.
    private func weatherFactSymbol(_ fact: MessageResponseCard.WeatherDetail) -> String? {
        if let named = Self.weatherSymbols[fact.symbol.lowercased()] { return named }
        guard fact.symbol.isEmpty else { return nil }
        let described = ["clear", "cloud", "overcast", "rain", "drizzle", "snow", "fog", "thunder", "storm", "sleet"]
        let lower = fact.value.lowercased()
        return described.contains(where: { lower.contains($0) }) ? weatherSymbol(fact.value) : nil
    }
}

/// The work behind an answer card, folded into the card itself.
///
/// The lookups that composed this card — the mailbox search, the thread it
/// opened — used to arrive as cards of their own, so one request came back as
/// three. They arrive as a step trail now, and this is the one quiet row it
/// gets: closed until someone wants to know where the numbers came from, and
/// closed again on the next card, because the state lives here rather than in
/// the transcript.
private struct GeneratedCardSteps: View {
    let steps: [MessageResponseCard.CardStep]
    @Environment(\.colorScheme) private var colorScheme

    private var failedCount: Int { steps.filter(\.failed).count }

    private var collapsedLabel: String {
        let found = "Found in \(steps.count) \(steps.count == 1 ? "step" : "steps")"
        return failedCount == 0 ? found : "\(found), \(failedCount) failed"
    }

    /// Keep the trail in the conversation's scroll view, at the card's full
    /// content width, including at accessibility text sizes.
    private var stepRows: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(steps) { step in
                stepRow(step)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        CardDisclosure(collapsedLabel: collapsedLabel, expandedLabel: "Hide steps",
            showsBottomCollapse: steps.count > 4) {
            stepRows
        }
    }

    private func stepRow(_ step: MessageResponseCard.CardStep) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // User-facing language, never the dotted call the runtime made.
                Text(ToolStepLabel.past(for: step.tool))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                Spacer(minLength: 0)
                if !step.count.isEmpty {
                    Text(step.count)
                        .font(.caption2)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            }
            // A reason is a sentence, so it gets its own line instead of the
            // count's slot, where it would squeeze the action name off the row.
            if step.failed {
                Text(step.error.isEmpty ? "Did not finish" : step.error)
                    .font(.caption2)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
            }
            if !step.detail.isEmpty {
                Text(step.detail)
                    .font(.caption2)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            AssistantTheme.raised(for: colorScheme),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }
}

/// Full-width disclosure content: no system indentation or nested paper shell.
/// Long groups offer a second collapse control after the final item.
struct CardDisclosure<Content: View>: View {
    let collapsedLabel: String
    let expandedLabel: String
    var standalone = false
    var showsBottomCollapse = false
    @State private var expanded: Bool
    private let content: Content
    @Environment(\.colorScheme) private var colorScheme

    init(collapsedLabel: String, expandedLabel: String, standalone: Bool = false,
         showsBottomCollapse: Bool = false, initiallyExpanded: Bool = false,
         @ViewBuilder content: () -> Content) {
        self.collapsedLabel = collapsedLabel
        self.expandedLabel = expandedLabel
        self.standalone = standalone
        self.showsBottomCollapse = showsBottomCollapse
        _expanded = State(initialValue: initiallyExpanded)
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            control(bottom: false)
            if expanded {
                VStack(alignment: .leading, spacing: 12) { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 10)
                if showsBottomCollapse {
                    control(bottom: true).padding(.top, 10)
                }
            }
        }
    }

    private func control(bottom: Bool) -> some View {
        Button {
            withTransaction(TranscriptDisclosure.transaction()) { expanded.toggle() }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(bottom ? "Show fewer" : expanded ? expandedLabel : collapsedLabel)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            .padding(.horizontal, standalone ? 16 : 0)
            .padding(.vertical, 6)
            .frame(minHeight: 44)
            .background {
                if standalone {
                    RoundedRectangle(cornerRadius: AssistantTheme.panelCornerRadius, style: .continuous)
                        .fill(AssistantTheme.bubblePaper(for: colorScheme))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Shows fewer details" : "Shows all details")
    }
}

/// A compact decision history entry with the full request available on tap.
struct DecisionReceiptCard: View {
    let title: String
    let summary: String
    let detail: String
    let code: String?
    let symbol: String
    let tint: Color
    @State private var expanded: Bool
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(title: String, summary: String, detail: String, code: String?, symbol: String,
         tint: Color, initiallyExpanded: Bool = false) {
        self.title = title
        self.summary = summary
        self.detail = detail
        self.code = code
        self.symbol = symbol
        self.tint = tint
        _expanded = State(initialValue: initiallyExpanded)
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.panelCornerRadius, style: .continuous)
        let webRequest = CardText.decisionWebRequestURL(summary)
        Button {
            withTransaction(TranscriptDisclosure.transaction()) { expanded.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tint)
                        .frame(width: 24, height: 24)
                        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tint)
                    Spacer(minLength: 4)
                    if let code, !code.isEmpty {
                        Text(code).font(.caption2.monospaced())
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(tint.opacity(colorScheme == .dark ? 0.09 : 0.045))

                VStack(alignment: .leading, spacing: 8) {
                    Text(webRequest == nil ? summary : "Read web page")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .lineLimit(expanded || dynamicTypeSize.isAccessibilitySize ? nil : 3)
                        .fixedSize(horizontal: false, vertical: true)
                    if let webRequest {
                        Label(webRequest.host ?? webRequest.absoluteString, systemImage: "globe")
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .fixedSize(horizontal: false, vertical: true)
                        if expanded {
                            Text(webRequest.absoluteString)
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if expanded, detail != summary {
                        Divider().padding(.vertical, 3)
                        Text(detail).font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(14)
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(AssistantTheme.bubblePaper(for: colorScheme))
            .clipShape(shape)
            .overlay(shape.strokeBorder(tint.opacity(colorSchemeContrast == .increased ? 0.45 : 0.13), lineWidth: 0.75))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityLabel(([title, summary, code ?? ""] + (expanded && detail != summary ? [detail] : []))
            .filter { !$0.isEmpty }.joined(separator: ". "))
        .accessibilityHint(expanded ? "Hides decision details" : "Shows the full request and decision details")
    }
}

/// The same grounded context appears alone or above its suggested action.
/// Details expand within the paper, without repeating the alert in a second card.
struct ProactiveAlertContent: View {
    let category: String
    let urgency: String
    let title: String
    let summary: String
    let startsAt: String
    let dueAt: String
    let details: [MessageResponseCard.Detail]
    var actionSummary: String? = nil
    @State private var expanded = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var symbol: String {
        switch category {
        case "email": "envelope.badge.fill"
        case "commitment": "bell.badge.fill"
        default: "calendar.badge.clock"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(urgency.isEmpty ? "For your attention" : urgency.replacingOccurrences(of: "_", with: " "), systemImage: symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            Text(AssistantMarkdown.inlineAttributed(title))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !summary.isEmpty {
                Text(AssistantMarkdown.inlineAttributed(summary))
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(expanded || dynamicTypeSize.isAccessibilitySize ? nil : 3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let temporal = startsAt.isEmpty ? dueAt : startsAt
            if !temporal.isEmpty {
                let date = CalendarEventPresentation.timestamp(temporal)
                Label("\(startsAt.isEmpty ? "Due" : "Starts") \(date?.formatted(.dateTime.month(.abbreviated).day().hour().minute()) ?? temporal)", systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
            if !details.isEmpty || !summary.isEmpty || actionSummary != nil {
                DisclosureGroup("Details", isExpanded: $expanded) {
                    VStack(alignment: .leading, spacing: 10) {
                        if let actionSummary, !actionSummary.isEmpty, actionSummary != summary, actionSummary != title {
                            Text(AssistantMarkdown.inlineAttributed(actionSummary))
                                .font(.subheadline)
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(Array(details.enumerated()), id: \.offset) { _, detail in
                            if !(detail.label == "Due" && !dueAt.isEmpty) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(detail.label).font(.caption.weight(.medium))
                                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                    Text(AssistantMarkdown.inlineAttributed(detail.value)).font(.subheadline)
                                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                    .padding(.top, 6)
                }
                .font(.caption.weight(.semibold))
                .tint(AssistantTheme.accent(for: colorScheme))
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// One proposed next step and its source, with a quiet receipt after answering.
/// Accepting creates work under the assistant's normal action permissions.
/// It does not itself approve external actions or alter the approval inbox.
struct SuggestionCard: View {
    let parts: [MessagePart]
    let decide: ((String, SuggestionDecision) async -> String?)?
    let openActivity: (() -> Void)?

    /// Every button in the card stands down while one answer is in flight.
    @State private var answering = false
    /// Why the last answer did not land, shown beside the controls.
    @State private var failure: String?
    @State private var expandedReceipts: Set<String> = []

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    @Environment(\.timeZone) private var timeZone

    var body: some View {
        if parts.contains(where: { $0.suggestionStatus.isOpen }) {
            openCard
        } else {
            // Nothing left to ask: each answer leaves the same receipt an
            // approval does, so the log reads as one surface.
            VStack(alignment: .leading, spacing: 8) {
                ForEach(parts, id: \.suggestionId) { part in
                    settledRow(part)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(AssistantTheme.bubblePaper(for: colorScheme),
                            in: RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous))
                }
            }
        }
    }

    private var openCard: some View {
        let accent = AssistantTheme.accent(for: colorScheme)
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
        return VStack(alignment: .leading, spacing: 14) {
            if parts.count != 1 || parts.first?.suggestionContext == nil {
                Label(parts.count == 1 ? "Suggested next step" : "\(parts.count) suggestions", systemImage: "lightbulb.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(accent)
                    .accessibilityAddTraits(.isHeader)
            }

            ForEach(parts, id: \.suggestionId) { part in
                if part.suggestionStatus.isOpen {
                    question(part)
                } else {
                    settledRow(part)
                }
            }

            if answering {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Saving your answer…").font(.caption)
                }
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .accessibilityElement(children: .combine)
            }

            if let failure {
                Label(failure, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.bubblePaper(for: colorScheme), in: shape)
        .overlay {
            shape.strokeBorder(
                accent.opacity(colorSchemeContrast == .increased ? 0.5 : 0.25),
                lineWidth: colorSchemeContrast == .increased ? 1.2 : 0.9
            )
        }
    }

    private func question(_ part: MessagePart) -> some View {
        let id = part.suggestionId ?? ""
        return VStack(alignment: .leading, spacing: 10) {
            if case let .proactiveAlert(_, category, urgency, title, summary, startsAt, dueAt, details)? = part.suggestionContext {
                ProactiveAlertContent(category: category, urgency: urgency, title: title, summary: summary,
                    startsAt: startsAt, dueAt: dueAt, details: details, actionSummary: part.summary)
            } else {
                Text(AssistantMarkdown.inlineAttributed(part.summary ?? part.proposedAction ?? "The assistant has a suggestion."))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Wrapping keeps all three at their full 44pt size on a narrow
            // column; accessibility sizes stack them full width instead.
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) { answers(for: id, actionLabel: part.suggestionActionLabel, fillsWidth: true) }
            } else {
                AssistantFlowLayout(spacing: 8) { answers(for: id, actionLabel: part.suggestionActionLabel, fillsWidth: false) }
            }
        }
    }

    @ViewBuilder
    private func answers(for id: String, actionLabel: String, fillsWidth: Bool) -> some View {
        answerButton(actionLabel, id: id, decision: .accepted, kind: .primary, fillsWidth: fillsWidth,
            hint: "Creates a task. The assistant’s action permissions still apply.")
        answerButton("Later", id: id, decision: .snoozed, kind: .neutral, fillsWidth: fillsWidth,
            hint: "Puts this aside and asks again later.")
        answerButton("No thanks", id: id, decision: .dismissed, kind: .neutral, fillsWidth: fillsWidth,
            hint: "Dismisses this suggestion.")
    }

    private func answerButton(_ title: String, id: String, decision: SuggestionDecision,
                              kind: AssistantActionButtonKind, fillsWidth: Bool, hint: String) -> some View {
        Button {
            answer(id: id, decision: decision)
        } label: {
            Text(title).fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(AssistantActionButtonStyle(kind: kind, compact: true, fillsWidth: fillsWidth))
        .disabled(answering || decide == nil || id.isEmpty)
        .accessibilityIdentifier("assistant.suggestion.\(id).\(decision.rawValue)")
        .accessibilityHint(hint)
    }

    private func answer(id: String, decision: SuggestionDecision) {
        guard !answering, let decide else { return }
        answering = true
        failure = nil
        Task {
            let failure = await decide(id, decision)
            self.failure = failure
            answering = false
            // The buttons are gone either way — to a receipt, or back with a
            // reason — so say which, rather than leave VoiceOver on nothing.
            let confirmation = SuggestionReceiptPresentation(part: .init(type: "suggestion", status: decision.rawValue)).title
            AccessibilityNotification.Announcement(failure ?? confirmation).post()
        }
    }

    /// An answered suggestion sharing a card with one still open: a line, not
    /// a second sheet of paper inside the first.
    private func settledRow(_ part: MessagePart) -> some View {
        let receipt = SuggestionReceiptPresentation(part: part)
        let id = part.suggestionId ?? ""
        return DisclosureGroup(isExpanded: Binding(
            get: { expandedReceipts.contains(id) },
            set: { if $0 { expandedReceipts.insert(id) } else { expandedReceipts.remove(id) } }
        )) {
            VStack(alignment: .leading, spacing: 10) {
                if case let .proactiveAlert(_, category, urgency, title, summary, startsAt, dueAt, details)? = part.suggestionContext {
                    ProactiveAlertContent(category: category, urgency: urgency, title: title, summary: summary,
                        startsAt: startsAt, dueAt: dueAt, details: details, actionSummary: part.summary)
                } else if let summary = part.summary {
                    Text(AssistantMarkdown.inlineAttributed(summary))
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(receiptDetail(part, fallback: receipt.detail))
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                taskLink(part, onPaper: true)
            }
            .padding(.top, 10)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Label(receipt.title, systemImage: receipt.symbol)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(AssistantMarkdown.inlineAttributed(part.suggestionTitle))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                if let returnLabel = receipt.returnLabel(locale: locale, timeZone: timeZone) {
                    Text(returnLabel)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(minHeight: 44, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
        .multilineTextAlignment(.leading)
        .tint(AssistantTheme.inkMuted(for: colorScheme))
        .accessibilityIdentifier("assistant.suggestion.\(id).receipt")
        .accessibilityHint(expandedReceipts.contains(id) ? "Hides suggestion details" : "Shows the suggestion and its current status")
    }

    private func receiptDetail(_ part: MessagePart, fallback: String) -> String {
        guard part.suggestionStatus == .accepted, let update = part.acceptedTaskSummary, !update.isEmpty else {
            return fallback
        }
        return "\(fallback)\n\nLatest update: \(update)"
    }

    /// Under a settled receipt the link sits on the chat's green, where accent
    /// ink all but vanishes, so it brings its own paper, as every other thing
    /// in the log does.
    @ViewBuilder
    private func taskLink(_ part: MessagePart, onPaper: Bool) -> some View {
        if part.suggestionStatus == .accepted, let taskId = part.acceptedTaskId, !taskId.isEmpty, let openActivity {
            Button(action: openActivity) {
                HStack(spacing: 5) {
                    Text("View in Activity")
                    Image(systemName: "arrow.right")
                        .font(.caption2.weight(.bold))
                        .accessibilityHidden(true)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .padding(.horizontal, onPaper ? 0 : 14)
                .padding(.vertical, onPaper ? 0 : 8)
                .background {
                    if !onPaper { Capsule().fill(AssistantTheme.bubblePaper(for: colorScheme)) }
                }
                .padding(.top, onPaper ? 0 : 6)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens Activity to show task status.")
        }
    }

}

/// A value the card holds back: a booking reference, a ticket code.
///
/// A fixed-width mask keeps long identifiers compact. The button is named for
/// what it shows: VoiceOver announces "Show booking reference", not the mask.
struct SensitiveCardValue: View {
    let fact: MessageResponseCard.GeneratedFact
    var prominent = false
    /// The caption a `code` block puts above the value ("qr", "text").
    var format: String = ""
    @Environment(\.colorScheme) private var colorScheme
    @State private var revealed = false

    private var name: String {
        let label = fact.label.trimmingCharacters(in: .whitespaces).lowercased()
        return label.isEmpty ? "value" : label
    }

    var body: some View {
        Button {
            revealed.toggle()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                if !format.isEmpty {
                    Text(revealed ? format.uppercased() : "Tap to reveal")
                        .font(.caption2.monospaced().weight(.medium))
                        .tracking(1.1)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    // A fixed mask neither leaks the identifier's length nor
                    // wraps a stray character into another line. Revealed
                    // values may wrap so no part of the real value is lost.
                    Text(revealed ? fact.value : "••••••")
                        .font(prominent ? .title3.monospaced().weight(.semibold) : .callout.monospaced())
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .multilineTextAlignment(.leading)
                        .lineLimit(revealed ? nil : 1)
                    // Touch has no hover to reveal that this is a control, so
                    // the control says so itself.
                    Image(systemName: revealed ? "eye.slash" : "eye")
                        .font(.caption2)
                        .fixedSize()
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(revealed ? "Hide \(name)" : "Show \(name)")
        .accessibilityValue(revealed ? fact.value : "Hidden")
        .accessibilityAddTraits(revealed ? [.isSelected] : [])
    }
}

/// A supporting-results disclosure belongs to the answer's paper, not the
/// conversation background. Own the chevron color instead of inheriting the
/// system disclosure tint from the surrounding navigation stack.
struct AnswerSourcesFooter: View {
    let cards: [MessageResponseCard]
    var onSend: ((String) -> Void)? = nil
    var onRefresh: ((String, String?) async -> String?)? = nil
    @State private var expanded = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            Divider().padding(.horizontal, 20)
            sourceControl(bottom: false)
            if expanded {
                RichResponseCards(cards: cards, onSend: onSend, onRefresh: onRefresh)
                    .environment(\.responseCardIsEmbedded, true)
                sourceControl(bottom: true)
            }
        }
    }

    private func sourceControl(bottom: Bool) -> some View {
        Button {
            withTransaction(TranscriptDisclosure.transaction()) {
                expanded.toggle()
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc.text.magnifyingglass")
                Text(bottom ? "Hide sources and details" : "Sources and details")
                Spacer(minLength: 8)
                Image(systemName: bottom ? "chevron.up" : "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(!bottom && expanded ? 90 : 0))
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            .padding(.horizontal, 20)
            .padding(.vertical, 6)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Hides supporting results" : "Shows the supporting results for this answer")
    }
}

/// Expanding evidence is a reading action, not new chat output. Preserve the
/// content offset instead of applying the transcript's usual bottom anchoring.
enum TranscriptDisclosure {
    static func transaction() -> Transaction {
        // Animated height reconciliation re-applies SwiftUI's bottom anchor
        // on later frames, outside the original transaction. An atomic layout
        // update keeps the tapped footer still, including with Reduce Motion.
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        transaction.scrollContentOffsetAdjustmentBehavior = .disabled
        return transaction
    }
}

private struct ResponseCardIsEmbeddedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var responseCardIsEmbedded: Bool {
        get { self[ResponseCardIsEmbeddedKey.self] }
        set { self[ResponseCardIsEmbeddedKey.self] = newValue }
    }
}

private struct ResponseCardSurface: ViewModifier {
    let colorScheme: ColorScheme
    let colorSchemeContrast: ColorSchemeContrast
    let inset: CGFloat
    @Environment(\.responseCardIsEmbedded) private var embedded

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
        let padded = content.padding(inset)
            .frame(maxWidth: .infinity, minHeight: AssistantTheme.responseCardMinHeight, alignment: .leading)
        if embedded {
            padded
        } else {
            padded
                .background(AssistantTheme.raised(for: colorScheme), in: shape)
                .overlay {
                    shape.stroke(
                        AssistantTheme.ink(for: colorScheme).opacity(colorSchemeContrast == .increased ? 0.22 : 0.09),
                        lineWidth: 1
                    )
                }
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.10 : 0.045), radius: 12, y: 4)
        }
    }
}

private extension View {
    /// Cards always fill the row: a card sized to its content looks broken
    /// next to full-width siblings, in the transcript and on any other page.
    func responseCardSurface(
        colorScheme: ColorScheme,
        colorSchemeContrast: ColorSchemeContrast,
        inset: CGFloat
    ) -> some View {
        modifier(ResponseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: inset))
    }

    func resultCardSurface(colorScheme: ColorScheme, colorSchemeContrast: ColorSchemeContrast) -> some View {
        responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }
}

extension JSONValue {
    var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    var arrayStrings: [String]? {
        guard case let .array(value) = self else { return nil }
        return value.compactMap(\.string)
    }

    var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    var numberValue: Double? {
        guard case let .number(value) = self else { return nil }
        return value
    }

}

/// Cards carry third-party text: a Gmail `Date:` header, an RFC 5322 mailbox,
/// a snippet written by a stranger. None of it is assistant prose, so none of it
/// goes through the Markdown parser — it gets parsed for what it actually is, or
/// shown as plain text.
enum CardText {
    /// Only the exact tool-authored fetch summary gets a compact site treatment.
    /// Other requests retain their wording, including ambiguous or unsafe URLs.
    static func decisionWebRequestURL(_ summary: String) -> URL? {
        let prefix = "Fetch the public web page "
        guard summary.hasPrefix(prefix) else { return nil }
        let raw = String(summary.dropFirst(prefix.count))
        guard !raw.contains(where: \.isWhitespace),
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        return url
    }

    // MARK: Timestamps

    /// Cards carry timestamps in two shapes: ISO 8601 from the Google APIs, and
    /// a raw RFC 5322 `Date:` header straight off a Gmail message. Anything that
    /// parses as neither is not a date, and the caller decides what to do.
    static func timestamp(_ value: String) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let date = iso8601.date(from: trimmed) ?? iso8601Fractional.date(from: trimmed) {
            return date
        }
        let header = expandingTwoDigitYear(strippingTrailingComment(trimmed))
        for formatter in rfc5322Formatters {
            if let date = formatter.date(from: header) { return date }
        }
        return nil
    }

    /// `Wed, 2 Sep 2026 19:08:04 -0700 (PDT)` — that trailing zone name is legal
    /// RFC 5322 comment syntax that no `DateFormatter` pattern accepts, so it
    /// comes off before the patterns are tried.
    private static func strippingTrailingComment(_ value: String) -> String {
        guard let range = value.range(of: #"\s*\([^()]*\)\s*$"#, options: .regularExpression) else {
            return value
        }
        return String(value[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// RFC 5322 §4.3: an obsolete two-digit year 00–49 means 20xx, 50–99 means
    /// 19xx. This has to happen before parsing rather than as a `yy` pattern,
    /// because `DateFormatter` accepts a short year for `yyyy` when parsing: the
    /// four-digit pattern matches `Wed, 2 Sep 26 …` first and reads it as the
    /// year 26 AD, so a `yy` pattern further down the list is never reached.
    private static func expandingTwoDigitYear(_ value: String) -> String {
        // Two digits standing alone between the month and the time.
        guard let match = value.range(
            of: #"(?<=\s)\d{2}(?=\s+\d{1,2}:)"#,
            options: .regularExpression
        ), let year = Int(value[match]) else { return value }
        return value.replacingCharacters(in: match, with: String(year < 50 ? 2000 + year : 1900 + year))
    }

    private static let iso8601 = ISO8601DateFormatter()

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Built once at first use: `DateFormatter` construction is expensive and a
    /// card formats a date on every row of every render.
    ///
    /// `d` also parses `02` and `HH` also parses `9`, so single- and two-digit
    /// days and hours need no separate patterns — only the genuinely different
    /// grammars below do, and a two-digit year is normalised away before these
    /// are tried. Order is load-bearing: `Z` before `zzz`, because ICU's `z`
    /// will opportunistically accept `-0700` and produce a worse parse.
    private static let rfc5322Formatters: [DateFormatter] = [
        "EEE, d MMM yyyy HH:mm:ss Z",
        "d MMM yyyy HH:mm:ss Z",
        // RFC 5322 makes seconds optional.
        "EEE, d MMM yyyy HH:mm Z",
        "d MMM yyyy HH:mm Z",
        // Obsolete alphabetic zones still in the wild: `GMT`, `UT`, `PDT`.
        "EEE, d MMM yyyy HH:mm:ss zzz",
        "d MMM yyyy HH:mm:ss zzz",
    ].map(CardText.rfc5322Formatter(_:))

    private static func rfc5322Formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        // Fixed-format input: the locale must not follow the device, or `Sep`
        // and `Wed` stop parsing the moment someone switches to French.
        formatter.locale = Locale(identifier: "en_US_POSIX")
        // Only consulted if a header somehow arrives with no zone at all.
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = format
        return formatter
    }

    /// The stamp on an email row, sized to what the reader needs: today is a
    /// time, this year is a day, anything older earns its year. Mail clients
    /// have converged on this for a reason — it is the smallest label that is
    /// never ambiguous.
    static func compactDateLabel(
        for date: Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if calendar.isDate(date, inSameDayAs: now) {
            return style.hour(.defaultDigits(amPM: .abbreviated)).minute(.twoDigits).format(date)
        }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            return style.month(.abbreviated).day().format(date)
        }
        return style.month(.abbreviated).day().year().format(date)
    }

    /// The row's stamp from the raw card field: a parsed date, or a short
    /// unparseable value passed through (a server can still send `today`), or
    /// nothing at all. A wall of raw header is worse than an empty column.
    static func compactDateLabel(
        _ value: String,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .autoupdatingCurrent
    ) -> String? {
        if let date = timestamp(value) {
            return compactDateLabel(for: date, now: now, calendar: calendar, locale: locale)
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= passthroughDateLimit else { return nil }
        return trimmed
    }

    /// Anything short enough to fit the column is trusted; anything longer is a
    /// header we failed to parse, and is dropped rather than shown in pieces.
    private static let passthroughDateLimit = 12

    // MARK: Prose

    /// Search and mail previews sometimes contain HTML highlight tags/entities.
    /// Clean their text without invoking a web/HTML renderer, following links,
    /// or interpreting third-party text as Markdown. Only known tags are
    /// removed, so angle-bracket mailboxes and ordinary comparisons survive.
    static func readableSnippet(_ value: String) -> String {
        let entities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'",
            "nbsp": " ", "ndash": "–", "mdash": "—", "hellip": "…", "rsquo": "’",
            "lsquo": "‘", "ldquo": "“", "rdquo": "”", "bull": "•"]
        var text = value
        if let expression = NSRegularExpression.cached(#"&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);"#) {
            for match in expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
                guard let range = Range(match.range, in: text),
                      let keyRange = Range(match.range(at: 1), in: text) else { continue }
                let key = String(text[keyRange])
                var replacement = entities[key]
                if key.hasPrefix("#") {
                    let hex = key.hasPrefix("#x")
                    if let number = UInt32(key.dropFirst(hex ? 2 : 1), radix: hex ? 16 : 10),
                       let scalar = UnicodeScalar(number), !CharacterSet.controlCharacters.contains(scalar) {
                        replacement = String(scalar)
                    }
                }
                if let replacement { text.replaceSubrange(range, with: replacement) }
            }
        }
        text = text.replacingOccurrences(of: #"(?is)<(script|style)\b[^>]*>.*?</\1\s*>"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)</?(?:br|p|div|li|ul|ol|tr|td|th|table|blockquote)(?:\s+[^<>]*?)?\s*/?>"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)</?(?:strong|b|em|i|span|a|mark|small|sup|sub)(?:\s+[^<>]*?)?\s*/?>"#, with: "", options: .regularExpression)
        return text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One line of someone else's writing, sized for a preview: newlines and
    /// runs of space collapse, and anything past a long sentence is cut.
    static func compactSummary(_ value: String) -> String {
        let oneLine = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard oneLine.count > 160 else { return oneLine }
        return String(oneLine.prefix(159)).trimmingCharacters(in: .whitespaces) + "…"
    }

    // MARK: Links

    /// Gmail publishes no deep-link contract, but `#all/<id>` has addressed a
    /// message or thread by id for years, and `authuser` picks the account the
    /// search actually ran against — the card carries it as `mailbox`.
    static func gmailURL(id: String, mailbox: String) -> URL? {
        // When Gmail returns neither a message nor a thread id the server
        // synthesises `email-<card>-<row>`, which addresses nothing.
        guard !id.isEmpty, !id.hasPrefix("email-") else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = "mail.google.com"
        if mailbox.isEmpty {
            components.path = "/mail/u/0/"
        } else {
            components.path = "/mail/"
            components.queryItems = [URLQueryItem(name: "authuser", value: mailbox)]
        }
        components.fragment = "all/\(id)"
        return components.url
    }

    // MARK: Mailboxes

    /// Gmail hands the card a raw `From` header. The row wants the human, not
    /// the machine: `"Support at TripIt" <support@tripit.com>` is a sender
    /// called Support at TripIt, and the address is noise the reader already
    /// trusts the client to have got right.
    static func senderName(_ value: String) -> String {
        let mailboxes = splitMailboxes(value)
        guard let first = mailboxes.first else { return "" }
        let name = displayName(ofMailbox: first)
        guard mailboxes.count > 1 else { return name }
        return "\(name) +\(mailboxes.count - 1)"
    }

    /// Splits on the commas that separate mailboxes — not the ones inside
    /// `"Doe, Jane"`, and not the ones inside an address.
    private static func splitMailboxes(_ value: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var inQuotes = false
        var inAngle = false
        var escaped = false
        for character in value {
            if escaped {
                current.append(character)
                escaped = false
                continue
            }
            switch character {
            case "\\" where inQuotes:
                current.append(character)
                escaped = true
            case "\"":
                inQuotes.toggle()
                current.append(character)
            case "<" where !inQuotes:
                inAngle = true
                current.append(character)
            case ">" where !inQuotes:
                inAngle = false
                current.append(character)
            case "," where !inQuotes && !inAngle:
                parts.append(current)
                current = ""
            default:
                current.append(character)
            }
        }
        parts.append(current)
        return parts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func displayName(ofMailbox mailbox: String) -> String {
        guard let open = mailbox.lastIndex(of: "<"),
              let close = mailbox.lastIndex(of: ">"),
              open < close
        else {
            // A bare address, or a name with no address behind it.
            return unquoted(mailbox)
        }
        let address = String(mailbox[mailbox.index(after: open)..<close])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let name = unquoted(String(mailbox[..<open]).trimmingCharacters(in: .whitespacesAndNewlines))
        if name.isEmpty { return address }
        if name.caseInsensitiveCompare(address) == .orderedSame { return address }
        // A MIME encoded-word is left undecoded on purpose. A partial RFC 2047
        // decoder is worse than none: adjacent words that split a multi-byte
        // character across the boundary render as `Suppo??t`, which reads as our
        // bug rather than the sender's. The address is always correct.
        if name.contains("=?"), name.contains("?="), !address.isEmpty { return address }
        return name
    }

    /// Unwraps an RFC 5322 quoted-string in one pass, so an escaped quote
    /// survives intact.
    private static func unquoted(_ value: String) -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2, text.hasPrefix("\""), text.hasSuffix("\"") else { return text }
        var result = ""
        var escaped = false
        for character in text.dropFirst().dropLast() {
            if escaped {
                result.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else {
                result.append(character)
            }
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Transport/source identifiers occasionally arrive in generated cards
    /// (for example `SOURCE_MESSAGE`). Keep those useful as provenance while
    /// presenting them as product copy instead of leaking the wire format.
    static func presentationLabel(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("_") || trimmed.contains("-") || trimmed == trimmed.uppercased() else {
            return raw
        }
        let words = trimmed
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(whereSeparator: \.isWhitespace)
        return words.enumerated().map { index, word in
            let value = String(word)
            if value.count <= 4, value == value.uppercased() { return value }
            let lower = value.lowercased()
            guard let first = lower.first else { return lower }
            return (index == 0 ? String(first).uppercased() : String(first)) + String(lower.dropFirst())
        }.joined(separator: " ")
    }
}

/// A lightweight GFM-inspired block parser. Keeping this local avoids a dependency while
/// making partially streamed replies render gracefully as they arrive.
enum AssistantMarkdown {
    /// Everything below is a pure function of its source string, and a
    /// transcript asks for the same answers over and over — see `RenderMemo`.
    ///
    /// The limits are sized to hold a long open conversation rather than just
    /// the rows on screen, because the transcript builds every row it has. Full
    /// at these sizes they come to a few megabytes; a miss costs exactly what
    /// every call used to cost, so they degrade into the old behaviour rather
    /// than into a cliff.
    private static let blockMemo = RenderMemo<String, [Block]>(limit: 512)
    private static let inlineMemo = RenderMemo<String, AttributedString>(limit: 1024)
    private static let attributedMemo = RenderMemo<AttributedRequest, AttributedString>(limit: 1024)
    private static let plainTextMemo = RenderMemo<String, String>(limit: 512)

    /// Compact structured cards can still include a short Markdown label from
    /// a legacy/plain-text reply. Parse that inline fragment instead of
    /// exposing delimiter characters such as `**` in the card.
    static func inlineAttributed(_ source: String) -> AttributedString {
        inlineMemo.value(for: source) { source in
            let options = AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
            return (try? AttributedString(markdown: source, options: options))
                ?? AttributedString(source)
        }
    }

    /// A body's Markdown request: the text and the one flag that changes how it
    /// is read. The rendered font and colour are view modifiers applied to the
    /// result, so they are deliberately not part of the key.
    private struct AttributedRequest: Hashable {
        let source: String
        let inline: Bool
    }

    /// One block of prose, or one table cell, as the renderer draws it.
    ///
    /// Table cells use inline-only interpretation: a block-level construct
    /// inside a cell (a heading marker, a hard break) would otherwise tear the
    /// row layout apart.
    static func attributed(_ source: String, inline: Bool) -> AttributedString {
        attributedMemo.value(for: AttributedRequest(source: source, inline: inline)) { request in
            let readable = readableInlineVariables(request.source)
            let withBreaks = request.inline
                ? tableCellText(readable)
                : preservingSoftBreaks(readable)
            return (try? AttributedString(
                markdown: withBreaks,
                options: .init(
                    interpretedSyntax: request.inline ? .inlineOnlyPreservingWhitespace : .full
                )
            )) ?? AttributedString(request.source)
        }
    }

    /// The same Markdown with its syntax resolved away, for the screen reader.
    static func plainText(_ source: String) -> String {
        plainTextMemo.value(for: source) { source in
            guard let attributed = try? AttributedString(
                markdown: source,
                options: .init(interpretedSyntax: .full)
            ) else {
                return source
            }
            return String(attributed.characters)
        }
    }

    /// Built once: compiling a pattern costs more than matching it, and these
    /// run per table cell per block of prose.
    private static let tableBreakExpression = try? NSRegularExpression(
        pattern: #"`+[^`]*`+|<br\s*/?>"#,
        options: .caseInsensitive
    )

    /// GFM table cells commonly use HTML line breaks. Preserve inline code
    /// examples while displaying actual break tags as line breaks.
    static func tableCellText(_ source: String) -> String {
        guard let pattern = tableBreakExpression else { return source }
        let output = NSMutableString(string: source)
        let matches = pattern.matches(in: source, range: NSRange(source.startIndex..., in: source))
        for match in matches.reversed() where output.substring(with: match.range).hasPrefix("<") {
            output.replaceCharacters(in: match.range, with: "\n")
        }
        return output as String
    }

    enum Block: Hashable {
        case heading(level: Int, text: String)
        case paragraph(String)
        /// Bullets, numbered items, and task checkboxes in one tree — LLM
        /// output nests and mixes them freely, so the renderer recurses
        /// rather than committing to a flat list of a single kind.
        case list([ListNode])
        case quote(String)
        case equation(String)
        case code(language: String?, text: String)
        case divider
        case table(headers: [String], rows: [[String]])
    }

    enum ListMarker: Hashable {
        case bullet
        case number(Int)
        case task(isComplete: Bool)
    }

    /// AttributedString folds CommonMark soft breaks into spaces, but a chat
    /// reply means a single line break literally — one found email per line
    /// must not collapse into a block. Convert to GFM hard breaks, which do
    /// survive the conversion as real newlines.
    static func preservingSoftBreaks(_ source: String) -> String {
        source.replacingOccurrences(of: "\n", with: "\\\n")
    }

    struct ListNode: Hashable {
        let marker: ListMarker
        let text: String
        let children: [ListNode]
    }

    /// One raw parsed list line: its indent depth, marker, and text.
    private struct RawListItem {
        let indent: Int
        let marker: ListMarker
        let text: String
    }

    static func blocks(in source: String) -> [Block] {
        blockMemo.value(for: source, compute: parseBlocks(in:))
    }

    private static func parseBlocks(in source: String) -> [Block] {
        let normalized = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        // Overlong prose paragraphs render as several short ones; see
        // ParagraphReflow. Whitespace-only, so the stored text is untouched.
        let lines = ParagraphReflow.reflow(normalized)
            .components(separatedBy: "\n")
        var result: [Block] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]

            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                index += 1
                continue
            }

            if isCodeFence(line) {
                let language = codeFenceLanguage(in: line)
                index += 1
                var codeLines: [String] = []

                while index < lines.count, !isCodeFence(lines[index]) {
                    codeLines.append(lines[index])
                    index += 1
                }

                if index < lines.count {
                    index += 1
                }

                let code = codeLines.joined(separator: "\n")
                result.append(.code(language: language, text: code))
                continue
            }

            if let heading = heading(in: line) {
                result.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if index + 1 < lines.count,
               isSetextUnderline(lines[index + 1]),
               !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let level = lines[index + 1].trimmingCharacters(in: .whitespaces).first == "=" ? 1 : 2
                result.append(.heading(level: level, text: line.trimmingCharacters(in: .whitespaces)))
                index += 2
                continue
            }

            if isDivider(line) {
                result.append(.divider)
                index += 1
                continue
            }

            if let table = table(at: index, in: lines) {
                result.append(.table(headers: table.headers, rows: table.rows))
                index = table.endIndex
                continue
            }

            if line.trimmingCharacters(in: .whitespaces) == "$$" {
                index += 1
                var formula: [String] = []
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces) != "$$" {
                    formula.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                result.append(.equation(formula.joined(separator: "\n")))
                continue
            }

            if quoteLineContent(line) != nil {
                var quoteLines: [String] = []
                while index < lines.count, let content = quoteLineContent(lines[index]) {
                    quoteLines.append(content)
                    index += 1
                }
                result.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            if listItem(in: line) != nil {
                var rawItems: [RawListItem] = []
                while index < lines.count, let item = listItem(in: lines[index]) {
                    rawItems.append(item)
                    index += 1
                }
                var cursor = 0
                result.append(.list(parseListLevel(rawItems, index: &cursor, indent: rawItems.first?.indent ?? 0)))
                continue
            }

            var paragraphLines: [String] = []
            while index < lines.count,
                  !lines[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !startsBlock(at: index, in: lines) {
                paragraphLines.append(lines[index].trimmingCharacters(in: .whitespaces))
                index += 1
            }

            if paragraphLines.isEmpty {
                // Avoid an infinite loop for a malformed, unsupported construct.
                paragraphLines.append(line.trimmingCharacters(in: .whitespaces))
                index += 1
            }
            // Chat convention, not strict GFM: a single line break in a reply
            // is a real break, kept as "\n" here and rendered as one via
            // preservingSoftBreaks at the view. Folding to a space collapsed
            // structured answers — one found email per line — into a block.
            let paragraph = paragraphLines.joined(separator: "\n")
            if isStandaloneBoldQuote(paragraph) {
                result.append(.quote(paragraph))
            } else {
                result.append(.paragraph(paragraph))
            }
        }

        return result.enumerated().map { index, block in
            guard case let .paragraph(text) = block,
                  index + 1 < result.count,
                  text.hasPrefix("**"), text.hasSuffix("**") else { return block }
            let label = String(text.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
            if ["example", "note", "tip"].contains(label.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ":"))) { return block }
            guard !label.isEmpty, label.count <= 60,
                  !label.contains("\n"), !label.contains("**"),
                  let last = label.last, !".!?\"”'’".contains(last) else { return block }
            switch result[index + 1] {
            case .list, .code, .table:
                return .heading(level: 2, text: label)
            default:
                return block
            }
        }
    }

    private static func startsBlock(at index: Int, in lines: [String]) -> Bool {
        let line = lines[index]
        return isCodeFence(line)
            || line.trimmingCharacters(in: .whitespaces) == "$$"
            || heading(in: line) != nil
            || isDivider(line)
            || quoteLineContent(line) != nil
            || listItem(in: line) != nil
            || table(at: index, in: lines) != nil
    }

    private static func isCodeFence(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("```")
    }

    private static func codeFenceLanguage(in line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard isCodeFence(trimmed) else { return nil }
        let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
        return language.isEmpty ? nil : language
    }

    private static func heading(in line: String) -> (level: Int, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let hashes = trimmed.prefix { $0 == "#" }
        guard !hashes.isEmpty, hashes.count <= 6 else { return nil }
        let remainder = trimmed.dropFirst(hashes.count)
        guard remainder.first?.isWhitespace == true else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return (hashes.count, text)
    }

    private static func isSetextUnderline(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, first == "=" || first == "-" else {
            return false
        }
        return compact.allSatisfy { $0 == first }
    }

    private static func isDivider(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, ["-", "*", "_"].contains(first) else {
            return false
        }
        return compact.allSatisfy { $0 == first }
    }

    private static func quoteLineContent(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.first == ">" else { return nil }
        return String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
    }

    /// A model asked for a quote-style callout will often return a single bold
    /// quoted paragraph instead of `>` syntax. Match only that unambiguous
    /// shape so normal bold copy remains an ordinary paragraph.
    static func isStandaloneBoldQuote(_ source: String) -> Bool {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.contains("\n"),
              trimmed.hasPrefix("**"),
              trimmed.hasSuffix("**"),
              trimmed.count > 8 else { return false }

        let inner = String(trimmed.dropFirst(2).dropLast(2))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let quotePairs: [(Character, Character)] = [
            ("“", "”"),
            ("\"", "\""),
            ("‘", "’"),
            ("'", "'"),
        ]
        guard let first = inner.first, let last = inner.last else { return false }
        return quotePairs.contains { $0.0 == first && $0.1 == last }
    }

    /// A readable native fallback for elementary arithmetic TeX. Unsupported
    /// expressions retain their source notation; this is not a full TeX engine.
    static func readableEquation(_ source: String) -> String {
        var value = source
        for (command, symbol) in [("\\times", "×"), ("\\cdot", "·"), ("\\div", "÷"), ("\\leq", "≤"), ("\\geq", "≥"), ("\\left", ""), ("\\right", "")] {
            value = value.replacingOccurrences(of: command, with: symbol)
        }
        let superscripts = ["0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "t": "ᵗ", "n": "ⁿ"]
        for (plain, superscript) in superscripts {
            value = value.replacingOccurrences(of: "^{\(plain)}", with: superscript)
            value = value.replacingOccurrences(of: "\\^\(plain)(?![0-9A-Za-z])", with: superscript, options: .regularExpression)
        }
        return value
    }

    private static let inlineVariableExpression = try? NSRegularExpression(
        pattern: #"`+[^`]*`+|(?<!\$)\$([A-Za-z])\$(?!\$)"#
    )

    static func readableInlineVariables(_ source: String) -> String {
        guard let expression = inlineVariableExpression else { return source }
        var result = source
        for match in expression.matches(in: source, range: NSRange(source.startIndex..., in: source)).reversed() {
            guard match.range(at: 1).location != NSNotFound,
                  let variable = Range(match.range(at: 1), in: result),
                  let full = Range(match.range, in: result) else { continue }
            result.replaceSubrange(full, with: String(result[variable]))
        }
        return result
    }

    /// Leading indent in columns (a tab counts as four) so nesting survives
    /// the common LLM convention of two- or four-space child bullets.
    private static func leadingIndent(of line: String) -> Int {
        var columns = 0
        for character in line {
            if character == " " { columns += 1 }
            else if character == "\t" { columns += 4 }
            else { break }
        }
        return columns
    }

    /// Parses any list line — bullet, numbered, or task — into a raw item,
    /// or nil when the line is not a list item at all.
    private static func listItem(in line: String) -> RawListItem? {
        let indent = leadingIndent(of: line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if let marker = trimmed.first, ["-", "*", "+"].contains(marker) {
            let remainder = trimmed.dropFirst()
            guard remainder.first?.isWhitespace == true else { return nil }
            let text = remainder.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return nil }
            // GFM task syntax rides on the bullet marker: "- [ ] …" / "- [x] …".
            let lowercased = text.lowercased()
            if lowercased.hasPrefix("[ ] ") || lowercased.hasPrefix("[x] ") {
                let taskText = String(text.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                guard !taskText.isEmpty else { return nil }
                return RawListItem(
                    indent: indent,
                    marker: .task(isComplete: lowercased.hasPrefix("[x] ")),
                    text: taskText
                )
            }
            return RawListItem(indent: indent, marker: .bullet, text: text)
        }

        let digits = trimmed.prefix { $0.isNumber }
        guard !digits.isEmpty,
              let ordinal = Int(digits),
              trimmed.dropFirst(digits.count).first == "." else { return nil }
        let remainder = trimmed.dropFirst(digits.count + 1)
        guard remainder.first?.isWhitespace == true else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return RawListItem(indent: indent, marker: .number(ordinal), text: text)
    }

    /// Folds the flat indent-ordered items into a tree. Anything indented
    /// deeper than the current level attaches to the previous node; a line
    /// indented with no parent above it degrades to a sibling rather than
    /// being dropped, which keeps partially streamed lists renderable.
    private static func parseListLevel(
        _ items: [RawListItem],
        index: inout Int,
        indent: Int
    ) -> [ListNode] {
        var nodes: [ListNode] = []
        while index < items.count {
            let item = items[index]
            if item.indent < indent { break }
            if item.indent > indent {
                guard let last = nodes.last else {
                    index += 1
                    nodes.append(ListNode(marker: item.marker, text: item.text, children: []))
                    continue
                }
                let children = parseListLevel(items, index: &index, indent: item.indent)
                nodes[nodes.count - 1] = ListNode(
                    marker: last.marker,
                    text: last.text,
                    children: last.children + children
                )
                continue
            }
            index += 1
            nodes.append(ListNode(marker: item.marker, text: item.text, children: []))
        }
        return nodes
    }

    private static func table(at index: Int, in lines: [String]) -> (headers: [String], rows: [[String]], endIndex: Int)? {
        // Spreadsheet pastes have tabs but usually no Markdown separator or
        // header. Keep every column (including missing values); never guess
        // that the first person's row is a header or invent semantic labels.
        if lines[index].contains("\t"), !lines[index].hasPrefix("\t") {
            let width = lines[index].components(separatedBy: "\t").count
            var rows: [[String]] = []
            var cursor = index
            while cursor < lines.count, lines[cursor].contains("\t") {
                let cells = lines[cursor].components(separatedBy: "\t")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                guard cells.count == width else { break }
                rows.append(cells)
                cursor += 1
            }
            if rows.filter({ $0.contains { !$0.isEmpty } }).count >= 2 {
                return ([], rows, cursor)
            }
        }
        guard index + 1 < lines.count,
              let headers = tableCells(in: lines[index]),
              headers.count > 1,
              isTableSeparator(lines[index + 1], columnCount: headers.count) else { return nil }

        var rows: [[String]] = []
        var rowIndex = index + 2
        while rowIndex < lines.count, let cells = tableCells(in: lines[rowIndex]) {
            var row = Array(cells.prefix(headers.count))
            if row.count < headers.count {
                row.append(contentsOf: Array(repeating: "", count: headers.count - row.count))
            }
            rows.append(row)
            rowIndex += 1
        }
        return (headers, rows, rowIndex)
    }

    private static func tableCells(in line: String) -> [String]? {
        guard line.contains("|") else { return nil }
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.first == "|" { trimmed.removeFirst() }
        if trimmed.last == "|" { trimmed.removeLast() }
        return trimmed
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isTableSeparator(_ line: String, columnCount: Int) -> Bool {
        guard let cells = tableCells(in: line), cells.count == columnCount else { return false }
        return cells.allSatisfy { cell in
            let compact = cell.filter { !$0.isWhitespace }
            guard compact.count >= 3 else { return false }
            return compact.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }

}

private struct AssistantMarkdownView: View {
    let source: String
    let baseFontSize: CGFloat
    let ink: Color
    let mutedInk: Color
    let codeSurface: Color
    let accent: Color
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// A response card can use the full row for evidence such as tables and
    /// code, but prose should stop at a comfortable reading measure on iPad.
    private let proseMaxWidth: CGFloat = 560

    var body: some View {
        // Read the parse once per body rather than per block. As a computed
        // property, the `blocks[index - 1]` lookup below re-entered the parser
        // for every block in the message — quadratic in a long reply, on every
        // frame of a streaming turn.
        let blocks = AssistantMarkdown.blocks(in: source)

        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                if case let .heading(level, _) = block, level <= 2, index > 0,
                   blocks[index - 1] != .divider {
                    Rectangle()
                        .fill(ink.opacity(0.12))
                        .frame(height: 0.75)
                        .padding(.top, 5)
                        .accessibilityHidden(true)
                }
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func blockView(_ block: AssistantMarkdown.Block) -> some View {
        switch block {
        case let .heading(level, text):
            markdownText(text, font: headingFont(for: level))
                .tracking(level <= 2 ? -0.22 : -0.12)
                .lineSpacing(1)
                .padding(.top, level <= 2 ? 2 : 0)
                .frame(maxWidth: proseMaxWidth, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

        case let .paragraph(text):
            markdownText(text)
                .frame(maxWidth: proseMaxWidth, alignment: .leading)

        case let .list(nodes):
            listNodesView(nodes)
                .frame(maxWidth: proseMaxWidth, alignment: .leading)
                .accessibilityElement(children: .contain)

        case let .quote(text):
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "quote.opening")
                    .font(.system(size: baseFontSize, weight: .medium))
                    .foregroundStyle(accent)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                if AssistantMarkdown.isStandaloneBoldQuote(text) {
                    markdownText(text).italic()
                } else {
                    AnyView(AssistantMarkdownView(
                        source: text, baseFontSize: baseFontSize, ink: ink,
                        mutedInk: mutedInk, codeSurface: codeSurface, accent: accent
                    ))
                    .italic()
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: proseMaxWidth, alignment: .leading)
            .background(codeSurface.opacity(0.56), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(ink.opacity(0.07), lineWidth: 0.75)
            }

        case let .equation(text):
            markdownText(AssistantMarkdown.readableEquation(text), font: .system(size: baseFontSize, design: .monospaced))
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(codeSurface.opacity(0.56), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

        case let .code(language, text):
            if language?.lowercased() == "mermaid" {
                MermaidDiagramView(source: text)
            } else {
            VStack(alignment: .leading, spacing: 0) {
                Label(language?.isEmpty == false ? language! : "Code", systemImage: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: max(12, baseFontSize * 0.85), weight: .medium))
                    .foregroundStyle(mutedInk)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Rectangle()
                    .fill(ink.opacity(0.09))
                    .frame(height: 0.75)
                    .accessibilityHidden(true)
                // The transcript is a LazyVStack, which proposes zero height
                // to children while it measures — a horizontal ScrollView
                // whose content is `fixedSize(horizontal: true)` then
                // collapses to nothing and the code body renders blank. Code
                // wraps to the bubble instead: on a phone, wrapping is more
                // readable than a sideways pan, and the text stays selectable.
                Text(text.isEmpty ? " " : text)
                    .font(.system(size: max(12, baseFontSize * 0.9), design: .monospaced))
                    .foregroundStyle(ink)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    // Without an explicit vertical fix the LazyVStack measures
                    // the block at two lines and tail-truncates the rest.
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 12)
            }
            .background(codeSurface.opacity(0.56), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(ink.opacity(0.09), lineWidth: 0.75)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(language.map { "\($0) code block" } ?? "Code block")
            }

        case .divider:
            Capsule()
                .fill(ink.opacity(0.13))
                .frame(height: 1)
                .padding(.vertical, 5)
                .accessibilityHidden(true)

        case let .table(headers, rows):
            let columnCount = max(headers.count, rows.map(\.count).max() ?? 0)
            let stacked = columnCount > 3 || dynamicTypeSize.isAccessibilitySize
            // Equal-width cells keep columns aligned without an unmeasured
            // nested horizontal ScrollView collapsing inside the transcript.
            VStack(alignment: .leading, spacing: 0) {
                if !headers.isEmpty && !stacked {
                    tableRow(headers, isHeader: true)
                        .background(ink.opacity(0.06))
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                    if stacked {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                                VStack(alignment: .leading, spacing: 2) {
                                    if headers.indices.contains(column) {
                                        Text(AssistantMarkdown.inlineAttributed(headers[column]))
                                            .font(.system(size: baseFontSize * 0.85, weight: .semibold))
                                            .foregroundStyle(mutedInk)
                                    }
                                    markdownText(cell.isEmpty ? "—" : cell, inline: true)
                                }
                            }
                        }
                        .padding(12)
                    } else {
                        tableRow(row, isHeader: false)
                    }
                    if rowIndex < rows.count - 1 {
                        Rectangle()
                            .fill(ink.opacity(0.08))
                            .frame(height: 0.75)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(codeSurface.opacity(0.56), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(ink.opacity(0.09), lineWidth: 0.75)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Table with \(columnCount) columns and \(rows.count) rows")
        }
    }

    private func tableRow(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                markdownText(cell.isEmpty ? "—" : cell, inline: true,
                             font: .system(size: baseFontSize * 0.92, weight: isHeader ? .semibold : .regular))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 9)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func markdownText(_ source: String, strikethrough: Bool = false, inline: Bool = false, font: Font? = nil) -> some View {
        Text(AssistantMarkdown.attributed(source, inline: inline))
            .font(font ?? .system(size: baseFontSize, weight: .regular))
            .tracking(-0.08)
            .foregroundStyle(ink)
            .lineSpacing(2.5)
            .strikethrough(strikethrough, color: mutedInk.opacity(0.65))
            .fixedSize(horizontal: false, vertical: true)
    }

    // Recursion lives in a named child view: a `some View` function that
    // returns itself cannot be inferred by the compiler (the opaque type
    // would be defined in terms of itself), so the nesting is expressed as a
    // concrete `NestedList` whose body recurses instead.
    private func listNodesView(_ nodes: [AssistantMarkdown.ListNode]) -> some View {
        NestedList(nodes: nodes) { node in AnyView(listNodeRow(node)) }
    }

    private struct NestedList: View {
        let nodes: [AssistantMarkdown.ListNode]
        let row: (AssistantMarkdown.ListNode) -> AnyView

        var body: some View {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in
                    VStack(alignment: .leading, spacing: 7) {
                        row(node)
                        if !node.children.isEmpty {
                            NestedList(nodes: node.children, row: row)
                                .padding(.leading, 18)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func listNodeRow(_ node: AssistantMarkdown.ListNode) -> some View {
        switch node.marker {
        case .bullet:
            listRow(marker: "•", text: node.text, markerColor: accent)
        case let .number(ordinal):
            listRow(marker: "\(ordinal).", text: node.text, markerColor: mutedInk)
        case let .task(isComplete):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: isComplete ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: baseFontSize * 0.94, weight: .medium))
                    .foregroundStyle(isComplete ? accent : mutedInk.opacity(0.75))
                    .accessibilityHidden(true)
                markdownText(node.text, strikethrough: isComplete)
                    .opacity(isComplete ? 0.72 : 1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(isComplete ? "Completed" : "Not completed"): \(plainText(node.text))")
        }
    }

    private func listRow(marker: String, text: String, markerColor: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker)
                .font(.system(size: baseFontSize * 0.9, weight: .semibold))
                .foregroundStyle(markerColor)
                .frame(minWidth: marker.count > 1 ? 17 : 10, alignment: .trailing)
                .accessibilityHidden(true)
            markdownText(text)
        }
    }

    private func headingFont(for level: Int) -> Font {
        switch level {
        case 1:
            .system(size: baseFontSize * 1.32, weight: .semibold, design: .rounded)
        case 2:
            .system(size: baseFontSize * 1.18, weight: .semibold, design: .rounded)
        default:
            .system(size: baseFontSize * 1.06, weight: .semibold)
        }
    }

    private func plainText(_ markdown: String) -> String {
        AssistantMarkdown.plainText(markdown)
    }
}

/// Lets the transcript skip a row whose content has not changed.
///
/// The stack of rows is eager on purpose (see `ChatView.conversationSurface`),
/// so every row in the conversation is offered a rebuild whenever anything in
/// the chat view changes — and a streaming reply changes something on every
/// token while touching exactly one row. Comparing a row is far cheaper than
/// rebuilding it: the message values come straight out of the same array, so
/// their strings compare by buffer identity.
///
/// The actions cannot be compared, but none of them varies while a row's
/// content holds still. Each either captures only `AppModel`, which is a
/// reference, or captures the message itself; the three that switch off do it by
/// going nil — `runForReal` and `retry` while a turn is in flight, `hide` for a
/// row the server has not stored — so comparing presence separates those cases.
/// `@State` and `@Environment` are not part of this: SwiftUI tracks them per row
/// and invalidates it directly, so a colour scheme or Dynamic Type change still
/// redraws every bubble.
extension MessageBubble: Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.message == rhs.message
            && lhs.userPrompt == rhs.userPrompt
            && lhs.isStreaming == rhs.isStreaming
            && (lhs.runForReal == nil) == (rhs.runForReal == nil)
            && (lhs.retry == nil) == (rhs.retry == nil)
            && (lhs.decideApproval == nil) == (rhs.decideApproval == nil)
            && (lhs.rememberApproval == nil) == (rhs.rememberApproval == nil)
            && (lhs.decideSuggestion == nil) == (rhs.decideSuggestion == nil)
            && (lhs.openActivity == nil) == (rhs.openActivity == nil)
            && (lhs.refreshCard == nil) == (rhs.refreshCard == nil)
            && (lhs.setRecallSourceSuppressed == nil) == (rhs.setRecallSourceSuppressed == nil)
            && (lhs.recallSourceSuppressed == nil) == (rhs.recallSourceSuppressed == nil)
            && (lhs.hide == nil) == (rhs.hide == nil)
            && (lhs.acknowledgeDelivery == nil) == (rhs.acknowledgeDelivery == nil)
            && lhs.cardFormStateRevision == rhs.cardFormStateRevision
            && lhs.cardFormTaskRevision == rhs.cardFormTaskRevision
    }
}

/// One compact transcript card for adjacent approvals that have all been
/// resolved. Expanding it keeps each approval's summary and short code
/// available without making a rapid approval run dominate the conversation.
struct ApprovedReceiptGroup: View, Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.messages == rhs.messages }

    let messages: [ChatMessage]

    @State private var isExpanded = false

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var approvals: [MessagePart] {
        messages.flatMap(\.decisionParts)
    }

    private var countLabel: String {
        let count = approvals.count
        return "\(count) \(count == 1 ? "request" : "requests") approved"
    }

    var body: some View {
        let tint = AssistantTheme.success(for: colorScheme)
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
        VStack(alignment: .leading, spacing: 12) {
            Button {
                // Keep the motion — this is the one transcript disclosure that
                // animates — but take the scroll anchor out of it. Growing the
                // card re-applies the transcript's bottom anchor on later
                // frames, outside this transaction, which walked the tapped
                // header out from under the finger mid-animation.
                var transaction = Transaction(
                    animation: reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0.02)
                )
                transaction.scrollContentOffsetAdjustmentBehavior = .disabled
                withTransaction(transaction) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: .center, spacing: 11) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(tint)
                        .frame(width: 38, height: 38)
                        .background(
                            tint.opacity(0.11),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 3) {
                        Text(countLabel)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        Text(isExpanded ? "Hide approved requests" : "Approved in sequence · Tap to view")
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            // Swap the caption rather than cross-fading it.
                            // Inside the expand animation the default
                            // dissolve held both strings on screen at once,
                            // at two different widths, so the header read as
                            // "Hide approved requests Tap to view" for a
                            // quarter of a second.
                            .contentTransition(.identity)
                    }

                    Spacer(minLength: 6)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(countLabel)
            .accessibilityHint(isExpanded ? "Double tap to hide the approved requests." : "Double tap to show the approved requests.")

            if isExpanded {
                VStack(spacing: 0) {
                    ForEach(approvals.indices, id: \.self) { index in
                        receiptRow(approvals[index])
                            .padding(.vertical, index == 0 ? 0 : 11)
                        if index < approvals.count - 1 {
                            Divider()
                                .overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.bubblePaper(for: colorScheme), in: shape)
        // The rows slide in from the card's top edge, so for the length of the
        // animation they exist above a frame that has not finished growing.
        // Without a clip they were drawn straight over the neighbouring
        // transcript cards — the receipts appeared on top of the message above
        // before the card opened underneath them. Clipping after the fill and
        // before the border keeps the stroke crisp on the final edge.
        .clipShape(shape)
        .overlay {
            shape.strokeBorder(tint.opacity(0.22), lineWidth: 0.8)
        }
    }

    private func receiptRow(_ approval: MessagePart) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(AssistantTheme.success(for: colorScheme))
                .frame(width: 18, height: 18)
                .background(
                    AssistantTheme.success(for: colorScheme).opacity(0.11),
                    in: Circle()
                )

            VStack(alignment: .leading, spacing: 3) {
                Text(approval.summary ?? "Approved request")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .lineLimit(2)
                Text("This request was approved.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }

            Spacer(minLength: 4)
            if let code = approval.shortCode, !code.isEmpty {
                Text(code)
                    .font(.caption2.monospaced().weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A day's low–high as a capsule placed within the whole forecast's range, so
/// warmer and cooler days read at a glance.
private struct WeatherRangeBar: View {
    let low: Double
    let high: Double
    let floor: Double
    let ceiling: Double
    let track: Color
    let fill: Color

    var body: some View {
        GeometryReader { proxy in
            let span = max(ceiling - floor, 1)
            let start = (low - floor) / span * proxy.size.width
            let width = max((high - low) / span * proxy.size.width, proxy.size.height)
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(fill).frame(width: width).offset(x: min(start, proxy.size.width - width))
            }
        }
        .frame(minWidth: 40)
        .accessibilityHidden(true)
    }
}
