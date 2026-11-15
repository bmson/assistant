import Observation
import SwiftUI
import CryptoKit
import Security

/// Presentation only: the future request adapter owns quote validation,
/// persistence and same-operation recovery before it supplies this state.
enum CostPermissionDisplayState: Equatable {
    case pending, submitting, unconfirmed, approved, declined, expired, changed, cancelled, unavailable

    var canDecide: Bool { self == .pending }
    var canCheck: Bool { self == .unconfirmed }
    var message: String {
        switch self {
        case .pending: "Review the allowance before deciding."
        case .submitting: "Sending your decision…"
        case .unconfirmed: "The decision could not be confirmed. Check this decision before taking further action."
        case .approved: "An allowance was approved. The request’s result and actual cost are separate."
        case .declined: "Allowance declined."
        case .expired: "This quote expired. Review an updated quote before deciding."
        case .changed: "This quote changed. Review the updated details before deciding."
        case .cancelled: "This request was cancelled."
        case .unavailable: "This request’s current state is unavailable."
        }
    }
}

struct CostPermissionDisplay: Equatable {
    let requestName: String
    let estimatedNextAttempt: String
    let maximumAllowance: String
    let recordedDailySpend: String
    let recordedMonthlySpend: String
    let activeHeldEstimate: String
    let historicalUnknownEstimate: String
    let pendingApprovalEstimate: String
    let dailyLimit: String
    let monthlyLimit: String
    let dailyProjectedGross: String
    let monthlyProjectedGross: String
    let expiryDescription: String
    let unavailableReason: String?
    let quoteComplete: Bool
    let serverAllowsApproval: Bool
    let state: CostPermissionDisplayState

    var canDecide: Bool { (state == .pending || state == .expired) && quoteComplete }
    var canApprove: Bool { state == .pending && quoteComplete && serverAllowsApproval }

