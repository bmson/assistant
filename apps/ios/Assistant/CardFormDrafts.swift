import Foundation

/// The first public form slice permits one fixed action only. A card cannot
/// nominate an arbitrary tool or external side effect.
enum CardFormAction: String, Codable, Sendable {
    case submitOwnerChatTurn = "submit_owner_chat_turn"
}

enum CardFormFieldKind: String, Codable, Sendable {
    case text
    case choice
    case date
    case boolean
}

struct CardFormChoiceOption: Codable, Equatable, Sendable {
    let id: String
    let label: String
}

struct CardFormField: Codable, Equatable, Sendable {
    let id: String
    let type: CardFormFieldKind
    let label: String
    let required: Bool
    let sensitive: Bool
    let defaultFact: String?
    let options: [CardFormChoiceOption]?
    /// Resolved only from a public, nonsensitive fact on the same card.
    /// The wire submission still sends the chosen primitive value only.
    let defaultValue: CardFormValue?

    init(
        id: String,
        type: CardFormFieldKind,
        label: String,
        required: Bool,
        sensitive: Bool = false,
        defaultFact: String? = nil,
        options: [CardFormChoiceOption]? = nil,
        defaultValue: CardFormValue? = nil
    ) {
        self.id = id
        self.type = type
        self.label = label
        self.required = required
        self.sensitive = sensitive
        self.defaultFact = defaultFact
        self.options = options
        self.defaultValue = defaultValue
    }
}

struct CardFormDescriptor: Codable, Equatable, Sendable {
    let cardId: String
    /// The immutable generated-card revision currently shown to the owner.
    let cardRevisionId: String
    let formId: String
    let title: String
    let submitLabel: String
    let serverAction: CardFormAction
    /// This array is server-declared display order. Draft values never use its index.
    let fields: [CardFormField]

    func validate() throws {
        guard Self.isUUID(cardId), Self.isUUID(cardRevisionId), Self.validStableId(formId),
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf16.count <= 60,
              !submitLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, submitLabel.utf16.count <= 40,
              serverAction == .submitOwnerChatTurn,
              (1...4).contains(fields.count) else { throw CardFormDraftError.invalidForm }
        let ids = fields.map(\.id)
        guard Set(ids).count == ids.count,
              fields.allSatisfy({
                  Self.validStableId($0.id) &&
                  !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                  $0.label.utf16.count <= 60 && !$0.sensitive &&
                  ($0.defaultFact.map(Self.validStableId) ?? true)
              }) else { throw CardFormDraftError.invalidForm }
        for field in fields {
            switch field.type {
            case .text:
                guard field.options == nil else { throw CardFormDraftError.invalidForm }
            case .choice:
                guard let options = field.options, (2...6).contains(options.count),
                      Set(options.map(\.id)).count == options.count,
                      options.allSatisfy({
                          Self.validStableId($0.id) &&
                          !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                          $0.label.utf16.count <= 60
                      }) else {
                    throw CardFormDraftError.invalidForm
                }
            case .date, .boolean:
                guard field.options == nil else { throw CardFormDraftError.invalidForm }
            }
        }
    }

    private static func isUUID(_ value: String) -> Bool {
        CardFormIdentifiers.isStrictUUID(value)
    }

