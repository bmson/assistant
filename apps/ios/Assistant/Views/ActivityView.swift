import Observation
import SwiftUI

private enum ActivityFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case needsYou = "Needs you"
    case working = "Working"
    case scheduled = "Scheduled"
    case completed = "Done"
    var id: Self { self }
    var requestValue: String {
        switch self { case .all: "all"; case .needsYou: "needs-you"; case .working: "working"; case .scheduled: "scheduled"; case .completed: "completed" }
    }
}

struct ChecklistCorrectionRequestContext: Sendable {
    let ownerID: String
    let connectionVersion: Int
    let client: APIClient
}

enum ChecklistCorrectionLoadState: Equatable {
    case loading
    case ready
    case unavailable
}

private enum ChecklistCorrectionRequestKind {
    case load
    case correction
    case cancellation
}

struct ChecklistCancellationSelection: Sendable, Equatable, Identifiable {
    let itemID: String
    let label: String
    let checklistRevision: Int
    let cancellationRevision: Int
    var id: String { "\(itemID):\(checklistRevision):\(cancellationRevision)" }
}

struct ChecklistActivityRequestItem: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let status: String
    let canChangeLookup: Bool
    let canCancel: Bool
}

@MainActor
@Observable
final class ChecklistCorrectionController {
    let ownerID: String
    let taskID: String
    let connectionVersion: Int
    private(set) var projection: ChecklistCorrectionProjection?
    private(set) var loadState: ChecklistCorrectionLoadState = .loading
    private(set) var selectedItemID: String?
    private(set) var operationID: String?
    private(set) var submission: ChecklistCorrectionSubmission?
    private(set) var selectedCancellationItemID: String?
    private(set) var cancellationTargetLabel: String?
    private(set) var cancellationOperationID: String?
    private(set) var cancellationSubmission: ChecklistCorrectionSubmission?
    private(set) var isWorking = false
    var draft = ""
    @ObservationIgnored private var cancellationChecklistRevision: Int?
    @ObservationIgnored private var cancellationRevision: Int?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let connectionIsCurrent: @MainActor () -> Bool
    @ObservationIgnored private let operationIDFactory: () -> String
    @ObservationIgnored private var active = true
    @ObservationIgnored private var taskIsEligible = true
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var requestTask: Task<Void, Never>?
    @ObservationIgnored private var activeRequestKind: ChecklistCorrectionRequestKind?

    init(
        context: ChecklistCorrectionRequestContext,
        taskID: String,
        connectionIsCurrent: @escaping @MainActor () -> Bool,
        operationIDFactory: @escaping () -> String = { UUID().uuidString.lowercased() }
    ) {
        ownerID = context.ownerID
        connectionVersion = context.connectionVersion
        client = context.client
        self.taskID = taskID
        self.connectionIsCurrent = connectionIsCurrent
        self.operationIDFactory = operationIDFactory
    }

    var selectedItem: ChecklistCorrectionItem? {
        projection?.items.first(where: { $0.id == selectedItemID })
    }

    var cancellableItems: [ChecklistCancellableItem] { projection?.cancellableItems ?? [] }
    var canCancelItems: Bool { projection?.canCancelItems == true && !cancellableItems.isEmpty }

    var requestItems: [ChecklistActivityRequestItem] {
        let lookups = Dictionary(uniqueKeysWithValues: (projection?.items ?? []).map { ($0.id, $0) })
        var seen = Set<String>()
        var rows = cancellableItems.map { item in
            seen.insert(item.id)
            return ChecklistActivityRequestItem(
                id: item.id,
                label: item.label,
                status: item.status,
                canChangeLookup: lookups[item.id] != nil,
                canCancel: projection?.canCancelItems == true
            )
        }
        rows.append(contentsOf: (projection?.items ?? []).compactMap { item in
            guard seen.insert(item.id).inserted else { return nil }
            return ChecklistActivityRequestItem(
                id: item.id,
                label: item.label,
                status: "pending",
                canChangeLookup: true,
                canCancel: false
            )
        })
        return rows
    }

    var selectedCancellationItem: ChecklistCancellableItem? {
        cancellableItems.first(where: { $0.id == selectedCancellationItemID })
    }

    func selectLookupItem(id: String) {
        guard let item = projection?.items.first(where: { $0.id == id }) else { return }
        select(item)
    }

    var canPublishResult: Bool { isCurrent }

    func load() async {
        guard isCurrent, !isWorking, submission != .uncertain,
              cancellationSubmission != .uncertain else { return }
        let requestGeneration = UUID()
        generation = requestGeneration
        isWorking = true
        activeRequestKind = .load
        requestTask = Task {
            do {
                let loaded = try await client.checklistCorrectionProjection(taskID: taskID)
                guard isCurrent, generation == requestGeneration else { return }
                guard loaded.isValid(for: taskID) else { throw APIError.invalidResponse }
                projection = loaded
                loadState = .ready
                if let selectedItemID, !loaded.items.contains(where: { $0.id == selectedItemID }) {
                    self.selectedItemID = nil
                    draft = ""
                    operationID = nil
                    submission = nil
                }
                let selectedCancellationStillExists = loaded.cancellableItems?.contains(
                    where: { $0.id == selectedCancellationItemID }
                ) ?? false
                if let selectedCancellationItemID,
                   !selectedCancellationStillExists,
                   cancellationSubmission != .uncertain,
                   cancellationSubmission != .confirmed {
                    self.selectedCancellationItemID = nil
                    cancellationOperationID = nil
                    cancellationSubmission = nil
                    cancellationChecklistRevision = nil
                    cancellationRevision = nil
                }
            } catch {
                guard isCurrent, generation == requestGeneration else { return }
                loadState = .unavailable
            }
            guard isCurrent, generation == requestGeneration else { return }
            isWorking = false
            requestTask = nil
            activeRequestKind = nil
        }
        await requestTask?.value
    }

