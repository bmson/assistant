import Foundation

/// Presentation identity only. Neither these values nor a readable snapshot grant write authority.
struct MemoryCorrectionTarget: Equatable, Sendable {
    let ownerID: String
    let serverID: String
    let memoryID: String
    let sourceIdentity: String?
}

enum MemoryCorrectionSnapshotAvailability: Equatable, Sendable {
    case mayRequestAuthorization
    case readOnly(reason: String)
}

struct MemoryCorrectionSnapshot: Equatable, Sendable {
    let target: MemoryCorrectionTarget
    let revision: String
    /// Stored source identity, never recomputed from displayed content by this presentation layer.
    let storedContentHash: String?
    let content: String
    let sourceLabel: String
    let availability: MemoryCorrectionSnapshotAvailability
}

/// Supplied by a future qualified adapter; this view never issues operation IDs or holds grant secrets.
struct MemoryCorrectionOperation: Equatable, Sendable {
    let operationID: String
    let target: MemoryCorrectionTarget
    let expectedRevision: String
    let expectedStoredContentHash: String?
}

struct MemoryCorrectionAuthorizationRequest: Equatable, Sendable {
    /// Local callback correlation, not a bearer session, server operation, or authorization proof.
    let presentationID: UUID
    let requestID: UUID
    let snapshot: MemoryCorrectionSnapshot
    let draft: String
}

struct MemoryCorrectionReadRequest: Equatable, Sendable {
    let presentationID: UUID
    let requestID: UUID
    let target: MemoryCorrectionTarget
    let operation: MemoryCorrectionOperation?
}

enum MemoryCorrectionIntent: Equatable, Sendable {
    case requestAuthorization(MemoryCorrectionAuthorizationRequest)
    case submit(MemoryCorrectionOperation, draft: String)
    case checkResult(MemoryCorrectionOperation)
    case refreshSavedNote(MemoryCorrectionReadRequest)
    case close
}

enum MemoryCorrectionAuthorizationResult: Equatable, Sendable {
    case authorized(MemoryCorrectionOperation)
    case stale(MemoryCorrectionSnapshot)
    case unavailable(String)
}

/// These are adapter dispositions, not values inferred from HTTP success or queue admission.
enum MemoryCorrectionDisposition: Equatable, Sendable {
    case saved(readback: MemoryCorrectionSnapshot?)
    case unchanged(readback: MemoryCorrectionSnapshot?)
    case uncertain
    case pending
    case staleNoWrite(MemoryCorrectionSnapshot)
    case rejectedNoWrite(String)
}

