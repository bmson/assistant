import CryptoKit
import Foundation
import Security

/// A stable local session partition. The server and owner are identity inputs,
/// never values supplied by a card or copied into the request body.
@MainActor
final class CardFormMobileSession {
    let serverIdentity: String
    let ownerId: String
    let sessionId: String
    let coordinator: CardFormDraftCoordinator

    init(serverIdentity: String, ownerId: String) throws {
        let canonicalServer = serverIdentity.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: canonicalServer),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host != nil, url.user == nil, url.password == nil,
              canonicalServer.utf8.count <= 2_000,
              !ownerId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              ownerId.utf8.count <= 256 else {
            throw CardFormMobileSessionError.invalidIdentity
        }
        self.serverIdentity = canonicalServer
        self.ownerId = ownerId
        self.sessionId = try CardFormSessionIdentity.readOrCreate(
            serverIdentity: canonicalServer,
            ownerId: ownerId
        )
        let storage = try EncryptedCardFormDraftStorage(serverIdentity: canonicalServer)
        self.coordinator = CardFormDraftCoordinator(storage: storage)
    }

    func restoreUnsettled() async throws -> [CardFormDraft] {
        try await coordinator.restoreUnsettled(ownerId: ownerId, sessionId: sessionId)
    }

    func open(conversationId: String, form: CardFormDescriptor) async throws -> (CardFormScope, CardFormDraft) {
        let scope = scope(conversationId: conversationId, form: form)
        return (scope, try await coordinator.open(scope: scope, form: form))
    }

    func setValue(
        _ value: CardFormValue?, fieldId: String, conversationId: String, form: CardFormDescriptor
    ) async throws -> (CardFormScope, CardFormDraft) {
        let scope = scope(conversationId: conversationId, form: form)
        return (scope, try await coordinator.setValue(value, fieldId: fieldId, scope: scope, form: form))
    }

    func reviewRevision(
        conversationId: String, form: CardFormDescriptor, carryCompatibleValues: Bool
    ) async throws -> (CardFormScope, CardFormDraft) {
        let scope = scope(conversationId: conversationId, form: form)
        return (scope, try await coordinator.reviewRevision(
            scope: scope, form: form, carryCompatibleValues: carryCompatibleValues
        ))
    }

    func beginSubmission(
        _ scope: CardFormScope, form: CardFormDescriptor, ownerMessageText: String
    ) async throws -> CardFormPendingRequest {
        try await coordinator.beginSubmission(scope: scope, form: form, ownerMessageText: ownerMessageText)
    }

    func retryUnknown(_ scope: CardFormScope) async throws -> CardFormPendingRequest {
        try await coordinator.retryUnknown(scope: scope)
    }

    @discardableResult
    func record(_ result: CardFormAdmissionResult, scope: CardFormScope) async throws -> Bool {
        try await coordinator.recordOutcome(result, scope: scope)
    }

    func resumeEditingAfterRejection(_ scope: CardFormScope) async throws -> CardFormDraft {
        try await coordinator.resumeEditingAfterRejection(scope: scope)
    }

    func startNextEntry(_ scope: CardFormScope, taskId: String, status: String) async throws -> CardFormDraft {
        try await coordinator.startNextEntryAfterTerminal(scope: scope, taskId: taskId, observedTaskStatus: status)
    }

    func scope(conversationId: String, form: CardFormDescriptor) -> CardFormScope {
        CardFormScope(
            ownerId: ownerId,
            sessionId: sessionId,
            conversationId: conversationId,
            cardId: form.cardId,
            formId: form.formId
        )
    }

    func closeAndRotate() async throws {
        try await coordinator.clearOwnerSession(ownerId: ownerId, sessionId: sessionId)
        try CardFormSessionIdentity.rotate(serverIdentity: serverIdentity, ownerId: ownerId, expected: sessionId)
    }
}

enum CardFormMobileSessionError: Error, Equatable {
    case invalidIdentity
    case secureStorageUnavailable
    case keychain(Int32)
    case corruptSessionRecord
    case sessionChanged
}

/// Stores only a random UUID. Values and the frozen request live in the
/// CryptoKit-encrypted Application Support store. A SHA-256 digest of the
/// length-prefixed server/owner tuple is the Keychain account name.
private enum CardFormSessionIdentity {
    private static let service = "com.baldvinsmarason.assistant.mobile.card-form-session.v1"

    static func readOrCreate(serverIdentity: String, ownerId: String) throws -> String {
        let query = queryFor(serverIdentity: serverIdentity, ownerId: ownerId)
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]) { _, new in new } as CFDictionary, &result)
        if status == errSecSuccess { return try decode(result) }
        guard status == errSecItemNotFound else { throw CardFormMobileSessionError.keychain(status) }

        let candidate = UUID().uuidString.lowercased()
        let attributes = query.merging([
            kSecValueData as String: Data(candidate.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]) { _, new in new }
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        if addStatus == errSecSuccess { return candidate }
        if addStatus == errSecDuplicateItem { return try readExisting(query) }
        throw CardFormMobileSessionError.keychain(addStatus)
    }

    static func rotate(serverIdentity: String, ownerId: String, expected: String) throws {
        let query = queryFor(serverIdentity: serverIdentity, ownerId: ownerId)
        let current = try readExisting(query)
        guard current == expected else { throw CardFormMobileSessionError.sessionChanged }
        let next = UUID().uuidString.lowercased()
        let status = SecItemUpdate(query as CFDictionary, [
            kSecValueData as String: Data(next.utf8)
        ] as CFDictionary)
        guard status == errSecSuccess else { throw CardFormMobileSessionError.keychain(status) }
    }

    private static func readExisting(_ query: [String: Any]) throws -> String {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]) { _, new in new } as CFDictionary, &result)
        guard status == errSecSuccess else { throw CardFormMobileSessionError.keychain(status) }
        return try decode(result)
    }

    private static func decode(_ result: CFTypeRef?) throws -> String {
        guard let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              let uuid = UUID(uuidString: value), uuid.uuidString.lowercased() == value else {
            throw CardFormMobileSessionError.corruptSessionRecord
        }
        return value
    }

    private static func queryFor(serverIdentity: String, ownerId: String) -> [String: Any] {
        var tuple = Data()
        for value in [serverIdentity, ownerId] {
            // init has already bounded both identities to far below UInt32.max.
            let bytes = Data(value.utf8)
            var length = UInt32(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { tuple.append(contentsOf: $0) }
            tuple.append(bytes)
        }
        let account = "scope-" + SHA256.hash(data: tuple).map { String(format: "%02x", $0) }.joined()
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