    func select(_ item: ChecklistCorrectionItem) {
        guard isCurrent, !isWorking, submission != .uncertain, submission != .confirmed,
              cancellationSubmission != .uncertain,
              projection?.items.contains(item) == true else { return }
        guard selectedItemID != item.id else { return }
        selectedItemID = item.id
        draft = ""
        operationID = nil
        submission = nil
    }

    @discardableResult
    func selectCancellationItem(_ item: ChecklistCancellableItem) -> Bool {
        guard isCurrent, !isWorking, cancellationSubmission != .uncertain,
              submission != .uncertain,
              cancellableItems.contains(item) else { return false }
        if selectedCancellationItemID == item.id, cancellationSubmission != .rejected { return true }
        selectedCancellationItemID = item.id
        cancellationTargetLabel = item.label
        cancellationOperationID = nil
        cancellationSubmission = nil
        cancellationChecklistRevision = nil
        cancellationRevision = nil
        return true
    }

    func updateDraft(_ value: String) {
        guard isCurrent, !isWorking, submission != .uncertain, submission != .confirmed,
              cancellationSubmission != .uncertain else { return }
        var bounded = ""
        for character in value {
            let next = bounded + String(character)
            guard next.utf16.count <= 500 else { break }
            bounded = next
        }
        if submission == .rejected, bounded != draft {
            operationID = nil
            submission = nil
        }
        draft = bounded
    }

    func submit() async -> ChecklistCorrectionSubmission? {
        guard isCurrent, !isWorking, let item = selectedItem,
              cancellationSubmission != .uncertain,
              submission != .confirmed,
              projection?.eligible == true, let revision = projection?.revision,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              draft.trimmingCharacters(in: .whitespacesAndNewlines) == draft else { return nil }
        let operationID = self.operationID ?? operationIDFactory()
        self.operationID = operationID
        isWorking = true
        submission = nil
        activeRequestKind = .correction
        let requestGeneration = UUID()
        generation = requestGeneration
        requestTask = Task {
            let result = await client.correctChecklistItem(
                taskID: taskID,
                itemID: item.id,
                expectedRevision: revision,
                ownerMessageID: operationID,
                replacementLabel: draft
            )
            guard isCurrent, generation == requestGeneration else { return }
            submission = result
            if result == .confirmed { loadState = .ready }
            isWorking = false
            requestTask = nil
            activeRequestKind = nil
        }
        await requestTask?.value
        return submission
    }

    func checkStatus() async -> ChecklistCorrectionSubmission? {
        guard isCurrent, !isWorking, let item = selectedItem,
              cancellationSubmission != .uncertain,
              let revision = projection?.revision, let operationID else { return nil }
        isWorking = true
        activeRequestKind = .correction
        let requestGeneration = UUID()
        generation = requestGeneration
        requestTask = Task {
            let result = await client.checkChecklistCorrection(
                taskID: taskID,
                itemID: item.id,
                expectedRevision: revision,
                ownerMessageID: operationID,
                replacementLabel: draft
            )
            guard isCurrent, generation == requestGeneration else { return }
            submission = result
            isWorking = false
            requestTask = nil
            activeRequestKind = nil
        }
        await requestTask?.value
        return submission
    }

    func cancelSelectedItem(
        selection: ChecklistCancellationSelection? = nil
    ) async -> ChecklistCorrectionSubmission? {
        guard isCurrent, !isWorking, submission != .uncertain,
              let item = selectedCancellationItem,
              projection?.canCancelItems == true,
              let currentChecklistRevision = projection?.cancellationChecklistRevision,
              let currentCancellationRevision = projection?.cancellationRevision,
              cancellationSubmission != .confirmed else { return nil }
        if let selection {
            guard selection.itemID == item.id, selection.label == item.label,
                  selection.checklistRevision == currentChecklistRevision,
                  selection.cancellationRevision == currentCancellationRevision else { return nil }
        }

        let operationID: String
        if let existing = cancellationOperationID,
           cancellationChecklistRevision == currentChecklistRevision,
           cancellationRevision == currentCancellationRevision {
            operationID = existing
        } else {
            operationID = operationIDFactory()
            cancellationOperationID = operationID
            cancellationChecklistRevision = currentChecklistRevision
            cancellationRevision = currentCancellationRevision
        }
        guard let expectedChecklistRevision = cancellationChecklistRevision,
              let expectedCancellationRevision = cancellationRevision else { return nil }
        isWorking = true
        cancellationSubmission = nil
        activeRequestKind = .cancellation
        let requestGeneration = UUID()
        generation = requestGeneration
        requestTask = Task {
            let result = await client.cancelChecklistItem(
                taskID: taskID,
                itemID: item.id,
                expectedRevision: expectedChecklistRevision,
                expectedCancellationRevision: expectedCancellationRevision,
                ownerMessageID: operationID,
                itemLabel: item.label
            )
            guard isCurrent, generation == requestGeneration else { return }
            cancellationSubmission = result
            if result == .rejected {
                cancellationOperationID = nil
                cancellationChecklistRevision = nil
                cancellationRevision = nil
            }
            isWorking = false
            requestTask = nil
            activeRequestKind = nil
        }
        await requestTask?.value
        return cancellationSubmission
    }

    func checkCancellationStatus() async -> ChecklistCorrectionSubmission? {
        guard isCurrent, !isWorking, submission != .uncertain,
              let item = selectedCancellationItem,
              let cancellationOperationID,
              let cancellationChecklistRevision,
              let cancellationRevision,
              let cancellationTargetLabel else { return nil }
        isWorking = true
        activeRequestKind = .cancellation
        let requestGeneration = UUID()
        generation = requestGeneration
        requestTask = Task {
            let result = await client.checkChecklistCancellation(
                taskID: taskID,
                itemID: item.id,
                expectedRevision: cancellationChecklistRevision,
                expectedCancellationRevision: cancellationRevision,
                ownerMessageID: cancellationOperationID,
                itemLabel: cancellationTargetLabel
            )
            guard isCurrent, generation == requestGeneration else { return }
            cancellationSubmission = result
            isWorking = false
            requestTask = nil
            activeRequestKind = nil
        }
        await requestTask?.value
        return cancellationSubmission
    }