    init(quote: EstimatedCostQuote, state: CostPermissionDisplayState, now: Date = Date()) {
        func usd(_ micros: Int64) -> String {
            guard quote.complete && quote.isValid else { return "Unavailable" }
            return (Decimal(micros) / Decimal(1_000_000)).formatted(.currency(code: "USD").precision(.fractionLength(2...6)))
        }
        requestName = quote.requestText
        estimatedNextAttempt = usd(quote.nextAttemptMicros)
        maximumAllowance = usd(quote.allowanceMicros)
        recordedDailySpend = usd(quote.recordedDailyMicros)
        recordedMonthlySpend = usd(quote.recordedMonthlyMicros)
        activeHeldEstimate = usd(quote.totalHeldMicros)
        historicalUnknownEstimate = usd(quote.eligibleHistoricalUnknownMicros)
        pendingApprovalEstimate = usd(quote.pendingApprovalMicros)
        dailyLimit = usd(quote.dailyCeilingMicros); monthlyLimit = usd(quote.monthlyCeilingMicros)
        dailyProjectedGross = usd(quote.dailyProjectedGrossMicros); monthlyProjectedGross = usd(quote.monthlyProjectedGrossMicros)
        expiryDescription = quote.expiry.map { "Quote expires \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "Quote expiry unavailable"
        quoteComplete = quote.complete && quote.isValid
        unavailableReason = quote.unavailableReason
        serverAllowsApproval = quote.canApprove
        self.state = state == .pending && (quote.expiry.map { $0 <= now } ?? true) ? .expired : state
    }

    init(requestName: String, estimatedNextAttempt: String, maximumAllowance: String,
         recordedDailySpend: String, recordedMonthlySpend: String, activeHeldEstimate: String,
         historicalUnknownEstimate: String, pendingApprovalEstimate: String, dailyLimit: String,
         monthlyLimit: String, dailyProjectedGross: String, monthlyProjectedGross: String,
         expiryDescription: String, unavailableReason: String? = nil, quoteComplete: Bool, serverAllowsApproval: Bool, state: CostPermissionDisplayState) {
        self.requestName = requestName; self.estimatedNextAttempt = estimatedNextAttempt; self.maximumAllowance = maximumAllowance
        self.recordedDailySpend = recordedDailySpend; self.recordedMonthlySpend = recordedMonthlySpend
        self.activeHeldEstimate = activeHeldEstimate; self.historicalUnknownEstimate = historicalUnknownEstimate
        self.pendingApprovalEstimate = pendingApprovalEstimate; self.dailyLimit = dailyLimit; self.monthlyLimit = monthlyLimit
        self.dailyProjectedGross = dailyProjectedGross; self.monthlyProjectedGross = monthlyProjectedGross
        self.expiryDescription = expiryDescription; self.quoteComplete = quoteComplete
        self.unavailableReason = unavailableReason
        self.serverAllowsApproval = serverAllowsApproval; self.state = state
    }
}

/// A self-contained 24-point Dialog built from components available in the
/// published client. Actions are supplied only by the request-scoped owner.
struct CostPermissionReviewCard: View {
    let display: CostPermissionDisplay
    var canonicalNotice: String? = nil
    var canonicalStatus: String? = nil
    var canonicalGrantExpiry: String? = nil
    var receipt: EstimatedCostDecisionReceipt? = nil
    let approve: () async -> Void
    let decline: () async -> Void
    let check: () async -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Text("Spending permission").font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                Image(systemName: "dollarsign.circle").font(.system(size: 20))
                    .frame(width: 24, height: 24).accessibilityHidden(true)
            }
            .padding(24)
            Divider()
            VStack(alignment: .leading, spacing: 16) {
                Text("Allow up to \(display.maximumAllowance) for \(display.requestName)")
                    .font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Next attempt estimate: \(display.estimatedNextAttempt)")
                    Text("Recorded today: \(display.recordedDailySpend) of \(display.dailyLimit)")
                    Text("Recorded this month: \(display.recordedMonthlySpend) of \(display.monthlyLimit)")
                    Text("Total held estimates: \(display.activeHeldEstimate)")
                    Text("Eligible historical unknown estimates, included in held: \(display.historicalUnknownEstimate)")
                    Text("Awaiting-decision estimates: \(display.pendingApprovalEstimate)")
                    Text("Projected gross today: \(display.dailyProjectedGross)")
                    Text("Projected gross this month: \(display.monthlyProjectedGross)")
                }
                .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .assistantPanel(in: colorScheme)
                Text("Held and awaiting-decision amounts are estimates, not recorded spend. Projected gross includes the quote’s reported exposures; do not add these lines together.")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                Text("This is an allowance for this request, not a charge or a provider spending cap. It does not raise your configured limits or approve tools or external actions. If it needs more, you may be asked again.")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                Text("Declining ends this waiting request without spending more. Other eligible requests can continue.")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                Text(display.expiryDescription).font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                if !display.quoteComplete {
                    Text("Some amounts are unavailable. Review a complete quote before deciding.")
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                } else if display.state.canDecide && !display.serverAllowsApproval {
                    Text("This request cannot be approved with the available allowance.")
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
                if let reason = display.unavailableReason, !reason.isEmpty {
                    Text(reason).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
                Text(display.state.message).font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                if let receipt {
                    Text("Your decision for quote \(receipt.quoteId): \(receipt.status == "stale" ? "not applied because the quote changed" : "confirmed \(receipt.status)").")
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    if let expiry = receipt.expiresAt {
                        Text("Your confirmed allowance expires: \(expiry)").font(.subheadline)
                    }
                }
                if let canonicalStatus {
                    Text("Last checked request status: \(canonicalStatus.replacingOccurrences(of: "_", with: " ")).")
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    if canonicalStatus == "approved", let canonicalGrantExpiry {
                        Text("Request allowance expires: \(canonicalGrantExpiry)").font(.subheadline)
                    }
                }
                if let canonicalNotice, !canonicalNotice.isEmpty {
                    Text(canonicalNotice).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
            if display.canDecide || display.state.canCheck {
                Divider()
                VStack(spacing: 8) {
                    if display.canDecide {
                        AssistantConfirmationButton("Allow up to \(display.maximumAllowance)", confirmationTitle: "Allow this request?",
                            systemImage: "checkmark", kind: .primary, fillsWidth: true, action: approve)
                            .disabled(!display.canApprove)
                        AssistantConfirmationButton("Decline", confirmationTitle: "Decline this request?",
                            systemImage: "xmark", kind: .secondary, fillsWidth: true, action: decline)
                    } else {
                        Button("Check this decision") { Task { await check() } }
                            .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true))
                    }
                }.padding(24)
            }
        }
        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
        .background(AssistantTheme.raised(for: colorScheme), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

struct PendingCostPermissionDecision: Codable, Equatable, Sendable {
    let ownerID: String
    let quote: EstimatedCostQuote
    let decision: EstimatedCostDecision
}

/// Implementations must durably protect this record before returning from save.
/// No storage adapter is supplied until the operation contract is available.
@MainActor protocol CostPermissionRecoveryStore {
    func load(ownerID: String, operationID: String) throws -> PendingCostPermissionDecision?
    func save(_ pending: PendingCostPermissionDecision) throws
    func remove(ownerID: String, operationID: String) throws
}

@MainActor final class KeychainCostPermissionRecoveryStore: CostPermissionRecoveryStore {
    private let serverIdentity: String
    private let service = "assistant.estimated-cost-decision.v1"
    init(serverIdentity: String) {
        if var components = URLComponents(string: serverIdentity) {
            components.scheme = components.scheme?.lowercased()
            components.host = components.host?.lowercased()
            if (components.scheme == "https" && components.port == 443) ||
                (components.scheme == "http" && components.port == 80) { components.port = nil }
            components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            self.serverIdentity = components.string ?? serverIdentity
        } else { self.serverIdentity = serverIdentity }
    }

    private func query(ownerID: String, operationID: String) throws -> [String: Any] {
        let identity = try JSONEncoder().encode([serverIdentity, ownerID, operationID])
        let account = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: account]
    }
    func load(ownerID: String, operationID: String) throws -> PendingCostPermissionDecision? {
        var request = try query(ownerID: ownerID, operationID: operationID)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw APIError.invalidResponse }
        return try JSONDecoder().decode(PendingCostPermissionDecision.self, from: data)
    }
    func save(_ pending: PendingCostPermissionDecision) throws {
        var request = try query(ownerID: pending.ownerID, operationID: pending.quote.operationId)
        request[kSecValueData as String] = try JSONEncoder().encode(pending)
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw APIError.invalidResponse }
    }
    func remove(ownerID: String, operationID: String) throws {
        let status = SecItemDelete(try query(ownerID: ownerID, operationID: operationID) as CFDictionary)
        guard status == errSecSuccess else { throw APIError.invalidResponse }
    }
}