/// Unmounted in-memory state. It performs no networking, grant validation, or persistence.
struct MemoryCorrectionPresentation: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case editing, authorizing, submitting, pending, unknown, stale, saved, unchanged, unavailable, cancelled
    }

    /// Local view lifetime, deliberately unrelated to mobile authentication/session semantics.
    let presentationID: UUID
    let openedSnapshot: MemoryCorrectionSnapshot
    private(set) var reviewedSnapshot: MemoryCorrectionSnapshot
    private(set) var currentSnapshot: MemoryCorrectionSnapshot?
    private(set) var resultReadback: MemoryCorrectionSnapshot?
    private(set) var draft: String
    private(set) var phase: Phase = .editing
    private(set) var operation: MemoryCorrectionOperation?
    private(set) var authorizationRequest: MemoryCorrectionAuthorizationRequest?
    private(set) var readRequest: MemoryCorrectionReadRequest?
    private(set) var message: String?
    private(set) var isChecking = false
    private(set) var outcomeVersion: Int?

    init(snapshot: MemoryCorrectionSnapshot, presentationID: UUID = UUID()) {
        self.presentationID = presentationID
        openedSnapshot = snapshot
        reviewedSnapshot = snapshot
        draft = snapshot.content
    }

    var canEditDraft: Bool { [.editing, .unavailable, .stale].contains(phase) }
    var canRequestAuthorization: Bool {
        [.editing, .unavailable].contains(phase)
            && reviewedSnapshot.availability == .mayRequestAuthorization
            && draft.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3
    }
    var canCheckResult: Bool { [.unknown, .pending].contains(phase) && operation != nil && !isChecking }
    var canReviewCurrent: Bool { phase == .stale && currentSnapshot != nil }
    var hasDispatchedSave: Bool { operation != nil }

    var statusText: String? {
        switch phase {
        case .editing:
            if case .readOnly(let reason) = reviewedSnapshot.availability { reason } else { nil }
        case .cancelled: nil
        case .authorizing: "Checking editing availability…"
        case .submitting: "Saving…"
        case .pending: isChecking ? "Checking save result…" : "Save pending. Its result is not confirmed yet."
        case .unknown: isChecking ? "Checking save result…" : "Save result unknown. Check result before saving again."
        case .stale: "Review the current saved note before saving your draft."
        case .saved: resultReadback == nil ? "Saved. The latest view has not been refreshed." : "Saved."
        case .unchanged: "No change was needed."
        case .unavailable: message ?? "Editing is unavailable. Your draft is still here."
        }
    }

    mutating func editDraft(_ text: String) {
        guard canEditDraft else { return }
        draft = text
    }

    mutating func requestSave() -> MemoryCorrectionIntent? {
        guard canRequestAuthorization else { return nil }
        let request = MemoryCorrectionAuthorizationRequest(
            presentationID: presentationID, requestID: UUID(), snapshot: reviewedSnapshot, draft: draft
        )
        authorizationRequest = request
        readRequest = nil
        resultReadback = nil
        phase = .authorizing
        message = nil
        return .requestAuthorization(request)
    }

    mutating func receiveAuthorization(
        for request: MemoryCorrectionAuthorizationRequest,
        result: MemoryCorrectionAuthorizationResult
    ) -> MemoryCorrectionIntent? {
        guard phase == .authorizing, request == authorizationRequest,
              request.presentationID == presentationID else { return nil }
        switch result {
        case .authorized(let issued):
            guard !issued.operationID.isEmpty, issued.target == request.snapshot.target,
                  issued.expectedRevision == request.snapshot.revision,
                  issued.expectedStoredContentHash == request.snapshot.storedContentHash else { return nil }
            operation = issued
            outcomeVersion = nil
            phase = .submitting
            return .submit(issued, draft: request.draft)
        case .stale(let current):
            guard current.target == reviewedSnapshot.target else { return nil }
            currentSnapshot = current
            phase = .stale
        case .unavailable(let explanation):
            message = explanation
            phase = .unavailable
        }
        return nil
    }

    /// Queue acceptance deliberately cannot resolve Saving or dismiss the sheet.
    mutating func receiveQueueAcceptance(for issued: MemoryCorrectionOperation) {
        guard issued == operation else { return }
    }

    @discardableResult
    mutating func receiveOutcome(
        presentationID deliveredPresentationID: UUID,
        operation issued: MemoryCorrectionOperation,
        version: Int,
        disposition: MemoryCorrectionDisposition
    ) -> Bool {
        guard deliveredPresentationID == presentationID, issued == operation,
              [.submitting, .unknown, .pending].contains(phase), version >= 0 else { return false }
        if let outcomeVersion, version <= outcomeVersion {
            if version == outcomeVersion, [.unknown, .pending].contains(phase), case .uncertain = disposition {
                isChecking = false
                return true
            }
            if version == outcomeVersion, phase == .pending, case .pending = disposition {
                isChecking = false
                return true
            }
            return false
        }
        switch disposition {
        case .saved(let readback), .unchanged(let readback):
            guard readback == nil || readback?.target == reviewedSnapshot.target else { return false }
            resultReadback = readback
            if let readback { currentSnapshot = readback }
            if case .saved = disposition { phase = .saved } else { phase = .unchanged }
        case .uncertain:
            phase = .unknown
        case .pending:
            phase = .pending
        case .staleNoWrite(let current):
            guard current.target == reviewedSnapshot.target else { return false }
            currentSnapshot = current
            phase = .stale
        case .rejectedNoWrite(let explanation):
            message = explanation
            phase = .unavailable
        }
        outcomeVersion = version
        isChecking = false
        return true
    }

    /// A terminal stale disposition without a new snapshot cannot fabricate a current value.
    mutating func requireCurrentReview(presentationID deliveredID: UUID, operation issued: MemoryCorrectionOperation, version: Int) {
        guard deliveredID == presentationID, issued == operation,
              [.submitting, .unknown, .pending].contains(phase) else { return }
        phase = .stale; currentSnapshot = nil; resultReadback = nil
        outcomeVersion = version; isChecking = false
    }

    mutating func checkResult() -> MemoryCorrectionIntent? {
        guard canCheckResult, let operation else { return nil }
        isChecking = true
        return .checkResult(operation)
    }

    /// A failed status read is still unknown; it neither retries the mutation nor drops its identity.
    mutating func checkFailed(presentationID deliveredID: UUID, operation issued: MemoryCorrectionOperation) {
        guard deliveredID == presentationID, operation == issued, [.unknown, .pending].contains(phase) else { return }
        isChecking = false
    }

    mutating func reviewCurrentKeepingDraft() {
        guard canReviewCurrent, let currentSnapshot else { return }
        reviewedSnapshot = currentSnapshot
        authorizationRequest = nil
        readRequest = nil
        operation = nil
        outcomeVersion = nil
        message = nil
        phase = .editing
    }

    mutating func requestRefresh() -> MemoryCorrectionIntent? {
        guard ![.authorizing, .submitting, .cancelled].contains(phase) else { return nil }
        let request = MemoryCorrectionReadRequest(presentationID: presentationID, requestID: UUID(),
            target: reviewedSnapshot.target, operation: operation)
        readRequest = request
        return .refreshSavedNote(request)
    }

    /// Readback is presentation data, never a replacement write grant or terminal operation proof.
    @discardableResult
    mutating func receiveCurrentSnapshot(for request: MemoryCorrectionReadRequest, snapshot: MemoryCorrectionSnapshot) -> Bool {
        guard request == readRequest, request.presentationID == presentationID,
              request.operation == operation, snapshot.target == reviewedSnapshot.target,
              ![.authorizing, .submitting, .cancelled].contains(phase) else { return false }
        readRequest = nil
        currentSnapshot = snapshot
        if [.editing, .unavailable].contains(phase), snapshot != reviewedSnapshot { phase = .stale }
        return true
    }

    /// Only a qualified adapter's operation-bound readback may clear the pending-readback message.
    /// A generic successful read must use receiveCurrentSnapshot instead.
    @discardableResult
    mutating func receiveConfirmedReadback(for request: MemoryCorrectionReadRequest, snapshot: MemoryCorrectionSnapshot) -> Bool {
        guard [.saved, .unchanged].contains(phase), request.operation != nil,
              request.operation == operation,
              receiveCurrentSnapshot(for: request, snapshot: snapshot) else { return false }
        resultReadback = snapshot
        return true
    }

    mutating func cancelBeforeDispatch() -> MemoryCorrectionIntent? {
        guard operation == nil, ![.saved, .unchanged, .cancelled].contains(phase) else { return nil }
        draft = ""
        authorizationRequest = nil
        readRequest = nil
        phase = .cancelled
        return .close
    }

    /// Host must retain this model if it offers Close/reopen; no durable restoration is promised.
    func close() -> MemoryCorrectionIntent { .close }
}