    func cancelInFlight() {
        generation = UUID()
        requestTask?.cancel()
        requestTask = nil
        if isWorking {
            switch activeRequestKind {
            case .some(.correction):
                if operationID != nil { submission = .uncertain }
            case .some(.cancellation):
                if cancellationOperationID != nil { cancellationSubmission = .uncertain }
            case .some(.load), .none:
                loadState = .unavailable
            }
        }
        activeRequestKind = nil
        isWorking = false
    }

    func updateTaskEligibility(_ eligible: Bool) {
        guard active, taskIsEligible != eligible else { return }
        taskIsEligible = eligible
        if !eligible { cancelInFlight() }
    }

    func dispose() {
        guard active else { return }
        active = false
        cancelInFlight()
        projection = nil
        selectedItemID = nil
        draft = ""
        operationID = nil
        submission = nil
        selectedCancellationItemID = nil
        cancellationTargetLabel = nil
        cancellationOperationID = nil
        cancellationSubmission = nil
        cancellationChecklistRevision = nil
        cancellationRevision = nil
        loadState = .loading
    }

    private var isCurrent: Bool {
        active && taskIsEligible && connectionIsCurrent()
    }
}

struct ChecklistCorrectionSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Bindable var controller: ChecklistCorrectionController
    let onSaved: () async -> Void
    @State private var cancellationConfirmation: ChecklistCancellationSelection?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Saved request")
                .font(.headline)
            switch controller.loadState {
            case .loading:
                ProgressView("Loading request items…")
                    .font(.subheadline)
            case .unavailable:
                Text("Request items aren’t available right now. Try again.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                button("Try again", identifier: "checklist-correction-load") {
                    await controller.load()
                }
            case .ready:
                if controller.projection?.eligible != true && !controller.canCancelItems {
                    Text("No lookup can be changed right now.")
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                if !controller.requestItems.isEmpty {
                    lookupItems
                }
                if controller.projection?.eligible == true,
                   let selected = controller.selectedItem {
                    Text("Current lookup: \(selected.label)")
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Replacement lookup")
                        .font(.subheadline.weight(.medium))
                    TextEditor(text: Binding(
                        get: { controller.draft },
                        set: { controller.updateDraft($0) }
                    ))
                    .frame(minHeight: 88)
                    .overlay(alignment: .topLeading) {
                        if controller.draft.isEmpty {
                            Text("Describe the new lookup")
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }
                    .padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.secondary.opacity(0.35)))
                    .accessibilityLabel("Replacement lookup")
                    .accessibilityIdentifier("checklist-correction-draft")
                    Text("\(controller.draft.utf16.count)/500")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    if controller.submission == .uncertain {
                        Text("I couldn’t confirm whether this change was saved. Your text is still here.")
                            .font(.subheadline)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        button("Check status", identifier: "checklist-correction-check-status") {
                            if await controller.checkStatus() == .confirmed,
                               controller.canPublishResult { await onSaved() }
                        }
                        button("Try the same change again", identifier: "checklist-correction-retry") {
                            if await controller.submit() == .confirmed,
                               controller.canPublishResult { await onSaved() }
                        }
                    } else if controller.submission == .rejected {
                        Text("This lookup can’t be changed right now. Review Activity before trying again.")
                            .font(.subheadline)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        button("Try again", identifier: "checklist-correction-retry") {
                            if await controller.submit() == .confirmed,
                               controller.canPublishResult { await onSaved() }
                        }
                    } else if controller.submission == .confirmed {
                        Text("Lookup change saved.")
                            .font(.subheadline)
                            .foregroundStyle(AssistantTheme.success(for: colorScheme))
                    } else {
                        button("Save lookup change", identifier: "checklist-correction-save") {
                            if await controller.submit() == .confirmed,
                               controller.canPublishResult { await onSaved() }
                        }
                        .disabled((3...500).contains(
                            controller.draft.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
                        ) == false)
                    }
                }
                if let label = controller.cancellationTargetLabel,
                   controller.cancellationSubmission == .confirmed,
                   controller.selectedCancellationItem == nil {
                    Text("Cancelled “\(label)”.")
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.success(for: colorScheme))
                }
            }
            if controller.isWorking { ProgressView() }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
        .accessibilityIdentifier("checklist-correction-section-\(controller.taskID)")
        .confirmationDialog(
            "Cancel this item?",
            isPresented: Binding(
                get: { cancellationConfirmation != nil },
                set: { if !$0 { cancellationConfirmation = nil } }
            ),
            titleVisibility: .visible,
            presenting: cancellationConfirmation
        ) { selection in
            Button("Cancel item", role: .destructive) {
                Task { await performCancellation(selection: selection) }
            }
        } message: { item in
            Text("Cancel “\(item.label)” from this request? Other items stay in the request.")
        }
    }

    private func performCancellation(selection: ChecklistCancellationSelection) async {
        guard await controller.cancelSelectedItem(selection: selection) == .confirmed,
              controller.canPublishResult else { return }
        await refreshAfterCancellation()
    }

    private func refreshAfterCancellation() async {
        await controller.load()
        guard controller.canPublishResult else { return }
        await onSaved()
    }

    private var lookupItems: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(controller.requestItems) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.label)
                        .font(.body)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(item.status == "blocked" ? "Blocked" : "Pending")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    requestActions(for: item)
                    if controller.selectedCancellationItemID == item.id {
                        cancellationStatus
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    controller.selectedItemID == item.id || controller.selectedCancellationItemID == item.id
                        ? AssistantTheme.accent(for: colorScheme).opacity(0.12)
                        : Color.clear,
                    in: RoundedRectangle(cornerRadius: 10)
                )
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(.secondary.opacity(0.3)))
            }
        }
    }

    @ViewBuilder
    private var cancellationStatus: some View {
        if controller.cancellationSubmission == .uncertain {
            Text("I couldn’t confirm whether this item was cancelled. It remains listed until confirmed.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            button("Check cancellation status", identifier: "checklist-cancel-check-status") {
                if await controller.checkCancellationStatus() == .confirmed,
                   controller.canPublishResult { await refreshAfterCancellation() }
            }
            button("Try the same cancellation again", identifier: "checklist-cancel-retry") {
                if await controller.cancelSelectedItem() == .confirmed,
                   controller.canPublishResult { await refreshAfterCancellation() }
            }
        } else if controller.cancellationSubmission == .rejected {
            Text("This item could not be cancelled. Review Activity before trying again.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        } else if controller.cancellationSubmission == .confirmed {
            Text("Cancellation saved.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.success(for: colorScheme))
        }
    }

    @ViewBuilder
    private func requestActions(for item: ChecklistActivityRequestItem) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { requestActionButtons(for: item) }
            VStack(alignment: .leading, spacing: 4) { requestActionButtons(for: item) }
        }
    }

    @ViewBuilder
    private func requestActionButtons(for item: ChecklistActivityRequestItem) -> some View {
        if item.canChangeLookup {
            Button("Change lookup") { controller.selectLookupItem(id: item.id) }
                .frame(minHeight: 44)
                .disabled(controller.isWorking || controller.submission == .uncertain || controller.cancellationSubmission == .uncertain)
                .accessibilityIdentifier("checklist-correction-item-\(item.id)")
        }
        if item.canCancel {
            Button("Cancel item", role: .destructive) {
                guard let cancellable = controller.cancellableItems.first(where: { $0.id == item.id }),
                      controller.selectCancellationItem(cancellable),
                      let checklistRevision = controller.projection?.cancellationChecklistRevision,
                      let cancellationRevision = controller.projection?.cancellationRevision else { return }
                cancellationConfirmation = ChecklistCancellationSelection(
                    itemID: item.id,
                    label: item.label,
                    checklistRevision: checklistRevision,
                    cancellationRevision: cancellationRevision
                )
            }
            .frame(minHeight: 44)
            .disabled(controller.isWorking || controller.cancellationSubmission == .uncertain || controller.submission == .uncertain)
            .accessibilityIdentifier("checklist-cancel-item-\(item.id)")
        }
    }

    private func button(
        _ title: String,
        identifier: String,
        action: @escaping () async -> Void
    ) -> some View {
        Button(title) { Task { await action() } }
            .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: false))
            .frame(minHeight: 44)
            .accessibilityIdentifier(identifier)
    }
}

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @FocusState private var discoverySearchFocused: Bool
    @State private var filter: ActivityFilter = .all
    @State private var showingArchived = false
    @State private var activityActionInFlight: String?
    @State private var archiveProgress: ArchiveOldActivityProgress?
    @State private var budgetItem: ActivityItem?
    @State private var itemPendingCancellation: ActivityItem?
    @State private var budgetText = ""
    @State private var discoveryQuery = ""
    @State private var discovery: ActivityList?
    @State private var discoveryInFlight = false
    @State private var discoveryGeneration = UUID()
    @State private var discoveryTask: Task<Void, Never>?
    @State private var activityStatuses: [String: ActivityStatusResponse] = [:]
    @State private var activityStatusAvailability = ActivityStatusAvailability()
    @State private var statusRefreshOffset = 0
    @State private var securityReviewController: SecurityReviewController?
    @State private var checklistCorrectionControllers: [String: ChecklistCorrectionController] = [:]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                filterControl
                ActivityDiscoverySearchRow(
                    query: $discoveryQuery,
                    isFocused: $discoverySearchFocused,
                    isLoading: discoveryInFlight,
                    onSubmit: { loadDiscovery(reset: true) }
                )
                if let archiveProgress, !archiveProgress.complete {
                    Label(
                        "Archived \(archiveProgress.archivedTotal) older tasks. Continue to process the next batch.",
                        systemImage: "archivebox"
                    )
                    .font(.footnote)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityIdentifier("activity-archive-progress")
                }
                if !items.isEmpty { activitySummary }

                if discovery == nil && (showingArchived ? model.archivedActivity == nil : model.overview == nil) {
                    AssistantLoadingState(title: "Loading activity…")
                } else if filteredItems.isEmpty {
                    AssistantEmptyState(
                        discovery != nil ? "No matches in these records" : (filter == .all ? "No activity yet" : "Nothing here"),
                        systemImage: "waveform.path.ecg",
                        description: discovery != nil
                            ? "Continue to older records if available, or change the filters. Legacy records without creation times cannot match date filters."
                            : filter == .all
                            ? "Work you hand off in chat will appear here with its evidence and decisions."
                            : "Try another activity filter."
                    )
                } else if isLandscape {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: AssistantTheme.cardStackSpacing),
                            GridItem(.flexible(), spacing: AssistantTheme.cardStackSpacing),
                        ],
                        spacing: AssistantTheme.cardStackSpacing
                    ) {
                        ForEach(filteredItems) { item in
                            activityCard(item)
                        }
                    }
                } else {
                    LazyVStack(spacing: AssistantTheme.cardStackSpacing) {
                        ForEach(filteredItems) { item in
                            activityCard(item)
                        }
                    }
                }
                if showsSecurityReviews, let securityReviewController {
                    SecurityReviewSection(controller: securityReviewController)
                }
                if let discovery {
                    Text(discovery.searchIncomplete == true
                         ? "More records remain. Continue searching before concluding that a task is absent."
                         : "Reached the end of this search.")
                        .font(.footnote).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    Text("Detailed audit evidence may be unavailable or redacted. Legacy records without creation times cannot match date filters.")
                        .font(.footnote).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    if discovery.nextCursor != nil {
                        Button("Continue to older records") { loadDiscovery(reset: false) }
                            .disabled(discoveryInFlight)
                            .accessibilityIdentifier("activity-load-older")
                    }
                } else {
                    Button("Browse all recorded work") { loadDiscovery(reset: true) }
                        .disabled(discoveryInFlight)
                }
                if discoveryInFlight { ProgressView("Reading records…") }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle("Activity")
        .onAppear { updateChecklistCorrectionEligibility() }
        .onChange(of: showingArchived) { _, _ in
            discoveryTask?.cancel()
            discoveryGeneration = UUID()
            discoveryInFlight = false
            discovery = nil
            activityStatuses = [:]
            activityStatusAvailability.reset()
            statusRefreshOffset = 0
            disposeSecurityReviews()
            updateChecklistCorrectionEligibility()
        }
        .onChange(of: filter) { _, _ in
            discoveryTask?.cancel()
            discoveryGeneration = UUID()
            discoveryInFlight = false
            if discovery != nil { loadDiscovery(reset: true) }
            if !showsSecurityReviews { disposeSecurityReviews() }
            updateChecklistCorrectionEligibility()
        }
        .onChange(of: model.activityConnectionVersion) { _, _ in
            discoveryTask?.cancel()
            discoveryGeneration = UUID()
            discoveryInFlight = false
            discovery = nil
            activityStatuses = [:]
            activityStatusAvailability.reset()
            statusRefreshOffset = 0
            disposeSecurityReviews()
            disposeChecklistCorrections()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                pauseChecklistCorrections()
            } else {
                updateChecklistCorrectionEligibility()
            }
        }
        .onChange(of: correctionEligibilitySnapshot) { _, _ in
            updateChecklistCorrectionEligibility()
        }
        .onDisappear {
            discoveryTask?.cancel()
            discoveryTask = nil
            discoveryGeneration = UUID()
            discoveryInFlight = false
            disposeSecurityReviews()
            pauseChecklistCorrections()
        }
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(
                        showingArchived ? "Show current activity" : "Show archived activity",
                        systemImage: showingArchived ? "tray.and.arrow.up" : "archivebox"
                    ) {
                        showingArchived.toggle()
                        if showingArchived { Task { await model.refreshArchivedActivity() } }
                    }
                    if !showingArchived {
                        Button(
                            archiveProgress.map { $0.complete ? "Archive old activity" : "Continue archiving (\($0.archivedTotal))" } ?? "Archive old activity",
                            systemImage: "archivebox"
                        ) {
                            activityActionInFlight = "archive-old"
                            Task {
                                let operationId = archiveProgress?.complete == false
                                    ? archiveProgress?.operationId
                                    : nil
                                if let progress = await model.archiveOldActivity(operationId: operationId) {
                                    archiveProgress = progress
                                }
                                activityActionInFlight = nil
                            }
                        }
                        .disabled(activityActionInFlight != nil)
                    }
                } label: {
                    Label("Activity actions", systemImage: "ellipsis")
                }
            }
        }
        .refreshable {
            if showingArchived { await model.refreshArchivedActivity() }
            else { await model.refreshOverview() }
            if discovery != nil { loadDiscovery(reset: true) }
            if showsSecurityReviews { await securityReviewController?.refresh() }
        }
        .task(id: activityPollingTaskID) {
            await pollVisibleActivity()
        }
        .task(id: securityReviewTaskID) {
            await refreshSecurityReviews()
        }
        .alert(
            "Raise task budget",
            isPresented: Binding(
                get: { budgetItem != nil },
                set: { if !$0 { budgetItem = nil } }
            )
        ) {
            TextField("New limit in USD", text: $budgetText)
                .keyboardType(.decimalPad)
            Button("Raise and retry") {
                guard let item = budgetItem, let amount = Double(budgetText) else { return }
                updateActivity(item, action: "raise-budget", budgetUsdLimit: amount)
                budgetItem = nil
            }
            Button("Cancel", role: .cancel) { budgetItem = nil }
        } message: {
            Text("The task resumes from its saved checkpoint; completed actions are not repeated.")
        }
        .confirmationDialog(
            "Stop task?",
            isPresented: Binding(
                get: { itemPendingCancellation != nil },
                set: { if !$0 { itemPendingCancellation = nil } }
            ),
            titleVisibility: .visible,
            presenting: itemPendingCancellation
        ) { item in
            Button("Stop task", role: .destructive) {
                updateActivity(item, action: "cancel")
            }
        } message: { item in
            Text("This cancels “\(item.displayTitle)”.")
        }
        .sensoryFeedback(.selection, trigger: filter)
    }

    private var filterControl: some View {
        AssistantFilterPicker(title: "Activity filter", options: ActivityFilter.allCases,
            selection: $filter, label: { $0.rawValue })
    }

    private var activitySummary: some View {
        let summary = ActivityVisualSummary(statuses: items.map(\.displayStatus))
        let colors: [Color] = [AssistantTheme.warning(for: colorScheme),
            AssistantTheme.accent(for: colorScheme), AssistantTheme.inkMuted(for: colorScheme),
            AssistantTheme.success(for: colorScheme).opacity(0.4), AssistantTheme.errorInk(for: colorScheme), .secondary]
        return AssistantFlowLayout(spacing: 12) {
            Text("\(items.count) \(items.count == 1 ? "task" : "tasks")")
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            ForEach(Array(summary.counts.enumerated()), id: \.offset) { index, count in
                if count > 0 {
                    HStack(spacing: 5) {
                        Circle().fill(colors[index]).frame(width: 6, height: 6).accessibilityHidden(true)
                        Text("\(count) \(ActivityVisualSummary.labels[index])")
                    }
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }

    private func loadDiscovery(reset: Bool) {
        if !reset && discoveryInFlight { return }
        if reset { discoveryTask?.cancel() }
        let generation = UUID()
        discoveryGeneration = generation
        if reset { statusRefreshOffset = 0 }
        discoveryInFlight = true
        let archived = showingArchived
        let query = discoveryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let status = filter.requestValue
        let cursor = reset ? nil : discovery?.nextCursor
        let previous = reset ? [] : discovery?.items ?? []
        discoveryTask = Task {
            let page = await model.activityDiscoveryPage(archived: archived, query: query, filter: status, cursor: cursor)
            guard !Task.isCancelled, discoveryGeneration == generation, showingArchived == archived else { return }
            discoveryInFlight = false
            discoveryTask = nil
            guard let page else { return }
            var seen = Set(previous.map(\.id))
            let newItems = page.items.filter { seen.insert($0.id).inserted }
            discovery = ActivityList(items: previous + newItems, archivedCount: page.archivedCount,
                                     nextCursor: page.nextCursor, searchIncomplete: page.searchIncomplete,
                                     scanned: page.scanned, captureStatus: page.captureStatus)
        }
    }

    private func refreshVisibleActivity() async -> Bool {
        let generation = discoveryGeneration
        let connectionVersion = model.activityConnectionVersion
        let archived = showingArchived
        let refreshed = archived
            ? await model.refreshArchivedActivity(reportFailure: false)
            : await model.refreshOverview(reportFailure: false)
        guard isCurrentActivityRefresh(generation, connectionVersion, archived) else { return false }

        let ownerID = model.bootstrap?.identity.id ?? ""
        for item in storedItems where ["done", "failed", "cancelled"].contains(item.status) {
            activityStatusAvailability.clear(ActivityStatusAvailabilityKey(ownerID: ownerID, taskID: item.id))
        }
        let candidates = storedItems.filter { !["done", "failed", "cancelled"].contains($0.status) }
        guard !candidates.isEmpty else { return refreshed }
        let cap = 12
        let start = statusRefreshOffset % candidates.count
        let rotated = Array(candidates.dropFirst(start)) + Array(candidates.prefix(start))
        let batch = Array(rotated.prefix(cap))
        statusRefreshOffset = (start + batch.count) % candidates.count

        let outcomes = await withTaskGroup(of: (String, ActivityStatusReadOutcome).self) { group in
            var next = 0
            let initialCount = min(4, batch.count)
            while next < initialCount {
                let id = batch[next].id
                group.addTask { (id, await model.fetchActivityStatusOutcome(id: id)) }
                next += 1
            }
            var collected: [(String, ActivityStatusReadOutcome)] = []
            while let result = await group.next() {
                guard !Task.isCancelled else {
                    group.cancelAll()
                    break
                }
                collected.append(result)
                if !Task.isCancelled, next < batch.count {
                    let id = batch[next].id
                    group.addTask { (id, await model.fetchActivityStatusOutcome(id: id)) }
                    next += 1
                }
            }
            return collected
        }
        guard isCurrentActivityRefresh(generation, connectionVersion, archived) else { return false }
        for (id, outcome) in outcomes {
            let key = ActivityStatusAvailabilityKey(ownerID: ownerID, taskID: id)
            activityStatusAvailability.record(outcome, for: key)
            if case let .updated(status) = outcome { activityStatuses[status.id] = status }
        }
        return refreshed && outcomes.count == batch.count && outcomes.allSatisfy {
            if case .updated = $0.1 { return true }
            return false
        }
    }

    private func isCurrentActivityRefresh(_ generation: UUID, _ connectionVersion: Int, _ archived: Bool) -> Bool {
        !Task.isCancelled && scenePhase == .active && discoveryGeneration == generation &&
            showingArchived == archived && model.activityConnectionIsCurrent(version: connectionVersion)
    }

    private var storedItems: [ActivityItem] {
        let source = discovery?.items ?? (showingArchived
            ? model.archivedActivity?.items ?? []
            : model.overview?.activity.items ?? [])
        return source.map { item in
            activityStatuses[item.id].map(item.applying) ?? item
        }
    }

    private var items: [ActivityItem] {
        storedItems.filter { showingArchived ? $0.archivedAt != nil : $0.archivedAt == nil }
    }

    private var filteredItems: [ActivityItem] {
        return items.filter { item in
            switch filter {
            case .all: true
            case .needsYou: ["waiting_approval", "waiting_budget", "needs_attention", "stuck"].contains(item.displayStatus)
            case .working: ["pending", "running"].contains(item.status)
            case .scheduled: ["sleeping", "waiting_event"].contains(item.status)
            case .completed: ["done", "failed", "cancelled"].contains(item.status)
            }
        }
    }

    private func activityCard(_ item: ActivityItem) -> some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            activityHeader(item)
            if let ownerID = model.bootstrap?.identity.id,
               let notice = activityStatusAvailability.notice(
                   for: ActivityStatusAvailabilityKey(ownerID: ownerID, taskID: item.id),
                   savedStatus: item.status
               ) {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityIdentifier("activity-status-unavailable-\(item.id)")
            }
            DisclosureGroup("Details") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Task \(item.id)")
                    if let source = item.source { Text("Source: \(source)") }
                    if let created = item.createdAt { Text("Created: \(created)") }
                    if let event = item.externalEventId { Text("Source record: \(event)") }
                }.font(.caption).textSelection(.enabled)
            }.font(.caption)

            if !item.displayProgress.isEmpty {
                Text((try? AttributedString(markdown: item.displayProgress,
                    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(item.displayProgress))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 3)
            }

            checklistCorrectionEntry(item)

            Divider()
            HStack(alignment: .bottom, spacing: AssistantTheme.actionSpacing) {
                VStack(alignment: .leading, spacing: AssistantTheme.actionSpacing) {
                    activityMetadata(item)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    activityPrimaryActions(item)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !showingArchived {
                    activityActions(item)
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func activityPrimaryActions(_ item: ActivityItem) -> some View {
        if showingArchived || item.hasPendingApproval || item.status == "needs_attention" || item.stuckWaiting == true {
            AssistantFlowLayout(spacing: AssistantTheme.actionSpacing) {
                if showingArchived {
                    actionButton(item, title: "Restore", icon: "tray.and.arrow.up", action: "restore")
                } else {
                    if item.hasPendingApproval {
                        Button { model.present(.approvals) } label: {
                            Label("Review approval", systemImage: "checkmark.shield")
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                        .disabled(activityActionInFlight != nil)
                    }
                    if item.status == "needs_attention" && item.progress.hasPrefix("budget: task budget") {
                        Button {
                            budgetItem = item
                            budgetText = suggestedBudget(for: item)
                        } label: {
                            Label("Raise budget", systemImage: "dollarsign.arrow.circlepath")
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                        .disabled(activityActionInFlight != nil)
                    } else if item.status == "needs_attention" || item.stuckWaiting == true {
                        actionButton(item, title: "Retry", icon: "arrow.clockwise", action: "retry")
                    }
                }
            }
        }
    }

    private func activityActions(_ item: ActivityItem) -> some View {
        Menu {
            if isTerminal(item) {
                Button("Archive", systemImage: "archivebox") {
                    updateActivity(item, action: "archive")
                }
            }
            if item.hasActiveAutonomy == true {
                Button("Revoke autonomy", systemImage: "hand.raised") {
                    updateActivity(item, action: "revoke-autonomy")
                }
            }
            if !isTerminal(item) {
                Button("Stop task", systemImage: "xmark.circle", role: .destructive) {
                    itemPendingCancellation = item
                }
            }
        } label: {
            AssistantActionMenuLabel(isUpdating: activityActionInFlight == item.id)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Actions for \(item.displayTitle)")
        .disabled(activityActionInFlight != nil)
    }

    @ViewBuilder
    private func activityActionLabel(_ item: ActivityItem, title: String, icon: String) -> some View {
        if activityActionInFlight == item.id {
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("Updating…")
            }
        } else {
            Label(title, systemImage: icon)
        }
    }

    private func updateActivity(_ item: ActivityItem, action: String) {
        activityActionInFlight = item.id
        Task {
            _ = await model.updateActivity(item, action: action)
            activityActionInFlight = nil
        }
    }

    private func updateActivity(_ item: ActivityItem, action: String, budgetUsdLimit: Double) {
        activityActionInFlight = item.id
        Task {
            _ = await model.updateActivity(
                item,
                action: action,
                budgetUsdLimit: budgetUsdLimit
            )
            activityActionInFlight = nil
        }
    }

    private func actionButton(
        _ item: ActivityItem,
        title: String,
        icon: String,
        action: String
    ) -> some View {
        Button { updateActivity(item, action: action) } label: {
            activityActionLabel(item, title: title, icon: icon)
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
        .disabled(activityActionInFlight != nil)
    }

    @ViewBuilder
    private func checklistCorrectionEntry(_ item: ActivityItem) -> some View {
        if isChecklistCorrectionEligible(item) {
            if let controller = checklistCorrectionControllers[item.id] {
                ChecklistCorrectionSection(controller: controller) {
                    await model.refreshOverview()
                }
            } else {
                Button("Change a lookup") { beginChecklistCorrection(for: item) }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: false))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("checklist-correction-open-\(item.id)")
            }
        }
    }

    private func beginChecklistCorrection(for item: ActivityItem) {
        guard isChecklistCorrectionEligible(item),
              let context = model.checklistCorrectionRequestContext() else { return }
        let controller = ChecklistCorrectionController(
            context: context,
            taskID: item.id,
            connectionIsCurrent: { [weak model] in
                model?.checklistCorrectionConnectionIsCurrent(
                    ownerID: context.ownerID,
                    version: context.connectionVersion
                ) ?? false
            }
        )
        checklistCorrectionControllers[item.id] = controller
        Task { await controller.load() }
    }

    private func refreshSecurityReviews() async {
        guard scenePhase == .active else {
            disposeSecurityReviews()
            return
        }
        guard showsSecurityReviews else {
            disposeSecurityReviews()
            return
        }
        guard let context = model.securityReviewRequestContext() else {
            disposeSecurityReviews()
            return
        }

        let controller: SecurityReviewController
        if let existing = securityReviewController,
           existing.ownerID == context.ownerID,
           existing.connectionVersion == context.connectionVersion {
            controller = existing
        } else {
            disposeSecurityReviews()
            controller = SecurityReviewController(
                context: context,
                connectionIsCurrent: { [weak model] in
                    model?.securityReviewConnectionIsCurrent(
                        ownerID: context.ownerID,
                        version: context.connectionVersion
                    ) ?? false
                }
            )
            securityReviewController = controller
        }
        await controller.refresh()
    }

    private var activityPollingTaskID: String {
        "\(scenePhase)-\(model.activityConnectionVersion)-\(showingArchived)-\(filter.rawValue)"
    }

    private var securityReviewTaskID: String {
        "security-\(scenePhase)-\(model.activityConnectionVersion)-\(showingArchived)-\(filter.rawValue)"
    }

    private func pollVisibleActivity() async {
        guard scenePhase == .active else { return }
        var failures = 0
        while !Task.isCancelled, scenePhase == .active {
            let refreshed = await refreshVisibleActivity()
            failures = refreshed ? 0 : failures + 1
            let interval = PollingPolicy.activityIntervalSeconds(consecutiveFailures: failures)
            do {
                try await Task.sleep(for: .seconds(interval))
            } catch {
                return
            }
        }
    }

    private func pauseChecklistCorrections() {
        checklistCorrectionControllers.values.forEach { $0.updateTaskEligibility(false) }
    }

    private func updateChecklistCorrectionEligibility() {
        let eligibleIDs = Set(filteredItems.filter(isChecklistCorrectionEligible).map(\.id))
        checklistCorrectionControllers.forEach { id, controller in
            controller.updateTaskEligibility(eligibleIDs.contains(id))
        }
    }

    private func disposeChecklistCorrections() {
        checklistCorrectionControllers.values.forEach { $0.dispose() }
        checklistCorrectionControllers = [:]
    }

    private var correctionEligibilitySnapshot: [String] {
        filteredItems.map {
            "\($0.id)|\($0.status)|\($0.archivedAt != nil)|\($0.hasPendingApproval)|\($0.trust)|\($0.type)"
        }
    }

    private func isChecklistCorrectionEligible(_ item: ActivityItem) -> Bool {
        !showingArchived && item.archivedAt == nil && item.type == "chat_turn" &&
            item.trust == "owner" && item.status == "needs_attention" && !item.hasPendingApproval
    }

    private func suggestedBudget(for item: ActivityItem) -> String {
        let current = Double(item.budgetUsdLimit) ?? 0
        let spent = Double(item.spentUsd) ?? 0
        let suggested = ceil(max(current * 2, spent + 0.25) * 4) / 4
        return String(format: "%.2f", suggested)
    }

    private func isTerminal(_ item: ActivityItem) -> Bool {
        ["done", "failed", "cancelled"].contains(item.status)
    }

    @ViewBuilder
    private func activityHeader(_ item: ActivityItem) -> some View {
        let identity = HStack(alignment: .top, spacing: 12) {
                AssistantGlyph(systemName: icon(for: item.displayStatus), tint: color(for: item.displayStatus))
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.displayTitle)
                        .font(.headline)
                        .lineLimit(usesAccessibilityLayout ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(item.type.sentenceCaseIdentifier)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                identity
                StatusPill(status: item.displayStatus)
            }
        } else {
            HStack(alignment: .top, spacing: 12) {
                identity
                StatusPill(status: item.displayStatus)
            }
        }
    }

    @ViewBuilder
    private func activityMetadata(_ item: ActivityItem) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.budgetSummary)
                Text(relative(item.updatedAt))
                if item.hasPendingApproval {
                    Label("Approval waiting", systemImage: "hand.raised.fill")
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                }
            }
        } else {
            AssistantFlowLayout(spacing: 7) {
                Text(item.budgetSummary)
                Text("·")
                Text(relative(item.updatedAt))
                if item.hasPendingApproval {
                    Text("·")
                    Label("Approval waiting", systemImage: "hand.raised.fill")
                    .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                }
            }
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
    private var isLandscape: Bool { verticalSizeClass == .compact }
    private var showsSecurityReviews: Bool {
        !showingArchived && (filter == .all || filter == .needsYou)
    }

    private func disposeSecurityReviews() {
        securityReviewController?.dispose()
        securityReviewController = nil
    }

    private func icon(for status: String) -> String {
        switch status {
        case "running": "arrow.triangle.2.circlepath"
        case "done": "checkmark.circle.fill"
        case "failed", "cancelled": "xmark.circle.fill"
        case "waiting_approval", "waiting_budget", "needs_attention", "stuck": "hand.raised.fill"
        case "sleeping", "waiting_event": "clock.fill"
        default: "circle.dotted"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "running": AssistantTheme.accent(for: colorScheme)
        // The brand green, matching the StatusPill sitting beside it in the
        // same card — system green is a visibly different hue.
        case "done": AssistantTheme.success(for: colorScheme)
        case "failed", "cancelled": .red
        case "waiting_approval", "waiting_budget", "needs_attention", "stuck": AssistantTheme.warning(for: colorScheme)
        default: .secondary
        }
    }
}

struct ActivityDiscoverySearchRow: View {
    @Binding var query: String
    @FocusState.Binding var isFocused: Bool
    let isLoading: Bool
    let onSubmit: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: AssistantTheme.controlCornerRadius, style: .continuous)
    }

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            stackedSearchRow
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    searchField
                        .frame(minWidth: 220, maxWidth: .infinity)
                    searchButton
                }

                stackedSearchRow
            }
        }
    }

    private var stackedSearchRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            searchField
            HStack {
                Spacer(minLength: 0)
                searchButton
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.body)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .accessibilityHidden(true)

            TextField(
                text: $query,
                prompt: Text("Search recorded work")
                    .foregroundColor(AssistantTheme.inkMuted(for: colorScheme))
            ) {
                Text("Search recorded work")
            }
            .font(.body)
            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            .tint(AssistantTheme.accent(for: colorScheme))
            .focused($isFocused)
            .submitLabel(.search)
            .onSubmit(onSubmit)
            .accessibilityLabel("Search recorded work")
            .accessibilityIdentifier("activity-search")

            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.body)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search text")
                .accessibilityIdentifier("activity-search-clear")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, query.isEmpty ? 12 : 4)
        .frame(minHeight: 48)
        .background(AssistantTheme.sunken(for: colorScheme), in: shape)
        .overlay {
            shape.stroke(
                isFocused
                    ? AssistantTheme.accent(for: colorScheme)
                    : AssistantTheme.inkMuted(for: colorScheme).opacity(
                        colorSchemeContrast == .increased ? 0.62 : 0.24
                    ),
                lineWidth: isFocused
                    ? (colorSchemeContrast == .increased ? 2.5 : 1.5)
                    : (colorSchemeContrast == .increased ? 1.5 : 1)
            )
        }
    }

    private var searchButton: some View {
        Button(action: onSubmit) {
            Text("Search")
                .fixedSize()
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
        .frame(minHeight: 44)
        .disabled(isLoading)
        .accessibilityIdentifier("activity-search-submit")
    }
}

func relative(_ value: String) -> String {
    // Both fractional and whole-second ISO timestamps are valid server dates.
    guard let date = value.assistantDate
        ?? AssistantFormatters.internetDateTime.date(from: value) else { return value }
    return AssistantFormatters.relative.localizedString(for: date, relativeTo: .now)
}