@MainActor @Observable final class CostPermissionController {
    let ownerID: String
    private(set) var quote: EstimatedCostQuote
    private(set) var state: CostPermissionDisplayState = .pending
    private(set) var receipt: EstimatedCostDecisionReceipt?
    private(set) var canonicalStatus: String?
    private(set) var canonicalGrantExpiry: String?
    private(set) var canonicalNotice: String?
    @ObservationIgnored private let store: any CostPermissionRecoveryStore
    @ObservationIgnored private let connectionIsCurrent: @MainActor () -> Bool
    @ObservationIgnored private let send: @MainActor (EstimatedCostDecision) async -> EstimatedCostDecisionReceipt?
    @ObservationIgnored private let readReceipt: @MainActor (EstimatedCostDecision) async -> EstimatedCostDecisionReceipt?
    @ObservationIgnored private let decisionID: @MainActor () -> String
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private var pending: PendingCostPermissionDecision?

    init(ownerID: String, quote: EstimatedCostQuote, store: any CostPermissionRecoveryStore,
         connectionIsCurrent: @escaping @MainActor () -> Bool,
         send: @escaping @MainActor (EstimatedCostDecision) async -> EstimatedCostDecisionReceipt?,
         readReceipt: @escaping @MainActor (EstimatedCostDecision) async -> EstimatedCostDecisionReceipt?,
         previousReceipt: EstimatedCostDecisionReceipt? = nil,
         decisionID: @escaping @MainActor () -> String = { UUID().uuidString.lowercased() },
         now: @escaping @MainActor () -> Date = { Date() }) {
        self.ownerID = ownerID; self.quote = quote; self.store = store; self.receipt = previousReceipt
        self.connectionIsCurrent = connectionIsCurrent; self.send = send; self.readReceipt = readReceipt
        self.decisionID = decisionID; self.now = now
    }

