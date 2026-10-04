import SwiftUI

/// Voice can capture a request, but only an explicit on-screen decision can
/// release a pending approval or budget gate. Suggestions do not stop a chat.
enum TalkInteractionPolicy {
    static func requiresManualDecision(messages: [ChatMessage], pendingApprovals: Int) -> Bool {
        pendingApprovals > 0 || messages.contains(where: \.hasPendingDecision)
    }

    static func decisionRoute(messages: [ChatMessage]) -> AssistantRoute {
        let latest = messages.last(where: \.hasPendingDecision)
        return latest?.decisionParts.contains(where: { $0.type == "budget-request" }) == true
            && latest?.decisionParts.contains(where: { $0.type == "approval" }) != true
            ? .activity : .approvals
    }
}

/// Hands-free. The conversation without the keyboard, the transcript, or the
/// phone in your hand.
///
/// The loop is the whole feature: listen, notice the owner has stopped, send,
/// read the reply aloud, listen again. Nothing here is new capability — it is
/// the same turn the composer sends, with the machinery of a chat app taken
/// away and the two ends of it, ears and voice, left facing each other.
///
/// The one thing talk mode deliberately cannot do is decide. An approval is
/// announced and the loop stops there: "yes" heard across a room is not
/// consent, and a misrecognition on an outward action is not recoverable the
/// way a mistyped message is.
struct TalkView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var listener = SpeechListener()
    @ObservedObject private var player = SpeechPlayer.shared

    @State private var phase: TalkPhase = .idle
    @State private var settleTask: Task<Void, Never>?
    @State private var lastSent = ""

    /// How long a pause means "your turn". Long enough to think mid-sentence,
    /// short enough that the assistant does not feel deaf.
    private static let settleSeconds: Double = 1.6

    enum TalkPhase: Equatable {
        case idle
        case listening
        case thinking
        case speaking
        case needsDecision
    }

    private var requiresManualDecision: Bool {
        TalkInteractionPolicy.requiresManualDecision(messages: model.messages, pendingApprovals: model.pendingApprovalCount)
    }

    var body: some View {
        ZStack {
            AssistantTheme.stage(for: colorScheme).ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer(minLength: 0)

                CompanionFaceView(
                    face: model.latestFace ?? .neutral,
                    phase: phase,
                    animates: !reduceMotion
                )
                .frame(width: 180, height: 180)

                Text(statusLine)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(AssistantTheme.stageSecondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(AssistantTheme.stageWell(for: colorScheme), in: Capsule())

                Text(spokenLine)
                    .font(.title3.weight(.medium))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(AssistantTheme.stageStrong)
                    .frame(maxWidth: 520)
                    .padding(.horizontal, 28)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: spokenLine)

                Spacer(minLength: 0)

                if phase == .needsDecision {
                    if requiresManualDecision {
                        Button("Review decision", systemImage: "hand.raised") {
                            Task {
                                await leave()
                                model.present(TalkInteractionPolicy.decisionRoute(messages: model.messages))
                            }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                        .accessibilityIdentifier("assistant.talk.review-decision")
                    } else {
                        Button("Resume conversation", systemImage: "microphone") { Task { await enter() } }
                            .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                    }
                }

                Button {
                    Task { await leave() }
                } label: {
                    Label("Done", systemImage: "keyboard")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(AssistantTheme.stageStrong)
                        .padding(.horizontal, 22)
                        .frame(height: 50)
                        .background(AssistantTheme.stageWell(for: colorScheme), in: Capsule())
                        .overlay { Capsule().strokeBorder(.white.opacity(0.22), lineWidth: 0.8) }
                }
                .buttonStyle(.plain)
                .padding(.bottom, 26)
                .accessibilityHint("Leaves talk mode and goes back to the conversation.")
            }
        }
        .task { await enter() }
        .onDisappear {
            phase = .idle
            settleTask?.cancel()
            // The session is torn down by `leave()`; this covers a swipe-away
            // that never reached the button.
            Task { await listener.stop() }
            model.speechAlwaysOn = false
            model.stopSpeaking()
        }
        .onChange(of: scenePhase) { _, phase in
            // Permission dialogs also make a scene inactive. Stop only when
            // this conversation actually leaves the foreground, and return to
            // chat so the microphone never silently reopens on the next visit.
            guard phase == .background else { return }
            Task { await leave() }
        }
        .onChange(of: requiresManualDecision) { _, needsDecision in
            guard needsDecision else { return }
            Task { await waitForDecision() }
        }
        .onChange(of: listener.transcript) { _, heard in
            heardSomething(heard)
        }
        .onChange(of: listener.state) { _, state in
            guard case let .unavailable(reason) = state else { return }
            model.errorMessage = reason
            Task { await leave() }
        }
        .onChange(of: model.isSending) { wasSending, isSending in
            // The turn is answered. Whatever it had to say is already queued
            // with the player; talk mode's job is to wait for it to finish.
            guard wasSending, !isSending, phase == .thinking else { return }
            if requiresManualDecision {
                Task { await waitForDecision() }
                return
            }
            phase = .speaking
            if player.speakingMessageID == nil {
                Task { await listen() }
                return
            }
            // Anything said while the model was thinking is the owner already
            // talking over the answer. Let it interrupt as usual.
            heardSomething(listener.transcript)
        }
        .onChange(of: player.speakingMessageID) { _, speaking in
            guard speaking == nil, phase == .speaking else { return }
            Task { await listen() }
        }
    }

    // MARK: - The loop

    @MainActor
    private func enter() async {
        guard scenePhase != .background else { return }
        guard !requiresManualDecision else {
            await waitForDecision()
            return
        }
        // Talk mode speaks every reply whether or not the setting is on: it is
        // the only thing here that can answer.
        model.speechAlwaysOn = true
        phase = .listening
        // The microphone stays open for as long as this screen is up, rather
        // than opening and closing around each turn. A conversation is not a
        // sequence of recordings, the audio session stops being handed back and
        // forth mid-sentence, and the ring says plainly that it is listening.
        await listener.start(cancellingEcho: true)
    }

    @MainActor
    private func leave() async {
        settleTask?.cancel()
        phase = .idle
        model.speechAlwaysOn = false
        await listener.stop()
        model.stopSpeaking()
        dismiss()
    }

    @MainActor
    private func waitForDecision() async {
        guard phase != .needsDecision else { return }
        phase = .needsDecision
        settleTask?.cancel()
        model.speechAlwaysOn = false
        model.stopSpeaking()
        await listener.stop()
        guard phase == .needsDecision, scenePhase != .background else { return }
        SpeechPlayer.shared.speak(["There’s a decision waiting for you. Open it on screen to review the next step."], for: "talk-decision")
    }

    /// Back to the owner's turn, with the tail of whatever leaked through the
    /// echo canceller cleared out.
    @MainActor
    private func listen() async {
        // A completion callback may have queued this before the owner left or
        // before a new turn began. It cannot restart an obsolete listening phase.
        guard scenePhase != .background, phase == .speaking || phase == .listening else { return }
        guard !requiresManualDecision else {
            await waitForDecision()
            return
        }
        phase = .listening
        listener.reset()
        await listener.start(cancellingEcho: true)
    }

    /// Something was heard. While the assistant is talking that is an
    /// interruption; while it is the owner's turn it restarts the clock on the
    /// pause that ends it.
    @MainActor
    private func heardSomething(_ heard: String) {
        let words = heard.split(separator: " ").count
        guard words > 0 else { return }

        if phase == .speaking {
            // Two words, not one: echo cancellation is good but the assistant's
            // own voice should never be able to interrupt the assistant.
            guard words >= 2 else { return }
            SpeechPlayer.shared.stop()
            phase = .listening
        }
        guard phase == .listening else { return }

        settleTask?.cancel()
        settleTask = Task {
            try? await Task.sleep(for: .seconds(TalkView.settleSeconds))
            guard !Task.isCancelled else { return }
            await submit()
        }
    }

    @MainActor
    private func submit() async {
        let text = listener.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, phase == .listening, !model.isSending, !requiresManualDecision else { return }

        lastSent = text
        phase = .thinking
        listener.reset()
        model.send(text, spoken: true)
    }

    // MARK: - Words on screen

    private var statusLine: String {
        switch phase {
        case .idle: "Talk"
        case .listening: listener.isListening ? "Listening" : "Starting"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .needsDecision: requiresManualDecision ? "Your decision is needed" : "Ready to talk"
        }
    }

    /// One line, whichever side of the conversation is mid-sentence. The
    /// transcript is behind this screen, not on it.
    private var spokenLine: String {
        switch phase {
        case .idle:
            return ""
        case .listening:
            let heard = listener.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            return heard.isEmpty ? "Say something." : heard
        case .thinking:
            return lastSent
        case .speaking:
            return model.messages.last { $0.role == .assistant }?.text ?? ""
        case .needsDecision:
            guard requiresManualDecision else { return "The decision is resolved. Resume when you’re ready." }
            let decision = model.messages.last(where: \.hasPendingDecision)
            return decision?.approvalSummary?.purpose
                ?? decision?.decisionParts.first(where: { $0.status == nil || $0.status == "pending" })?.summary
                ?? model.overview?.approvals.pending.first?.approval.summary
                ?? "Review the next step on screen before the assistant continues."
        }
    }
}

