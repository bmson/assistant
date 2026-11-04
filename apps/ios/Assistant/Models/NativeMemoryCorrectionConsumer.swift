import Foundation
import Observation

protocol NativeMemoryCorrectionTransport: Sendable {
    func ownerMemoryCorrectionSnapshot(memoryID: String) async throws -> OwnerMemoryCorrectionSnapshot
    func authorizeOwnerMemoryCorrection(memoryID: String, expectedContentHash: String, expectedMemoryRevision: String, content: String) async throws -> OwnerMemoryCorrectionAuthorization
    func makeOwnerMemoryCorrectionOperation(memoryID: String, authorization: OwnerMemoryCorrectionAuthorization) throws -> OwnerMemoryCorrectionOperation
    func applyOwnerMemoryCorrection(_ operation: OwnerMemoryCorrectionOperation) async -> OwnerMemoryCorrectionApplyResult
    func ownerMemoryCorrectionStatus(_ operation: OwnerMemoryCorrectionOperation) async throws -> OwnerMemoryCorrectionReply
}
extension APIClient: NativeMemoryCorrectionTransport {}

protocol NativeMemoryCorrectionStorage: Sendable {
    func saveBeforeDispatch(_ record: NativeMemoryCorrectionRecoveryRecord) async throws
    func loadPending(serverIdentity: String, target: NativeMemoryCorrectionRecoveryRecord.Target) async throws -> NativeMemoryCorrectionRecoveryRecord?
    func remove(serverIdentity: String, target: NativeMemoryCorrectionRecoveryRecord.Target, operationID: String, disposition: NativeMemoryCorrectionRecoveryTerminalDisposition) async throws
}
extension NativeMemoryCorrectionRecoveryStore: NativeMemoryCorrectionStorage {}

/// Verified by authenticated bootstrap and the current API configuration, never by row text.
struct NativeMemoryCorrectionScope: Equatable, Sendable {
    let ownerID: String
    let serverIdentity: String
    func target(_ memoryID: String) -> MemoryCorrectionTarget {
        .init(ownerID: ownerID, serverID: serverIdentity, memoryID: memoryID, sourceIdentity: nil)
    }
}

@MainActor @Observable
final class NativeMemoryCorrectionConsumer {
    private(set) var presentation: MemoryCorrectionPresentation?
    private(set) var loading = false
    private(set) var errorMessage: String?
    private(set) var retainedOnDevice = false
    private(set) var cleanupMessage: String?
    private(set) var blockedMemoryIDs = Set<String>()
    @ObservationIgnored var onInterlockChanged: (@MainActor () -> Void)?
    @ObservationIgnored private let storage: (any NativeMemoryCorrectionStorage)?
    @ObservationIgnored private var scope: NativeMemoryCorrectionScope?
    @ObservationIgnored private var bindingID: Int?
    @ObservationIgnored private var transport: (any NativeMemoryCorrectionTransport)?
    @ObservationIgnored private var currentBinding: @MainActor () -> Bool = { false }
    @ObservationIgnored private var hasGenericWrite: @MainActor (String) -> Bool = { _ in true }
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var operation: OwnerMemoryCorrectionOperation?
    @ObservationIgnored private var recovery: NativeMemoryCorrectionRecoveryRecord?
    @ObservationIgnored private var terminalReply: OwnerMemoryCorrectionReply?
    @ObservationIgnored private var snapshotOwnerCorrected: [String: Bool] = [:]

    init(storage: (any NativeMemoryCorrectionStorage)? = try? NativeMemoryCorrectionRecoveryStore()) {
        self.storage = storage
    }

    func bind(scope: NativeMemoryCorrectionScope, transport: any NativeMemoryCorrectionTransport, bindingID: Int = 0,
              isCurrent: @escaping @MainActor () -> Bool,
              hasGenericWrite: @escaping @MainActor (String) -> Bool) {
        if self.scope != scope || self.bindingID != bindingID { retire() }
        self.scope = scope
        self.bindingID = bindingID
        self.transport = transport
        currentBinding = isCurrent
        self.hasGenericWrite = hasGenericWrite
    }

    func retire() {
        generation = UUID()
        presentation = nil; loading = false; errorMessage = nil
        retainedOnDevice = false; cleanupMessage = nil
        operation = nil; recovery = nil; terminalReply = nil
        scope = nil; bindingID = nil; transport = nil; currentBinding = { false }; snapshotOwnerCorrected = [:]
        blockedMemoryIDs = []; onInterlockChanged?()
        // Unknown encrypted records stay in their original owner/server partition.
    }

