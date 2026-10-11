import Observation
import SwiftUI

struct SecurityReviewRequestContext: Sendable {
    let ownerID: String
    let connectionVersion: Int
    let client: APIClient
}

@MainActor
protocol SecurityReviewTransport {
    func list() async throws -> [SecurityReviewItem]
    func decide(_ item: SecurityReviewItem, as disposition: SecurityReviewDisposition) async -> SecurityReviewDecisionResult
}

@MainActor
private struct APIClientSecurityReviewTransport: SecurityReviewTransport {
    let client: APIClient

    func list() async throws -> [SecurityReviewItem] {
        try await client.securityReviews()
    }

    func decide(_ item: SecurityReviewItem, as disposition: SecurityReviewDisposition) async -> SecurityReviewDecisionResult {
        await client.decideSecurityReview(
            incidentId: item.incidentId,
            expectedRevision: item.revision,
            disposition: disposition
        )
    }
}

enum SecurityReviewLoadState: Equatable {
    case loading
    case ready
    case unavailable
}

@MainActor
@Observable
final class SecurityReviewController {
    let ownerID: String
    let connectionVersion: Int
    private(set) var items: [SecurityReviewItem] = []
    private(set) var loadState: SecurityReviewLoadState = .loading
    private(set) var isRefreshing = false
    private(set) var pendingIncidentID: String?
    private(set) var message = ""
    private(set) var staleList = false

    @ObservationIgnored private let transport: any SecurityReviewTransport
    @ObservationIgnored private let connectionIsCurrent: @MainActor () -> Bool
    @ObservationIgnored private var active = true
    @ObservationIgnored private var listGeneration = UUID()
    @ObservationIgnored private var mutationGeneration = UUID()
    @ObservationIgnored private var listTask: Task<[SecurityReviewItem], Error>?
    @ObservationIgnored private var mutationTask: Task<SecurityReviewDecisionResult, Never>?

    init(
        context: SecurityReviewRequestContext,
        connectionIsCurrent: @escaping @MainActor () -> Bool,
        transport: (any SecurityReviewTransport)? = nil
    ) {
        ownerID = context.ownerID
        connectionVersion = context.connectionVersion
        self.connectionIsCurrent = connectionIsCurrent
        self.transport = transport ?? APIClientSecurityReviewTransport(client: context.client)
    }

    func refresh() async {
        guard isCurrent, pendingIncidentID == nil else { return }
        listTask?.cancel()
        let generation = UUID()
        listGeneration = generation
        isRefreshing = true
        if loadState == .loading { message = "" }

        let request = Task { try await transport.list() }
        listTask = request
        do {
            let updatedItems = try await request.value
            guard isCurrent, listGeneration == generation else { return }
            guard updatedItems.count <= 50,
                  updatedItems.allSatisfy(\.isValid),
                  Set(updatedItems.map(\.incidentId)).count == updatedItems.count else {
                throw APIError.invalidResponse
            }
            items = updatedItems
            loadState = .ready
            staleList = false
            message = ""
        } catch {
            guard isCurrent, listGeneration == generation else { return }
            if isRequestCancellation(error) {
                isRefreshing = false
                listTask = nil
                return
            }
            let hasSnapshot = loadState == .ready
            loadState = hasSnapshot ? .ready : .unavailable
            staleList = hasSnapshot
            message = "Security reviews could not be refreshed. Try again."
        }
        guard isCurrent, listGeneration == generation else { return }
        isRefreshing = false
        listTask = nil
    }