/// The companion, drawn.
///
/// The runtime has been sending a `[face:]` cue with every reply since the
/// dashboard shipped, and the phone has decoded it into `CompanionFace` and
/// done nothing with it. On a screen with no transcript, that cue is the only
/// thing left with any expression in it.
private struct CompanionFaceView: View {
    let face: CompanionFace
    let phase: TalkView.TalkPhase
    let animates: Bool

    var body: some View {
        ZStack {
            // The ring is the microphone: it breathes while listening, holds
            // while thinking, and pulses on the beat of speech.
            Circle()
                .strokeBorder(AssistantTheme.accentLight.opacity(ringOpacity), lineWidth: 2)
                .scaleEffect(ringScale)
                .animation(ringAnimation, value: phase)

            Circle()
                .fill(AssistantTheme.accent.opacity(0.22))
                .padding(18)

            face.symbol
                .font(.system(size: 64, weight: .light))
                .foregroundStyle(AssistantTheme.stageStrong)
                .contentTransition(.symbolEffect(.replace))
        }
        .accessibilityHidden(true)
    }

    /// Spelled out rather than nested inline: a conditional animation built
    /// from two ternaries and an implicit member lookup is the shape that sends
    /// the SwiftUI type checker away for minutes at a time.
    private var ringAnimation: Animation? {
        guard animates, phase != .idle else { return nil }
        let beat: Double = phase == .speaking ? 0.5 : 1.8
        let breathe: Animation = .easeInOut(duration: beat)
        return breathe.repeatForever(autoreverses: true)
    }