    private static func validStableId(_ value: String) -> Bool {
        guard (1...40).contains(value.utf8.count) else { return false }
        guard !["__proto__", "prototype", "constructor"].contains(value) else { return false }
        return value.utf8.allSatisfy {
            (48...57).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

private enum CardFormIdentifiers {
    static func normalizedUUID(_ value: String) -> String? {
        guard isStrictUUID(value) else { return nil }
        return value.lowercased()
    }

    static func isStrictUUID(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 36,
              [8, 13, 18, 23].allSatisfy({ bytes[$0] == 45 }) else { return false }
        for index in 0..<bytes.count where ![8, 13, 18, 23].contains(index) {
            let byte = bytes[index]
            let isDigit = (48...57).contains(byte)
            let isLowerHex = (97...102).contains(byte)
            let isUpperHex = (65...70).contains(byte)
            guard isDigit || isLowerHex || isUpperHex else { return false }
        }
        let version = bytes[14]
        let variant = bytes[19]
        return (49...56).contains(version) && [56, 57, 97, 98, 65, 66].contains(variant)
    }
}

/// Owner/session is part of the local key. The owner ID is never sent as an
/// authority claim; the server derives it from the authenticated request.
struct CardFormComposerBinding: Equatable, Sendable {
    let scope: CardFormScope
    let form: CardFormDescriptor
}

struct CardFormScope: Codable, Hashable, Sendable {
    let ownerId: String
    let sessionId: String
    let conversationId: String
    let cardId: String
    let formId: String
}

/// Tagged in local draft storage so choice/date values retain their field kind
/// after a reconnect. The wire type below deliberately encodes primitives.
enum CardFormValue: Equatable, Sendable, Codable {
    case text(String)
    case choice(String)
    case date(String)
    case boolean(Bool)

    var kind: CardFormFieldKind {
        switch self {
        case .text: .text
        case .choice: .choice
        case .date: .date
        case .boolean: .boolean
        }
    }

}

/// Primitive JSON values accepted by `card-form-v1`; the server determines the
/// type from its persisted form definition, never from a client type tag.
enum CardFormWireValue: Equatable, Sendable, Codable {
    case string(String)
    case boolean(Bool)

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let boolean = try? value.decode(Bool.self) {
            self = .boolean(boolean)
        } else {
            self = .string(try value.decode(String.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .string(string): try value.encode(string)
        case let .boolean(boolean): try value.encode(boolean)
        }
    }
}

struct CardFormRevisionSnapshot: Codable, Equatable, Sendable {
    let revisionId: String
    let fields: [CardFormField]
}

/// The wire payload matches the server candidate exactly. Its values map is
/// canonicalized by the server by field ID; the UI order is not part of identity.
struct CardFormSubmission: Codable, Equatable, Sendable {
    let protocolVersion: String
    let conversationId: String
    let cardId: String
    let expectedRevisionId: String
    let formId: String
    let operationId: String
    let values: [String: CardFormWireValue]
    /// Exact owner-authored composer text sent with the reviewed field values.
    let ownerMessageText: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case conversationId
        case cardId
        case expectedRevisionId
        case formId
        case operationId
        case values
        case ownerMessageText
    }

    static let currentProtocol = "card-form-v1"
}

struct CardFormPendingRequest: Equatable, Sendable {
    let submission: CardFormSubmission
    /// Exact sorted-key body bytes persisted before the caller may send.
    let body: Data
}

private enum CardFormWireEncoder {
    static func encode(_ submission: CardFormSubmission) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(submission)
    }
}

struct CardFormActiveTaskPointer: Codable, Equatable, Sendable {
    let taskId: String
    let taskStatus: String
}

struct CardFormAdmissionReceipt: Codable, Equatable, Sendable {
    let taskId: String
    let messageId: String
    let taskStatus: String
    let queueGeneration: Int
    let created: Bool
    let dispatch: CardFormDispatch?
}

enum CardFormDispatch: String, Codable, Sendable {
    case notify
    case outbox
}

enum CardFormSubmissionPhase: Codable, Equatable, Sendable {
    case idle
    /// Persisted before the request leaves the device. On reopen this is
    /// converted to outcomeUnknown because the process may have died after send.
    case submitting
    case outcomeUnknown
    case accepted(CardFormAdmissionReceipt)
    case activeForm(CardFormActiveTaskPointer)
    case rejected(status: Int, code: String)
}

struct CardFormDraft: Codable, Equatable, Sendable {
    let scope: CardFormScope
    var viewedRevisionId: String
    var viewedFields: [CardFormField]
    var values: [String: CardFormValue]
    var pendingReview: CardFormRevisionSnapshot?
    /// A 409 may mean this revision is no longer current. Keep the form blocked
    /// until a newly fetched revision is supplied, even if an old view remounts.
    var requiresFreshRevision: Bool
    var frozenSubmission: CardFormSubmission?
    var frozenRequestBody: Data?
    var phase: CardFormSubmissionPhase
}

struct CardFormAdmissionResult: Sendable {
    enum Outcome: Sendable {
        case accepted(CardFormAdmissionReceipt)
        case activeForm(CardFormActiveTaskPointer)
        case rejected(status: Int, code: String)
        case outcomeUnknown
    }
    let operationId: String
    let outcome: Outcome
}

enum CardFormDraftError: Error, Equatable {
    case invalidForm
    case invalidOperationId
    case invalidOwnerMessage
    case requestTooLarge
    case scopeMismatch
    case sessionClosed
    case needsRevisionReview
    case revisionDescriptorMismatch
    case submissionPending
    case submissionAlreadySettled
    case taskNotTerminal
    case missingRequiredValue(String)
    case invalidValue(String)
}

/// Storage is injected so the app can later choose a privacy-reviewed encrypted
/// backend. This prototype intentionally supplies no UserDefaults/plain-file
/// implementation. `sessionId` must survive the intended reconnect boundary and
/// rotate on logout or authenticated-owner change.
protocol CardFormDraftStorage: Sendable {
    func load(scope: CardFormScope) async throws -> CardFormDraft?
    func save(_ draft: CardFormDraft) async throws
    func listScopes(ownerId: String, sessionId: String) async throws -> [CardFormScope]
    func clear(ownerId: String, sessionId: String) async throws
}

actor CardFormDraftCoordinator {
    private let storage: any CardFormDraftStorage
    private let makeOperationId: @Sendable () -> String
    private var busyScopes = Set<CardFormScope>()
    private var scopeWaiters: [CardFormScope: [CheckedContinuation<Void, Never>]] = [:]
    private var clearingSessions = Set<CardFormSessionScope>()
    private var closedSessions = Set<CardFormSessionScope>()
    private var idleWaiters: [CardFormSessionScope: [CheckedContinuation<Void, Never>]] = [:]
    private var inFlightOperationIds: [CardFormScope: String] = [:]

    init(
        storage: any CardFormDraftStorage,
        makeOperationId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.storage = storage
        self.makeOperationId = makeOperationId
    }

    func restoreUnsettled(ownerId: String, sessionId: String) async throws -> [CardFormDraft] {
        let scopes = try await storage.listScopes(ownerId: ownerId, sessionId: sessionId)
        guard scopes.count <= 512, Set(scopes).count == scopes.count,
              scopes.allSatisfy({ $0.ownerId == ownerId && $0.sessionId == sessionId }) else {
            throw CardFormDraftError.scopeMismatch
        }
        var unsettled: [CardFormDraft] = []
        for scope in scopes {
            try await acquire(scope)
            defer { release(scope) }
            guard var draft = try await storage.load(scope: scope), draft.scope == scope else { continue }
            if case .submitting = draft.phase,
               inFlightOperationIds[scope] != draft.frozenSubmission?.operationId {
                draft.phase = .outcomeUnknown
                try await storage.save(draft)
            }
            switch draft.phase {
            case .submitting, .outcomeUnknown:
                try validateRestoredSubmission(draft)
                unsettled.append(draft)
            case let .activeForm(pointer):
                try validateRestoredSubmission(draft)
                guard CardFormIdentifiers.normalizedUUID(pointer.taskId) == pointer.taskId,
                      Self.isKnownTaskStatus(pointer.taskStatus) else {
                    throw CardFormDraftError.submissionPending
                }
                unsettled.append(draft)
            default:
                break
            }
        }
        return unsettled
    }

    /// Reopening a card after remount/reconnect loads by stable scope. A changed
    /// card revision is recorded for review without replacing draft values.
    func open(scope: CardFormScope, form: CardFormDescriptor) async throws -> CardFormDraft {
        try await acquire(scope)
        defer { release(scope) }
        return try await loadAndReconcile(scope: scope, form: form)
    }

    private func loadAndReconcile(scope: CardFormScope, form: CardFormDescriptor) async throws -> CardFormDraft {
        try form.validate()
        guard CardFormIdentifiers.normalizedUUID(scope.cardId) == CardFormIdentifiers.normalizedUUID(form.cardId),
              scope.formId == form.formId,
              CardFormIdentifiers.normalizedUUID(scope.conversationId) != nil,
              !scope.ownerId.isEmpty, !scope.sessionId.isEmpty else {
            throw CardFormDraftError.scopeMismatch
        }
        guard let formRevisionId = CardFormIdentifiers.normalizedUUID(form.cardRevisionId) else {
            throw CardFormDraftError.invalidForm
        }
        var draft = try await storage.load(scope: scope) ?? CardFormDraft(
            scope: scope,
            viewedRevisionId: formRevisionId,
            viewedFields: form.fields,
            values: defaultValues(for: form.fields),
            pendingReview: nil,
            requiresFreshRevision: false,
            frozenSubmission: nil,
            frozenRequestBody: nil,
            phase: .idle
        )
        guard draft.scope == scope else { throw CardFormDraftError.scopeMismatch }
        if case .submitting = draft.phase,
           inFlightOperationIds[scope] != draft.frozenSubmission?.operationId {
            // A prior process might have sent the request before dying.
            draft.phase = .outcomeUnknown
        }
        guard let storedRevisionId = CardFormIdentifiers.normalizedUUID(draft.viewedRevisionId) else {
            throw CardFormDraftError.scopeMismatch
        }
        if storedRevisionId != formRevisionId {
            draft.pendingReview = .init(revisionId: formRevisionId, fields: form.fields)
            draft.requiresFreshRevision = false
        } else {
            guard Self.sameFieldSemantics(draft.viewedFields, form.fields) else {
                throw CardFormDraftError.revisionDescriptorMismatch
            }
            // Display order may change without changing the revision. Values
            // remain keyed by stable ID; store the latest presentation order.
            draft.viewedFields = form.fields
        }
        try await storage.save(draft)
        return draft
    }

    func setValue(
        _ value: CardFormValue?,
        fieldId: String,
        scope: CardFormScope,
        form: CardFormDescriptor
    ) async throws -> CardFormDraft {
        try await acquire(scope)
        defer { release(scope) }
        try form.validate()
        var draft = try await loadAndReconcile(scope: scope, form: form)
        try requireEditable(draft, revisionId: form.cardRevisionId)
        guard let field = form.fields.first(where: { $0.id == fieldId }) else {
            throw CardFormDraftError.invalidValue(fieldId)
        }
        if let value { try validateDraftValue(value, for: field) }
        if let value { draft.values[fieldId] = normalized(value) } else { draft.values.removeValue(forKey: fieldId) }
        try await storage.save(draft)
        return draft
    }

    /// Carries only values whose stable field ID and kind are unchanged. A
    /// choice is retained only when its option ID still exists. Discard is the
    /// explicit alternative. A known stale-revision response can be reviewed
    /// against the newly fetched descriptor before another submit.
    func reviewRevision(
        scope: CardFormScope,
        form: CardFormDescriptor,
        carryCompatibleValues: Bool
    ) async throws -> CardFormDraft {
        try await acquire(scope)
        defer { release(scope) }
        try form.validate()
        var draft = try await loadAndReconcile(scope: scope, form: form)
        guard let pending = draft.pendingReview,
              CardFormIdentifiers.normalizedUUID(pending.revisionId) == CardFormIdentifiers.normalizedUUID(form.cardRevisionId) else {
            throw CardFormDraftError.needsRevisionReview
        }
        if case .submitting = draft.phase { throw CardFormDraftError.submissionPending }
        if case .outcomeUnknown = draft.phase { throw CardFormDraftError.submissionPending }

        var carried = defaultValues(for: form.fields)
        if carryCompatibleValues {
            let oldFields = Dictionary(draft.viewedFields.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            for field in form.fields {
                guard oldFields[field.id]?.type == field.type,
                      let value = draft.values[field.id], (try? validate(value, for: field)) != nil else { continue }
                carried[field.id] = normalized(value)
            }
        }
        draft.viewedRevisionId = CardFormIdentifiers.normalizedUUID(form.cardRevisionId)!
        draft.viewedFields = form.fields
        draft.values = carried
        draft.pendingReview = nil
        draft.requiresFreshRevision = false
        // Reviewing a newer card revision cannot release an already accepted
        // task. Keep its exact receipt and operation fence until that task is
        // authoritatively terminal and the owner explicitly starts a new entry.
        switch draft.phase {
        case .accepted, .activeForm:
            // Preserve the task pointer and original frozen submission identity.
            break
        default:
            draft.frozenSubmission = nil
            draft.frozenRequestBody = nil
            draft.phase = .idle
        }
        try await storage.save(draft)
        return draft
    }

    /// Creates an operation only on an explicit submit. The frozen payload is
    /// saved first; callers must not send if this save throws.
    func beginSubmission(
        scope: CardFormScope,
        form: CardFormDescriptor,
        ownerMessageText: String
    ) async throws -> CardFormPendingRequest {
        try await acquire(scope)
        defer { release(scope) }
        try form.validate()
        var draft = try await loadAndReconcile(scope: scope, form: form)
        try requireEditable(draft, revisionId: form.cardRevisionId)
        guard draft.phase == .idle, draft.frozenSubmission == nil else {
            throw CardFormDraftError.submissionPending
        }
        for field in form.fields where field.required {
            guard let value = draft.values[field.id] else { throw CardFormDraftError.missingRequiredValue(field.id) }
            if case let .text(text) = normalized(value), text.isEmpty {
                throw CardFormDraftError.missingRequiredValue(field.id)
            }
        }
        for field in form.fields {
            if let value = draft.values[field.id] { try validate(value, for: field) }
        }
        let normalizedOwnerMessageText = ownerMessageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedOwnerMessageText.isEmpty, normalizedOwnerMessageText.utf16.count <= 4_000 else {
            throw CardFormDraftError.invalidOwnerMessage
        }
        let canonicalValues = Dictionary(uniqueKeysWithValues: form.fields.compactMap { field -> (String, CardFormValue)? in
            guard let rawValue = draft.values[field.id] else { return nil }
            let value = normalized(rawValue)
            if case let .text(text) = value, text.isEmpty, !field.required { return nil }
            return (field.id, value)
        })
        let generatedOperationId = makeOperationId()
        guard let operationId = CardFormIdentifiers.normalizedUUID(generatedOperationId) else {
            throw CardFormDraftError.invalidOperationId
        }
        let wireValues = Dictionary(uniqueKeysWithValues: canonicalValues.map { key, value in
            let wireValue: CardFormWireValue
            switch value {
            case let .text(text), let .choice(text), let .date(text): wireValue = .string(text)
            case let .boolean(boolean): wireValue = .boolean(boolean)
            }
            return (key, wireValue)
        })
        let submission = CardFormSubmission(
            protocolVersion: CardFormSubmission.currentProtocol,
            conversationId: CardFormIdentifiers.normalizedUUID(scope.conversationId)!,
            cardId: CardFormIdentifiers.normalizedUUID(form.cardId)!,
            expectedRevisionId: CardFormIdentifiers.normalizedUUID(form.cardRevisionId)!,
            formId: form.formId,
            operationId: operationId,
            values: wireValues,
            ownerMessageText: normalizedOwnerMessageText
        )
        let body = try CardFormWireEncoder.encode(submission)
        guard body.count <= 16 * 1024 else { throw CardFormDraftError.requestTooLarge }
        draft.frozenSubmission = submission
        draft.frozenRequestBody = body
        draft.phase = .submitting
        inFlightOperationIds[scope] = operationId
        do {
            try await storage.save(draft)
        } catch {
            inFlightOperationIds.removeValue(forKey: scope)
            throw error
        }
        return CardFormPendingRequest(submission: submission, body: body)
    }

    /// After restart or timeout, retry the exact frozen operation. This method
    /// never creates/rotates an ID or accepts edited values.
    func retryUnknown(scope: CardFormScope) async throws -> CardFormPendingRequest {
        try await acquire(scope)
        defer { release(scope) }
        guard var draft = try await storage.load(scope: scope),
              let submission = draft.frozenSubmission,
              let body = draft.frozenRequestBody,
              body == (try? CardFormWireEncoder.encode(submission)) else {
            throw CardFormDraftError.submissionPending
        }
        if case .submitting = draft.phase,
           inFlightOperationIds[scope] != submission.operationId {
            // A local send that never reached the network may have failed to
            // persist its unknown transition. The exact frozen body is still
            // safe to retry because no request is in flight in this process.
            draft.phase = .outcomeUnknown
            try await storage.save(draft)
        }
        guard case .outcomeUnknown = draft.phase else {
            throw CardFormDraftError.submissionPending
        }
        draft.phase = .submitting
        inFlightOperationIds[scope] = submission.operationId
        do {
            try await storage.save(draft)
        } catch {
            inFlightOperationIds.removeValue(forKey: scope)
            throw error
        }
        return CardFormPendingRequest(submission: submission, body: body)
    }

    func recordOutcome(_ result: CardFormAdmissionResult, scope: CardFormScope) async throws -> Bool {
        try await acquire(scope)
        defer { release(scope) }
        guard var draft = try await storage.load(scope: scope),
              draft.frozenSubmission?.operationId == result.operationId else {
            // A late response from an older operation cannot settle a newer draft.
            return false
        }
        if case let .accepted(existing) = draft.phase {
            if case let .accepted(incoming) = result.outcome, incoming == existing { return true }
            return false
        }
        if case let .rejected(status, code) = draft.phase {
            if case let .rejected(incomingStatus, incomingCode) = result.outcome,
               status == incomingStatus, code == incomingCode { return true }
            return false
        }
        if case let .activeForm(existing) = draft.phase {
            if case let .activeForm(incoming) = result.outcome, incoming == existing { return true }
            return false
        }

        switch result.outcome {
        case let .accepted(receipt):
            draft.phase = .accepted(receipt)
            draft.frozenRequestBody = nil
        case let .activeForm(pointer):
            draft.phase = .activeForm(pointer)
        case let .rejected(status, code):
            draft.phase = .rejected(status: status, code: code)
            draft.frozenRequestBody = nil
            if status == 409, draft.pendingReview == nil {
                // Do not let a stale mounted descriptor clear this conflict.
                draft.requiresFreshRevision = true
            }
        case .outcomeUnknown:
            draft.phase = .outcomeUnknown
        }
        inFlightOperationIds.removeValue(forKey: scope)
        try await storage.save(draft)
        return true
    }

    /// Definite rejection is editable only through this explicit transition;
    /// the next submit tap receives a fresh operation ID.
    func resumeEditingAfterRejection(scope: CardFormScope) async throws -> CardFormDraft {
        try await acquire(scope)
        defer { release(scope) }
        guard var draft = try await storage.load(scope: scope),
              case .rejected = draft.phase,
              draft.pendingReview == nil,
              !draft.requiresFreshRevision else { throw CardFormDraftError.submissionPending }
        draft.frozenSubmission = nil
        draft.frozenRequestBody = nil
        draft.phase = .idle
        try await storage.save(draft)
        return draft
    }

    /// An accepted owner message is not completion of the requested work.
    /// The caller may offer a separate next-entry action only after an
    /// authoritative task read reports that this exact task is terminal.
    func startNextEntryAfterTerminal(
        scope: CardFormScope,
        taskId: String,
        observedTaskStatus: String
    ) async throws -> CardFormDraft {
        try await acquire(scope)
        defer { release(scope) }
        guard var draft = try await storage.load(scope: scope) else {
            throw CardFormDraftError.submissionAlreadySettled
        }
        let targetTaskId: String
        switch draft.phase {
        case let .accepted(receipt): targetTaskId = receipt.taskId
        case let .activeForm(pointer): targetTaskId = pointer.taskId
        default: throw CardFormDraftError.submissionAlreadySettled
        }
        guard targetTaskId == taskId else { throw CardFormDraftError.submissionAlreadySettled }
        guard draft.pendingReview == nil, !draft.requiresFreshRevision else {
            throw CardFormDraftError.needsRevisionReview
        }
        guard ["done", "failed", "cancelled"].contains(observedTaskStatus) else {
            throw CardFormDraftError.taskNotTerminal
        }
        draft.values = defaultValues(for: draft.viewedFields)
        draft.frozenSubmission = nil
        draft.frozenRequestBody = nil
        draft.phase = .idle
        try await storage.save(draft)
        return draft
    }

    func clearOwnerSession(ownerId: String, sessionId: String) async throws {
        let session = CardFormSessionScope(ownerId: ownerId, sessionId: sessionId)
        if closedSessions.contains(session) { return }
        guard clearingSessions.insert(session).inserted else {
            throw CardFormDraftError.submissionPending
        }
        defer { clearingSessions.remove(session) }
        while busyScopes.contains(where: { $0.ownerId == ownerId && $0.sessionId == sessionId }) {
            await withCheckedContinuation { continuation in
                idleWaiters[session, default: []].append(continuation)
            }
        }
        try await storage.clear(ownerId: ownerId, sessionId: sessionId)
        closedSessions.insert(session)
        inFlightOperationIds = inFlightOperationIds.filter {
            $0.key.ownerId != ownerId || $0.key.sessionId != sessionId
        }
    }

    private func validateRestoredSubmission(_ draft: CardFormDraft) throws {
        guard let submission = draft.frozenSubmission,
              let body = draft.frozenRequestBody,
              body.count <= 16 * 1024,
              submission.protocolVersion == CardFormSubmission.currentProtocol,
              CardFormIdentifiers.normalizedUUID(submission.operationId) == submission.operationId,
              CardFormIdentifiers.normalizedUUID(submission.conversationId) == CardFormIdentifiers.normalizedUUID(draft.scope.conversationId),
              CardFormIdentifiers.normalizedUUID(submission.cardId) == CardFormIdentifiers.normalizedUUID(draft.scope.cardId),
              CardFormIdentifiers.normalizedUUID(submission.expectedRevisionId) == submission.expectedRevisionId,
              submission.formId == draft.scope.formId,
              !submission.ownerMessageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              submission.ownerMessageText == submission.ownerMessageText.trimmingCharacters(in: .whitespacesAndNewlines),
              submission.ownerMessageText.utf16.count <= 4_000,
              body == (try? CardFormWireEncoder.encode(submission)) else {
            throw CardFormDraftError.submissionPending
        }
        let fields = Dictionary(draft.viewedFields.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard fields.count == draft.viewedFields.count,
              submission.values.keys.allSatisfy({ fields[$0] != nil }) else {
            throw CardFormDraftError.submissionPending
        }
        var expected: [String: CardFormWireValue] = [:]
        for field in draft.viewedFields {
            guard let raw = draft.values[field.id] else { continue }
            let value = normalized(raw)
            try validate(value, for: field)
            if case let .text(text) = value, text.isEmpty, !field.required { continue }
            let wireValue: CardFormWireValue
            switch value {
            case let .text(text), let .choice(text), let .date(text): wireValue = .string(text)
            case let .boolean(boolean): wireValue = .boolean(boolean)
            }
            expected[field.id] = wireValue
        }
        guard expected == submission.values else { throw CardFormDraftError.submissionPending }
    }

    static func isKnownTaskStatus(_ status: String) -> Bool {
        [
            "pending", "running", "waiting_approval", "waiting_event", "sleeping",
            "waiting_budget", "done", "failed", "needs_attention", "cancelled",
        ].contains(status)
    }

    private func requireEditable(_ draft: CardFormDraft, revisionId: String) throws {
        guard draft.pendingReview == nil, !draft.requiresFreshRevision,
              CardFormIdentifiers.normalizedUUID(draft.viewedRevisionId) == CardFormIdentifiers.normalizedUUID(revisionId) else {
            throw CardFormDraftError.needsRevisionReview
        }
        switch draft.phase {
        case .idle: break
        case .rejected, .submitting, .outcomeUnknown, .activeForm: throw CardFormDraftError.submissionPending
        case .accepted: throw CardFormDraftError.submissionAlreadySettled
        }
    }

    private func validateDraftValue(_ value: CardFormValue, for field: CardFormField) throws {
        if case let .date(date) = value, field.type == .date {
            if date.utf16.count < 10, Self.isDateEntryPrefix(date) { return }
            try validate(value, for: field)
            return
        }
        try validate(value, for: field)
    }

    private static func isDateEntryPrefix(_ value: String) -> Bool {
        guard value.utf16.count <= 10 else { return false }
        let bytes = Array(value.utf8)
        return bytes.allSatisfy { (48...57).contains($0) || $0 == 45 }
    }

    private func validate(_ value: CardFormValue, for field: CardFormField) throws {
        guard !field.sensitive, value.kind == field.type else { throw CardFormDraftError.invalidValue(field.id) }
        switch value {
        case let .text(text):
            guard text.utf16.count <= 500 else { throw CardFormDraftError.invalidValue(field.id) }
        case let .choice(id):
            guard field.options?.contains(where: { $0.id == id }) == true else { throw CardFormDraftError.invalidValue(field.id) }
        case let .date(date):
            guard Self.isCalendarDate(date) else { throw CardFormDraftError.invalidValue(field.id) }
        case .boolean:
            break
        }
    }

    private func normalized(_ value: CardFormValue) -> CardFormValue {
        if case let .text(text) = value { return .text(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return value
    }

    private static func sameFieldSemantics(_ left: [CardFormField], _ right: [CardFormField]) -> Bool {
        guard left.count == right.count else { return false }
        var leftById: [String: CardFormField] = [:]
        var rightById: [String: CardFormField] = [:]
        for field in left {
            guard leftById.updateValue(field, forKey: field.id) == nil else { return false }
        }
        for field in right {
            guard rightById.updateValue(field, forKey: field.id) == nil else { return false }
        }
        return leftById == rightById
    }

    private func defaultValues(for fields: [CardFormField]) -> [String: CardFormValue] {
        // Defaults are resolved from nonsensitive public card facts by the
        // strict parser. Booleans intentionally have no implicit default:
        // the owner must choose the explicit Yes or No control.
        Dictionary(fields.compactMap { field -> (String, CardFormValue)? in
            guard let value = field.defaultValue,
                  (try? validate(value, for: field)) != nil else { return nil }
            return (field.id, normalized(value))
        }, uniquingKeysWith: { first, _ in first })
    }

    private static func isUUID(_ value: String) -> Bool {
        CardFormIdentifiers.isStrictUUID(value)
    }

    private static func isCalendarDate(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
              bytes.enumerated().allSatisfy({ index, byte in
                  index == 4 || index == 7 || (48...57).contains(byte)
              }),
              let year = Int(String(decoding: bytes[0..<4], as: UTF8.self)),
              let month = Int(String(decoding: bytes[5..<7], as: UTF8.self)),
              let day = Int(String(decoding: bytes[8..<10], as: UTF8.self)),
              (1...9_999).contains(year) else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        guard let date = calendar.date(from: components) else { return false }
        let normalized = calendar.dateComponents([.year, .month, .day], from: date)
        return normalized.year == year && normalized.month == month && normalized.day == day
    }

    /// Serializes edits with submit/review operations. Text controls can emit
    /// several changes while encrypted storage is writing; those writes must
    /// queue instead of dropping input or racing the frozen owner message.
    private func acquire(_ scope: CardFormScope) async throws {
        let session = CardFormSessionScope(ownerId: scope.ownerId, sessionId: scope.sessionId)
        guard !closedSessions.contains(session) else { throw CardFormDraftError.sessionClosed }
        guard !clearingSessions.contains(session) else { throw CardFormDraftError.submissionPending }
        if busyScopes.insert(scope).inserted { return }
        await withCheckedContinuation { continuation in
            scopeWaiters[scope, default: []].append(continuation)
        }
        guard !closedSessions.contains(session) else {
            release(scope)
            throw CardFormDraftError.sessionClosed
        }
        guard !clearingSessions.contains(session) else {
            release(scope)
            throw CardFormDraftError.submissionPending
        }
    }

    private func reserve(_ scope: CardFormScope) throws {
        let session = CardFormSessionScope(ownerId: scope.ownerId, sessionId: scope.sessionId)
        guard !closedSessions.contains(session) else { throw CardFormDraftError.sessionClosed }
        guard !clearingSessions.contains(session) else { throw CardFormDraftError.submissionPending }
        guard busyScopes.insert(scope).inserted else { throw CardFormDraftError.submissionPending }
    }

    private func release(_ scope: CardFormScope) {
        if var waiters = scopeWaiters[scope], !waiters.isEmpty {
            let next = waiters.removeFirst()
            scopeWaiters[scope] = waiters.isEmpty ? nil : waiters
            next.resume()
            return
        }
        busyScopes.remove(scope)
        let session = CardFormSessionScope(ownerId: scope.ownerId, sessionId: scope.sessionId)
        guard !busyScopes.contains(where: { $0.ownerId == session.ownerId && $0.sessionId == session.sessionId }),
              let waiters = idleWaiters.removeValue(forKey: session) else { return }
        waiters.forEach { $0.resume() }
    }
}

private struct CardFormSessionScope: Hashable {
    let ownerId: String
    let sessionId: String
}