    func decide(_ item: SecurityReviewItem, as disposition: SecurityReviewDisposition) async {
        guard disposition == .expected || disposition == .dismissed,
              isCurrent, pendingIncidentID == nil, !isRefreshing, !staleList,
              loadState == .ready,
              items.contains(where: { $0.incidentId == item.incidentId && $0.revision == item.revision }) else { return }
        listTask?.cancel()
        listGeneration = UUID()
        listTask = nil
        let generation = UUID()
        mutationGeneration = generation
        pendingIncidentID = item.incidentId
        message = ""

        let request = Task { await transport.decide(item, as: disposition) }
        mutationTask = request
        let result = await request.value
        guard isCurrent, mutationGeneration == generation else { return }

        switch result {
        case .saved:
            message = "Decision saved."
        case .stale:
            message = "This review changed. Checking the latest version…"
        case .uncertain:
            message = "The decision response was unclear. Checking the current review list…"
        }

        await reconcile(after: result)
        guard isCurrent, mutationGeneration == generation else { return }
        mutationTask = nil
        pendingIncidentID = nil
    }

    func dispose() {
        guard active else { return }
        active = false
        listGeneration = UUID()
        mutationGeneration = UUID()
        listTask?.cancel()
        mutationTask?.cancel()
        listTask = nil
        mutationTask = nil
        items = []
        pendingIncidentID = nil
        isRefreshing = false
        staleList = false
        message = ""
        loadState = .loading
    }

    private var isCurrent: Bool {
        active && connectionIsCurrent()
    }

    private func reconcile(after result: SecurityReviewDecisionResult) async {
        listTask?.cancel()
        let generation = UUID()
        listGeneration = generation
        isRefreshing = true
        switch result {
        case .saved:
            message = "Decision saved. Refreshing the review list…"
        case .stale:
            message = "This review changed. Checking the latest version…"
        case .uncertain:
            message = "The decision response was unclear. Checking the current review list…"
        }

        let request = Task { try await transport.list() }
        listTask = request
        do {
            let updatedItems = try await request.value
            guard isCurrent, listGeneration == generation else { return }
            guard updatedItems.count <= 50,
                  updatedItems.allSatisfy(\.isValid),
                  Set(updatedItems.map(\.incidentId)).count == updatedItems.count else {
                throw APIError.invalidResponse
            }
            items = updatedItems
            loadState = .ready
            staleList = false
            message = switch result {
            case .saved: "Decision saved."
            case .stale: "This review changed. The latest version is loaded."
            case .uncertain: "The decision response was unclear. The current review list was reloaded; check its state before trying again."
            }
        } catch {
            guard isCurrent, listGeneration == generation else { return }
            if isRequestCancellation(error) {
                isRefreshing = false
                listTask = nil
                return
            }
            loadState = .ready
            staleList = true
            message = switch result {
            case .saved: "Decision saved. The displayed review list may be out of date; refresh to confirm the latest state."
            case .stale: "This review changed, but the latest version could not be loaded. Refresh before deciding again."
            case .uncertain: "The decision response was unclear and the list could not be refreshed. Review it before trying again."
            }
        }
        guard isCurrent, listGeneration == generation else { return }
        isRefreshing = false
        listTask = nil
    }
}

