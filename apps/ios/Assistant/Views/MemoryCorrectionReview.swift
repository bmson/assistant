import SwiftUI

/// Shared review surface; the mounted host supplies the qualified adapter and retention acknowledgment.
struct MemoryCorrectionReview: View {
    @Binding var presentation: MemoryCorrectionPresentation
    let onIntent: (MemoryCorrectionIntent) -> Void
    var retentionText: String? = nil
    var cleanupText: String? = nil

    var body: some View {
        AssistantForm {
            Section("Note when you opened this editor") {
                Text(presentation.openedSnapshot.content)
                    .textSelection(.enabled)
                Text(presentation.openedSnapshot.sourceLabel.isEmpty ? "Source details unavailable." : presentation.openedSnapshot.sourceLabel)
                    .font(.footnote).foregroundStyle(.secondary)
                Text("Your correction changes this saved note. It does not change the original email or document.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let current = presentation.currentSnapshot {
                Section("Current saved note") {
                    Text(current.content).textSelection(.enabled)
                    if presentation.canReviewCurrent {
                        Button("I reviewed the saved note — keep my draft") {
                            presentation.reviewCurrentKeepingDraft()
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, minimumHeight: 48))
                    }
                }
            }
            Section("Your corrected note") {
                if presentation.canEditDraft {
                    TextField("Your corrected note", text: Binding(
                        get: { presentation.draft },
                        set: { presentation.editDraft($0) }
                    ), axis: .vertical)
                    .lineLimit(3...8)
                } else {
                    Text(presentation.draft).textSelection(.enabled)
                }
            }
            if let status = presentation.statusText {
                Section {
                    Text(status)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("memory-correction-status")
                    if [.unknown, .pending].contains(presentation.phase) {
                        Button(presentation.isChecking ? "Checking result…" : "Check result") {
                            if let intent = presentation.checkResult() { onIntent(intent) }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, minimumHeight: 48))
                        .disabled(!presentation.canCheckResult)
                    }
                    if presentation.canRefreshSavedNote {
                        Button("Refresh saved note") {
                            if let intent = presentation.requestRefresh() { onIntent(intent) }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, minimumHeight: 48))
                    }
                    if [.submitting, .pending, .unknown].contains(presentation.phase) {
                        Text("Closing does not cancel the save. Check its result before saving again.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            if let retentionText { Section { Text(retentionText).font(.footnote).foregroundStyle(.secondary) } }
            if let cleanupText { Section { Text(cleanupText).font(.footnote).foregroundStyle(.secondary) } }
        }
        .navigationTitle("Edit saved note")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(presentation.hasDispatchedSave ? "Close" : "Cancel") {
                    if presentation.hasDispatchedSave { onIntent(presentation.close()) }
                    else if let intent = presentation.cancelBeforeDispatch() { onIntent(intent) }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if [.editing, .unavailable, .authorizing, .submitting].contains(presentation.phase) {
                    Button(presentation.phase == .submitting ? "Saving…" : "Save correction") {
                        if let intent = presentation.requestSave() { onIntent(intent) }
                    }
                    .disabled(!presentation.canRequestAuthorization)
                }
            }
        }
    }
}

#if DEBUG
/// Existing-style, provider-free layout inputs. No mounted routes, server grants, or durable state.
enum MemoryCorrectionLayoutFixtures {
    enum Scenario: CaseIterable { case draft, submitting, confirmed, unknown, stale }

    static func state(_ scenario: Scenario) -> MemoryCorrectionPresentation {
        let target = MemoryCorrectionTarget(ownerID: "fixture-owner", serverID: "fixture-server", memoryID: "fixture-note", sourceIdentity: "fixture-source")
        let snapshot = MemoryCorrectionSnapshot(target: target, revision: "fixture-r1", storedContentHash: "fixture-stored-hash", content: "The household trip starts on Friday.", sourceLabel: "Saved from a fictional planning conversation", availability: .mayRequestAuthorization)
        var state = MemoryCorrectionPresentation(snapshot: snapshot)
        state.editDraft("The household trip starts on Saturday.")
        guard scenario != .draft, case .requestAuthorization(let request) = state.requestSave() else { return state }
        let issued = MemoryCorrectionOperation(operationID: "fixture-server-operation", target: target, expectedRevision: snapshot.revision, expectedStoredContentHash: snapshot.storedContentHash)
        _ = state.receiveAuthorization(for: request, result: .authorized(issued))
        let current = MemoryCorrectionSnapshot(target: target, revision: "fixture-r2", storedContentHash: "fixture-next-hash", content: "The household trip starts next week.", sourceLabel: snapshot.sourceLabel, availability: .mayRequestAuthorization)
        switch scenario {
        case .unknown: state.receiveOutcome(presentationID: state.presentationID, operation: issued, version: 1, disposition: .uncertain)
        case .stale: state.receiveOutcome(presentationID: state.presentationID, operation: issued, version: 1, disposition: .staleNoWrite(current))
        case .confirmed: state.receiveOutcome(presentationID: state.presentationID, operation: issued, version: 1, disposition: .saved(readback: nil))
        default: break
        }
        return state
    }
}
#endif


/// Ordinary existing-note route. No locally displayed row is treated as authorization.
struct NativeMemoryCorrectionHost: View {
    let memoryID: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NativeMemoryCorrectionScreen(consumer: model.memoryCorrections, memoryID: memoryID,
            onOpen: { await model.openNativeMemoryCorrection(memoryID: memoryID) }, onClose: { dismiss() })
    }
}

/// Shared mounted consumer surface, injectable for hosted transport/retention tests.
struct NativeMemoryCorrectionScreen: View {
    let consumer: NativeMemoryCorrectionConsumer
    let memoryID: String
    let onOpen: @MainActor () async -> Void
    let onClose: @MainActor () -> Void
    @State private var mountedPresentationID: UUID?
    var body: some View {
        Group {
            if let state = consumer.presentation, state.reviewedSnapshot.target.memoryID == memoryID {
                MemoryCorrectionReview(presentation: Binding(
                    get: {
                        guard let current = consumer.presentation, current.presentationID == state.presentationID else { return state }
                        return current
                    },
                    set: { consumer.updatePresentation($0) }
                ), onIntent: { intent in
                    guard consumer.presentation?.presentationID == state.presentationID else { return }
                    if case .close = intent { consumer.close(); onClose() }
                    else { Task { await consumer.handle(intent) } }
                }, retentionText: retention(state), cleanupText: consumer.cleanupMessage)
            } else {
                AssistantForm {
                    Section {
                        if consumer.loading { ProgressView("Loading saved note…") }
                        else { Text(consumer.errorMessage ?? "This saved note is unavailable.") }
                    }
                }
                .navigationTitle("Edit saved note")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { onClose() } } }
            }
        }
        .task(id: memoryID) {
            await onOpen()
            if consumer.presentation?.reviewedSnapshot.target.memoryID == memoryID {
                mountedPresentationID = consumer.presentation?.presentationID
            }
        }
        .onDisappear {
            if consumer.presentation?.presentationID == mountedPresentationID,
               consumer.presentation?.reviewedSnapshot.target.memoryID == memoryID { consumer.close() }
        }
    }
    private func retention(_ state: MemoryCorrectionPresentation) -> String? {
        if consumer.retainedOnDevice && state.hasDispatchedSave {
            return "Your draft is kept on this device. Closing does not cancel the save."
        }
        if [.editing, .authorizing, .stale, .unavailable].contains(state.phase), !state.draft.isEmpty {
            return "Your draft is kept on this screen. Leaving the app may lose it."
        }
        return nil
    }
}
