import SwiftUI

/// Isolated presentation fixture. No current editor entry point mounts this view.
struct MemoryCorrectionReview: View {
    @Binding var presentation: MemoryCorrectionPresentation
    let onIntent: (MemoryCorrectionIntent) -> Void

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
                    if presentation.phase == .unknown {
                        Button(presentation.isChecking ? "Checking result…" : "Check result") {
                            if let intent = presentation.checkResult() { onIntent(intent) }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, minimumHeight: 48))
                        .disabled(!presentation.canCheckResult)
                    }
                    if presentation.phase == .stale || (presentation.phase == .saved && presentation.resultReadback == nil) {
                        Button("Refresh saved note") {
                            if let intent = presentation.requestRefresh() { onIntent(intent) }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, minimumHeight: 48))
                    }
                    if presentation.phase == .submitting || presentation.phase == .unknown {
                        Text("Closing does not cancel the save. Check its result before saving again.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Correct memory")
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