    func restore() {
        guard connectionIsCurrent(), quote.isValid else { state = .unavailable; return }
        do {
            if let saved = try store.load(ownerID: ownerID, operationID: quote.operationId) {
                guard saved.ownerID == ownerID, saved.quote.isValid,
                      ["approve", "decline"].contains(saved.decision.decision),
                      !saved.decision.decisionId.isEmpty,
                      saved.decision.operationId == quote.operationId,
                      saved.decision.operationId == saved.quote.operationId,
                      saved.decision.quoteId == saved.quote.quoteId,
                      saved.decision.quoteVersion == saved.quote.quoteVersion else { state = .unavailable; return }
                pending = saved
                state = .unconfirmed
            } else if let expiry = quote.expiry, expiry <= now() { state = .expired }
            else { state = .pending }
        } catch { state = .unavailable }
    }

    /// A request projection can disable actions, but cannot settle an earlier
    /// ambiguous decision made by this device.
    func apply(_ projection: EstimatedCostRequestProjection) {
        guard connectionIsCurrent(), projection.isValid(for: quote.operationId) else {
            state = pending == nil ? .unavailable : .unconfirmed
            return
        }
        canonicalStatus = projection.status
        canonicalGrantExpiry = projection.grantExpiresAt
        canonicalNotice = projection.reason
        if pending != nil { state = .unconfirmed; return }
        if let refreshed = projection.quote { quote = refreshed }
        switch projection.status {
        case "pending": state = quote.expiry.map { $0 <= now() } == true ? .expired : .pending
        case "approved": state = .approved
        case "declined": state = .declined
        case "expired_or_needs_refresh": state = .expired
        case "cancelled": state = .cancelled
        default: state = .unavailable
        }
    }

    func decide(_ answer: String) async {
        guard (state == .pending || (state == .expired && answer == "decline")), connectionIsCurrent(), quote.isValid, quote.complete,
              ["approve", "decline"].contains(answer) else { return }
        guard let expiry = quote.expiry else { state = .unavailable; return }
        if expiry <= now() && answer == "approve" { state = .expired; return }
        guard answer != "approve" || quote.canApprove else { return }
        let id = decisionID()
        guard !id.isEmpty, id.utf8.count <= 200 else { state = .unavailable; return }
        let decision = EstimatedCostDecision(operationId: quote.operationId, quoteId: quote.quoteId,
            quoteVersion: quote.quoteVersion, decisionId: id, decision: answer)
        let saved = PendingCostPermissionDecision(ownerID: ownerID, quote: quote, decision: decision)
        // Set the state before any suspension so two taps cannot race.
        state = .submitting
        do { try store.save(saved) } catch { state = .unavailable; return }
        pending = saved
        guard connectionIsCurrent() else { state = .unconfirmed; return }
        let receipt = await send(decision)
        resolve(receipt, pending: saved)
    }