    private var ringOpacity: Double {
        switch phase {
        case .idle: 0.2
        case .listening: 0.75
        case .thinking: 0.4
        case .speaking: 0.9
        case .needsDecision: 0.4
        }
    }

    private var ringScale: CGFloat {
        guard animates else { return 1 }
        return phase == .listening || phase == .speaking ? 1.04 : 1
    }
}

private extension CompanionFace {
    /// A face is a shape, and SF Symbols already carries a set of them that
    /// reads at a glance and follows Dynamic Type and contrast for free.
    var symbol: Image {
        switch self {
        case .neutral: Image(systemName: "circle.dotted")
        case .warmSmile: Image(systemName: "sun.max")
        case .happySquint: Image(systemName: "sparkles")
        case .curiousBlink: Image(systemName: "questionmark.circle")
        case .thoughtfulTilt: Image(systemName: "cloud")
        case .wideExcited: Image(systemName: "star")
        case .gentleNod: Image(systemName: "checkmark.circle")
        case .focused: Image(systemName: "scope")
        }
    }
}

#if DEBUG
extension TalkView {
    @MainActor static func visualReviewPaused() -> AnyView {
        var view = TalkView()
        view._phase = State(initialValue: .needsDecision)
        // Fixture review never requests the microphone or speaks to the room.
        return AnyView(view.environment(\.scenePhase, .background))
    }
}
#endif