    func open(memoryID: String) async {
        if let previous = presentation, previous.operation == nil, let scope {
            unblock(previous.reviewedSnapshot.target.memoryID, scope: scope)
        }
        let token = UUID(); generation = token
        presentation = nil; errorMessage = nil; cleanupMessage = nil; loading = true
        retainedOnDevice = false; operation = nil; recovery = nil; terminalReply = nil
        guard let scope, let transport, currentBinding(), let storage else {
            loading = false; errorMessage = "Connect to your assistant before editing this saved note."; return
        }
        let target = scope.target(memoryID)
        var noPendingVerified = false
        do {
            let pending = try await storage.loadPending(serverIdentity: scope.serverIdentity, target: target.recoveryTarget)
            guard valid(token, target) else { return }
            if let record = pending {
                let restored = try Self.restore(record, transport: transport)
                var state = MemoryCorrectionPresentation(snapshot: Self.snapshot(record))
                state.editDraft(record.draft)
                guard case .requestAuthorization(let request) = state.requestSave() else { throw APIError.invalidResponse }
                let issued = Self.presentedOperation(restored, target: target)
                _ = state.receiveAuthorization(for: request, result: .authorized(issued))
                _ = state.receiveOutcome(presentationID: state.presentationID, operation: issued, version: 0, disposition: .uncertain)
                snapshotOwnerCorrected[record.snapshot.revision] = record.snapshot.ownerCorrected
                operation = restored; recovery = record; retainedOnDevice = true
                presentation = state; block(memoryID); loading = false
                return // Reopening never authorizes or replays an apply, or checks status automatically.
            }
            noPendingVerified = true
            // A successful scoped lookup can finish a previously interrupted qualified
            // cleanup. Reopening is the explicit recovery action for an old I/O fence.
            unblock(memoryID, scope: scope)
            let wire = try await transport.ownerMemoryCorrectionSnapshot(memoryID: memoryID)
            guard valid(token, target) else { return }
            snapshotOwnerCorrected[wire.revision] = wire.ownerCorrected
            presentation = MemoryCorrectionPresentation(snapshot: try Self.snapshot(wire, target: target))
            loading = false
        } catch {
            guard valid(token, target) else { return }
            loading = false
            errorMessage = "This saved note could not be verified for editing. Any earlier save must be checked before saving again."
            if !noPendingVerified { block(memoryID) } // An unreadable recovery store is not an empty store.
        }
    }

    /// Also checks the durable locator before a legacy same-target write after relaunch.
    func permitsLegacyWrite(memoryID: String) async -> Bool {
        guard let scope, currentBinding(), let storage else { return false }
        if blockedMemoryIDs.contains(memoryID) { return false }
        do {
            let pending = try await storage.loadPending(serverIdentity: scope.serverIdentity, target: scope.target(memoryID).recoveryTarget)
            guard self.scope == scope, currentBinding() else { return false }
            if pending != nil { block(memoryID); return false }
            return !blockedMemoryIDs.contains(memoryID)
        } catch { block(memoryID); return false }
    }

    func handle(_ intent: MemoryCorrectionIntent) async {
        switch intent {
        case .requestAuthorization(let request): await authorize(request)
        case .checkResult(let issued): await check(issued)
        case .refreshSavedNote(let request): await refresh(request)
        case .close: close()
        case .submit: break // Only the persisted authorization path below can dispatch.
        }
    }

    func editDraft(_ text: String) { presentation?.editDraft(text) }
    func updatePresentation(_ state: MemoryCorrectionPresentation) {
        guard state.presentationID == presentation?.presentationID,
              state.reviewedSnapshot.target == presentation?.reviewedSnapshot.target,
              currentBinding() else { return }
        presentation = state
    }
    func close() {
        if presentation?.operation == nil {
            if let id = presentation?.reviewedSnapshot.target.memoryID, let scope { unblock(id, scope: scope) }
            _ = presentation?.cancelBeforeDispatch()
        }
        generation = UUID() // Retire callbacks from this mounted presentation, including late authorization.
        if presentation?.operation == nil { presentation = nil }
        loading = false
    }