struct SecurityReviewSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Bindable var controller: SecurityReviewController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            reviewHeader

            if controller.staleList {
                Text("Displayed reviews may be out of date.")
                    .font(.footnote)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityIdentifier("security-reviews-stale")
            }
            if !controller.message.isEmpty, controller.loadState != .unavailable {
                Text(controller.message)
                    .font(.footnote)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("security-reviews-message")
            }

            switch controller.loadState {
            case .loading where controller.items.isEmpty:
                ProgressView("Loading security reviews…")
                    .font(.subheadline)
                    .accessibilityIdentifier("security-reviews-loading")
            case .unavailable:
                Text("Security reviews are unavailable right now. Use Refresh to try again.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityIdentifier("security-reviews-unavailable")
            case .ready where controller.items.isEmpty:
                Text(controller.staleList
                     ? "No current list is available. Refresh to check for security reviews."
                     : "No security reviews need attention.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityIdentifier("security-reviews-empty")
            default:
                if !controller.items.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(controller.items.enumerated()), id: \.element.id) { index, item in
                            if index > 0 { Divider().padding(.vertical, 12) }
                            reviewRow(item)
                        }
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
        .accessibilityIdentifier("security-reviews-section")
    }

    private var reviewHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                headingAndCount
                Spacer(minLength: 8)
                refreshButton
            }
            VStack(alignment: .leading, spacing: 4) {
                headingAndCount
                refreshButton
            }
        }
    }

    private var headingAndCount: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                heading
                if controller.loadState == .ready && !controller.staleList {
                    countLabel
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                heading
                if controller.loadState == .ready && !controller.staleList {
                    countLabel
                }
            }
        }
    }

    private var heading: some View {
        Text("Security reviews")
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private var countLabel: some View {
        Text("\(controller.items.count)")
            .font(.caption.monospacedDigit())
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel("\(controller.items.count) security \(controller.items.count == 1 ? "review" : "reviews")")
    }

    private var refreshButton: some View {
        Button {
            Task { await controller.refresh() }
        } label: {
            if controller.isRefreshing {
                ProgressView().controlSize(.small)
            } else {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .neutral))
        .disabled(controller.isRefreshing || controller.pendingIncidentID != nil)
        .accessibilityLabel(controller.isRefreshing ? "Refreshing security reviews" : "Refresh security reviews")
        .accessibilityIdentifier("security-reviews-refresh")
    }

    private func reviewRow(_ item: SecurityReviewItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.subject)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            categoryMetadata(item)

            if let reason = item.materialChangeReason {
                VStack(alignment: .leading, spacing: 3) {
                    Text("As described in the notice")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let observedDate = item.observedDate {
                Text(observedDate.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }

            DisclosureGroup("Review notice details") {
                VStack(alignment: .leading, spacing: 6) {
                    if let quote = item.evidence?.evidenceQuote {
                        Text("As described in the notice")
                            .font(.caption.weight(.medium))
                        Text(quote)
                    }
                    if let eventType = item.evidence?.eventType {
                        LabeledContent("Activity", value: eventType)
                    }
                    if item.evidence?.evidenceQuote == nil && item.evidence?.eventType == nil {
                        Text("No additional notice detail is available.")
                    }
                }
                .font(.footnote)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
            }
            .font(.footnote.weight(.medium))
            .tint(AssistantTheme.accent(for: colorScheme))
            .frame(minHeight: 44, alignment: .leading)

            AssistantFlowLayout(spacing: AssistantTheme.actionSpacing) {
                Button {
                    Task { await controller.decide(item, as: .expected) }
                } label: {
                    Label(
                        controller.pendingIncidentID == item.incidentId ? "Saving…" : "Mark expected",
                        systemImage: "checkmark"
                    )
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                .disabled(controller.pendingIncidentID != nil || controller.isRefreshing || controller.staleList)
                .accessibilityLabel("Mark \(item.subject) as expected")
                .accessibilityIdentifier("security-review-expected-\(item.incidentId)")

                Button {
                    Task { await controller.decide(item, as: .dismissed) }
                } label: {
                    Label("Dismiss", systemImage: "xmark")
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .neutral))
                .disabled(controller.pendingIncidentID != nil || controller.isRefreshing || controller.staleList)
                .accessibilityLabel("Dismiss \(item.subject)")
                .accessibilityIdentifier("security-review-dismiss-\(item.incidentId)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func categoryMetadata(_ item: SecurityReviewItem) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let fromName = item.fromName {
                    Text(fromName).fixedSize(horizontal: true, vertical: false)
                }
                Text(item.readableCategory).fixedSize(horizontal: true, vertical: false)
            }
            VStack(alignment: .leading, spacing: 2) {
                if let fromName = item.fromName { Text(fromName) }
                Text(item.readableCategory)
            }
        }
        .font(.footnote)
        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        .fixedSize(horizontal: false, vertical: true)
    }
}