    func checkDecision() async {
        guard state == .unconfirmed, connectionIsCurrent(), let saved = pending else { return }
        state = .submitting
        let receipt = await readReceipt(saved.decision)
        resolve(receipt, pending: saved)
    }

    private func resolve(_ receipt: EstimatedCostDecisionReceipt?, pending saved: PendingCostPermissionDecision) {
        guard connectionIsCurrent(), let receipt, receipt.confirms(saved.decision, quote: saved.quote) else {
            state = .unconfirmed; return
        }
        do { try store.remove(ownerID: saved.ownerID, operationID: saved.quote.operationId) }
        catch { state = .unconfirmed; return }
        pending = nil
        self.receipt = receipt
        switch receipt.status {
        case "approved": state = .approved
        case "declined": state = .declined
        case "stale": state = .changed
        default: state = .unconfirmed
        }
    }
}

struct EstimatedCostReviewScreen: View {
    let operationID: String
    @Environment(AppModel.self) private var model
    @State private var controller: CostPermissionController?
    @State private var displayedConnectionVersion: Int?
    @State private var standaloneProjection: EstimatedCostRequestProjection?
    @State private var loading = true
    @State private var unavailable = false
    @State private var quoteRequestID: String?
    @State private var quoteRefreshUnconfirmed = false
    @State private var sessionVersion: Int?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let controller, displayedConnectionVersion == model.activityConnectionVersion {
                    TimelineView(.periodic(from: .now, by: 1)) { timeline in
                        let display = CostPermissionDisplay(quote: controller.quote, state: controller.state, now: timeline.date)
                        VStack(spacing: 16) {
                            CostPermissionReviewCard(display: display, canonicalNotice: controller.canonicalNotice,
                                canonicalStatus: controller.canonicalStatus, canonicalGrantExpiry: controller.canonicalGrantExpiry,
                                receipt: controller.receipt,
                                approve: { await controller.decide("approve") },
                                decline: { await controller.decide("decline") },
                                check: { await controller.checkDecision() })
                            if display.state == .expired || display.state == .changed {
                                Button("Request an updated quote") { Task { await requestUpdatedQuote() } }
                                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true))
                                    .disabled(quoteRefreshUnconfirmed || loading)
                            }
                        }
                    }
                    if quoteRefreshUnconfirmed {
                        Text("The updated quote could not be confirmed. Check this request before requesting another.")
                            .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    }
                } else if loading {
                    ProgressView("Checking request…")
                } else if displayedConnectionVersion == model.activityConnectionVersion,
                          let projection = standaloneProjection, projection.status == "cancelled" {
                    Text("This request was cancelled.").font(.subheadline)
                } else if displayedConnectionVersion == model.activityConnectionVersion,
                          let projection = standaloneProjection, projection.status == "unavailable" {
                    Text(projection.reason ?? "This request’s current status is unavailable.")
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("This request is unavailable. Its decision has not been confirmed here.")
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
                Button("Check request") { Task { await load() } }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true))
                    .disabled(loading || controller?.state == .submitting)
            }
            .padding(16)
        }
        .navigationTitle("Review spending")
        .assistantSubmenuChrome()
        .task(id: model.activityConnectionVersion) {
            let version = model.activityConnectionVersion
            if sessionVersion != version {
                sessionVersion = version
                controller = nil; displayedConnectionVersion = nil; standaloneProjection = nil
                quoteRequestID = nil; quoteRefreshUnconfirmed = false
            }
            await load()
        }
    }

    private func load() async {
        guard controller?.state != .submitting else { return }
        guard let context = model.checklistCorrectionRequestContext() else { loading = false; unavailable = true; return }
        loading = true
        let priorQuoteID = controller?.quote.quoteId
        let priorVersion = controller?.quote.quoteVersion
        let store = KeychainCostPermissionRecoveryStore(serverIdentity: context.client.configuration.baseURL.absoluteString)
        let saved: PendingCostPermissionDecision?
        do { saved = try store.load(ownerID: context.ownerID, operationID: operationID) }
        catch { loading = false; unavailable = true; return }
        let projection = try? await context.client.estimatedCostQuote(operationID: operationID)
        guard !Task.isCancelled, model.checklistCorrectionConnectionIsCurrent(ownerID: context.ownerID, version: context.connectionVersion) else { loading = false; return }
        guard let quote = saved?.quote ?? projection?.quote else {
            controller = nil; standaloneProjection = projection; displayedConnectionVersion = context.connectionVersion
            loading = false; unavailable = projection == nil; return
        }
        let model = model
        let owner = context.ownerID
        let version = context.connectionVersion
        let current = { model.checklistCorrectionConnectionIsCurrent(ownerID: owner, version: version) }
        let previousReceipt = displayedConnectionVersion == version ? controller?.receipt : nil
        let next = CostPermissionController(ownerID: owner, quote: quote, store: store, connectionIsCurrent: current,
            send: { try? await context.client.decideEstimatedCost($0) },
            readReceipt: { try? await context.client.estimatedCostDecisionReceipt($0) }, previousReceipt: previousReceipt)
        next.restore()
        if let projection { next.apply(projection) }
        else if saved == nil { controller = nil; unavailable = true; loading = false; return }
        if quoteRefreshUnconfirmed, let refreshed = projection?.quote,
           refreshed.quoteId != priorQuoteID || refreshed.quoteVersion != priorVersion {
            quoteRefreshUnconfirmed = false
            quoteRequestID = nil
        }
        controller = next
        standaloneProjection = nil
        displayedConnectionVersion = context.connectionVersion
        loading = false
        unavailable = false
    }

    private func requestUpdatedQuote() async {
        guard !loading, !quoteRefreshUnconfirmed, let context = model.checklistCorrectionRequestContext() else { return }
        let id = quoteRequestID ?? UUID().uuidString.lowercased()
        quoteRequestID = id
        loading = true
        do {
            let projection = try await context.client.requestEstimatedCostQuote(operationID: operationID, quoteRequestID: id)
            guard !Task.isCancelled, model.checklistCorrectionConnectionIsCurrent(ownerID: context.ownerID, version: context.connectionVersion) else { loading = false; return }
            controller?.apply(projection)
            quoteRequestID = nil
        } catch {
            guard !Task.isCancelled, model.checklistCorrectionConnectionIsCurrent(ownerID: context.ownerID, version: context.connectionVersion) else { loading = false; return }
            quoteRefreshUnconfirmed = true
        }
        loading = false
    }
}

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
                        emptyStateTitle,
                        systemImage: "waveform.path.ecg",
                        description: emptyStateDescription
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
                    Text("Detailed audit evidence may be unavailable or redacted.")
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
        .navigationTitle(showingArchived ? "Archived activity" : "Activity")
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

    private var emptyStateTitle: String {
        if discovery != nil {
            return "No matching recorded work"
        }
        if filter == .all {
            return showingArchived ? "No archived activity" : "No activity yet"
        }
        return showingArchived ? "No archived activity matches this filter" : "Nothing here"
    }

    private var emptyStateDescription: String {
        if discovery != nil {
            return "Submit a search or change the activity filter. If more records are available, continue to older records."
        }
        if showingArchived {
            return filter == .all
                ? "Archived tasks appear here. Show current activity to browse tasks that aren’t archived."
                : "Try another filter or show current activity."
        }
        return filter == .all
            ? "Work you hand off in chat will appear here with its evidence and decisions."
            : "Try another activity filter."
    }

    private func activityCard(_ item: ActivityItem) -> some View {
        VStack(alignment: .leading, spacing: item.status == "done" ? 8 : AssistantTheme.cardContentSpacing) {
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
            DisclosureGroup("Task record") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Task ID: \(item.id)")
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