    private func authorize(_ request: MemoryCorrectionAuthorizationRequest) async {
        guard let state = presentation, state.authorizationRequest == request, state.phase == .authorizing,
              let scope, let transport, let storage, currentBinding(),
              request.snapshot.target == scope.target(request.snapshot.target.memoryID) else { return }
        let target = request.snapshot.target, token = generation
        guard !hasGenericWrite(target.memoryID) else {
            _ = presentation?.receiveAuthorization(for: request, result: .unavailable("An earlier save for this note needs review before another correction.")); return
        }
        block(target.memoryID)
        var persistenceAttempted = false
        do {
            guard let hash = request.snapshot.storedContentHash else { throw APIError.invalidResponse }
            let authorization = try await transport.authorizeOwnerMemoryCorrection(memoryID: target.memoryID,
                expectedContentHash: hash, expectedMemoryRevision: request.snapshot.revision, content: request.draft)
            guard valid(token, target), presentation?.authorizationRequest == request else { return }
            let apiOperation = try transport.makeOwnerMemoryCorrectionOperation(memoryID: target.memoryID, authorization: authorization)
            guard apiOperation.isBoundToServerAuthorization else { throw APIError.invalidResponse }
            let record = NativeMemoryCorrectionRecoveryRecord(serverIdentity: scope.serverIdentity,
                target: target.recoveryTarget,
                operation: .init(operationID: authorization.operationId, expectedRevision: authorization.expectedMemoryRevision,
                                 expectedStoredContentHash: authorization.expectedContentHash),
                snapshot: .init(revision: request.snapshot.revision, storedContentHash: hash,
                    content: request.snapshot.content, sourceLabel: request.snapshot.sourceLabel,
                    ownerCorrected: snapshotOwnerCorrected[request.snapshot.revision] ?? false, readOnlyReason: nil),
                draft: request.draft, authorizationHandle: authorization.authorization,
                authorizationExpiresAt: authorization.expiresAt)
            persistenceAttempted = true
            try await storage.saveBeforeDispatch(record)
            guard valid(token, target), presentation?.authorizationRequest == request, !hasGenericWrite(target.memoryID) else {
                // Authorization/persistence completed after Cancel or scope change: no apply.
                do {
                    try await storage.remove(serverIdentity: scope.serverIdentity, target: target.recoveryTarget,
                        operationID: authorization.operationId, disposition: .rejectedNoWrite)
                    unblock(target.memoryID, scope: scope)
                } catch {
                    // A failed cleanup cannot authorize another same-target write.
                    if self.scope == scope { block(target.memoryID) }
                }
                return
            }
            operation = apiOperation; recovery = record; retainedOnDevice = true
            let issued = Self.presentedOperation(apiOperation, target: target)
            guard case .submit = presentation?.receiveAuthorization(for: request, result: .authorized(issued)) else { return }
            let result = await transport.applyOwnerMemoryCorrection(apiOperation) // exactly once, after durable ack
            guard valid(token, target), presentation?.operation == issued else { return }
            switch result {
            case .replied(let reply): await receive(reply, issued: issued, token: token)
            case .uncertain, .cancelled:
                _ = presentation?.receiveOutcome(presentationID: state.presentationID, operation: issued, version: 0, disposition: .uncertain)
            }
        } catch {
            guard valid(token, target), presentation?.authorizationRequest == request else { return }
            if case NativeMemoryCorrectionRecoveryError.recoveryCleanupUncertain = error {
                cleanupMessage = "No correction was sent. Local recovery cleanup could not be confirmed. Reopen this note before saving again."
            }
            if case APIError.server(status: 409, _) = error,
               let wire = try? await transport.ownerMemoryCorrectionSnapshot(memoryID: target.memoryID),
               valid(token, target), let current = try? Self.snapshot(wire, target: target) {
                _ = presentation?.receiveAuthorization(for: request, result: .stale(current))
            } else {
                _ = presentation?.receiveAuthorization(for: request, result: .unavailable("Editing is unavailable. Your draft is still here. No correction was sent."))
            }
            // A failed durable write is not an acknowledgment; leave its target fail-closed.
            if retainedOnDevice { retainedOnDevice = false }
            if !persistenceAttempted { unblock(target.memoryID, scope: scope) }
        }
    }

    private func check(_ issued: MemoryCorrectionOperation) async {
        guard let state = presentation, state.operation == issued, state.isChecking,
              [.unknown, .pending].contains(state.phase), let operation, let transport, currentBinding() else { return }
        let token = generation
        do {
            let reply = try await transport.ownerMemoryCorrectionStatus(operation)
            guard valid(token, issued.target), presentation?.operation == issued else { return }
            await receive(reply, issued: issued, token: token)
        } catch {
            guard valid(token, issued.target) else { return }
            presentation?.checkFailed(presentationID: state.presentationID, operation: issued)
        }
    }

    private func receive(_ reply: OwnerMemoryCorrectionReply, issued: MemoryCorrectionOperation, token: UUID) async {
        guard let operation, valid(token, issued.target), reply.command == "correct_owner_memory",
              reply.operationId == operation.authorization.operationId,
              reply.requestHash == nil || reply.requestHash == operation.requestHash,
              let id = presentation?.presentationID else { return }
        if reply.authority == "unresolved", reply.isUnresolved {
            _ = presentation?.receiveOutcome(presentationID: id, operation: issued, version: 0,
                                            disposition: reply.reason == "preparing" ? .pending : .uncertain)
            return
        }
        guard reply.isTerminal else {
            _ = presentation?.receiveOutcome(presentationID: id, operation: issued, version: 0, disposition: .uncertain); return
        }
        let version = reply.statusVersion ?? 1
        if ["saved", "unchanged"].contains(reply.outcome) {
            guard reply.authority == "operation_receipt", reply.requestHash == operation.requestHash,
                  reply.ids?["memoryId"] == operation.memoryId, Self.hash(reply.revision) else {
                _ = presentation?.receiveOutcome(presentationID: id, operation: issued, version: 0, disposition: .uncertain); return
            }
            terminalReply = reply
            let disposition: MemoryCorrectionDisposition = reply.outcome == "saved" ? .saved(readback: nil) : .unchanged(readback: nil)
            _ = presentation?.receiveOutcome(presentationID: id, operation: issued, version: version, disposition: disposition)
            if let request = presentation?.requestRefresh(), case .refreshSavedNote(let read) = request { await refresh(read) }
        } else {
            // A typed terminal no-effect result may release recovery; a request rejection may not.
            if reply.outcome == "conflict" {
                presentation?.requireCurrentReview(presentationID: id, operation: issued, version: version)
                if let request = presentation?.requestRefresh(), case .refreshSavedNote(let read) = request { await refresh(read) }
            } else {
                _ = presentation?.receiveOutcome(presentationID: id, operation: issued, version: version,
                    disposition: .rejectedNoWrite("This correction was not applied. Your draft is still here."))
            }
            await removeRecovery(.rejectedNoWrite, token: token)
        }
    }

    private func refresh(_ request: MemoryCorrectionReadRequest) async {
        guard let transport, currentBinding(), presentation?.readRequest == request else { return }
        let token = generation
        do {
            let wire = try await transport.ownerMemoryCorrectionSnapshot(memoryID: request.target.memoryID)
            guard valid(token, request.target), presentation?.readRequest == request else { return }
            snapshotOwnerCorrected[wire.revision] = wire.ownerCorrected
            let current = try Self.snapshot(wire, target: request.target)
            if let terminalReply, let operation, request.operation == presentation?.operation,
               wire.revision == terminalReply.revision, Self.hash(wire.contentHash), wire.content == operation.request.content,
               terminalReply.ids?["memoryId"] == wire.memoryId {
                if presentation?.receiveConfirmedReadback(for: request, snapshot: current) == true {
                    await removeRecovery(terminalReply.outcome == "saved" ? .savedWithOperationBoundReadback : .unchangedWithOperationBoundReadback, token: token)
                }
            } else { _ = presentation?.receiveCurrentSnapshot(for: request, snapshot: current) }
        } catch { /* A failed read is neither operation proof nor permission to replay. */ }
    }

    private func removeRecovery(_ disposition: NativeMemoryCorrectionRecoveryTerminalDisposition, token: UUID) async {
        guard let storage, let record = recovery, let scope, valid(token, record.presentationTarget) else { return }
        do {
            try await storage.remove(serverIdentity: record.serverIdentity, target: record.target,
                operationID: record.operation.operationID, disposition: disposition)
            guard valid(token, record.presentationTarget) else { return }
            retainedOnDevice = false; recovery = nil; unblock(record.target.memoryID, scope: scope)
        } catch {
            guard valid(token, record.presentationTarget) else { return }
            // Cleanup may have removed the record before failing on its locator.
            retainedOnDevice = false
            cleanupMessage = "The save result was checked, but local recovery cleanup is still pending. Reopen this note to finish cleanup."
        }
    }

    private func valid(_ token: UUID, _ target: MemoryCorrectionTarget) -> Bool {
        token == generation && currentBinding() && scope?.target(target.memoryID) == target
    }
    private func block(_ id: String) { blockedMemoryIDs.insert(id); onInterlockChanged?() }
    private func unblock(_ id: String, scope expected: NativeMemoryCorrectionScope) {
        guard scope == expected else { return }; blockedMemoryIDs.remove(id); onInterlockChanged?()
    }
    private static func hash(_ value: String?) -> Bool {
        value?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    private static func snapshot(_ wire: OwnerMemoryCorrectionSnapshot, target: MemoryCorrectionTarget) throws -> MemoryCorrectionSnapshot {
        guard wire.memoryId == target.memoryID, hash(wire.revision) else { throw APIError.invalidResponse }
        let available = wire.eligible && hash(wire.contentHash)
        return .init(target: target, revision: wire.revision, storedContentHash: wire.contentHash,
            content: wire.content, sourceLabel: wire.sourceLabel,
            availability: available ? .mayRequestAuthorization : .readOnly(reason: readOnlyMessage(for: wire.readOnlyReason)))
    }
    /// Server reason codes are protocol metadata, never user-facing copy.
    static func readOnlyMessage(for reason: String?) -> String {
        switch reason {
        case "shared_source": return "This note has shared evidence and cannot be changed here."
        case "conflicting_lineage": return "This note combines source evidence and cannot be changed here."
        case "superseded": return "A newer saved note has replaced this one."
        case "tombstoned": return "This note has been forgotten and cannot be edited."
        case "quarantined": return "This note needs source review before it can be edited."
        case "expired_or_invalid_lifecycle": return "This note is expired or its saved state cannot be verified."
        case "memory_content_hash_mismatch": return "This note’s saved content could not be verified, so correction attribution is unavailable."
        case "malformed_owner_correction": return "This note’s correction history could not be verified."
        case "unsupported_import_provenance": return "A single source item for this imported note could not be verified."
        case "unverified_extraction_source": return "The conversation or email behind this saved note could not be verified."
        case "incomplete_provenance": return "Source verification could not be completed within the supported limits."
        case "unverified_subject": return "The person this note belongs to could not be verified."
        case "unsupported_memory_category": return "This item is not a durable knowledge note and cannot be edited here."
        case "source_identity_mismatch": return "The saved source reference does not match this note."
        default: return "The exact source of this note could not be verified, so it is read-only here."
        }
    }
    private static func snapshot(_ record: NativeMemoryCorrectionRecoveryRecord) -> MemoryCorrectionSnapshot {
        .init(target: record.presentationTarget, revision: record.snapshot.revision,
              storedContentHash: record.snapshot.storedContentHash, content: record.snapshot.content,
              sourceLabel: record.snapshot.sourceLabel, availability: .mayRequestAuthorization)
    }
    private static func presentedOperation(_ operation: OwnerMemoryCorrectionOperation, target: MemoryCorrectionTarget) -> MemoryCorrectionOperation {
        .init(operationID: operation.authorization.operationId, target: target,
              expectedRevision: operation.authorization.expectedMemoryRevision,
              expectedStoredContentHash: operation.authorization.expectedContentHash)
    }
    private static func restore(_ record: NativeMemoryCorrectionRecoveryRecord, transport: any NativeMemoryCorrectionTransport) throws -> OwnerMemoryCorrectionOperation {
        guard let hash = record.operation.expectedStoredContentHash else { throw APIError.invalidResponse }
        let response = OwnerMemoryCorrectionAuthorizationResponse(version: 1, intent: "authorized", command: "correct_owner_memory",
            memoryId: record.target.memoryID, operationId: record.operation.operationID,
            authorization: record.authorizationHandle, expiresAt: record.authorizationExpiresAt ?? "")
        let authorization = OwnerMemoryCorrectionAuthorization(response: response, expectedContentHash: hash,
            expectedMemoryRevision: record.operation.expectedRevision,
            content: OwnerMemoryCorrectionApplyRequest.trimmedServerContent(record.draft))
        return try transport.makeOwnerMemoryCorrectionOperation(memoryID: record.target.memoryID, authorization: authorization)
    }
}

private extension MemoryCorrectionTarget {
    var recoveryTarget: NativeMemoryCorrectionRecoveryRecord.Target {
        .init(ownerID: ownerID, serverID: serverID, memoryID: memoryID, sourceIdentity: sourceIdentity)
    }
}
private extension NativeMemoryCorrectionRecoveryRecord {
    var presentationTarget: MemoryCorrectionTarget {
        .init(ownerID: target.ownerID, serverID: target.serverID, memoryID: target.memoryID, sourceIdentity: target.sourceIdentity)
    }
}
