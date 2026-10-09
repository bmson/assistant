import CryptoKit
import Darwin
import Foundation
import Security

enum EncryptedCardFormDraftStorageError: Error, Equatable {
    case invalidServerIdentity
    case invalidScope
    case unavailableProtection
    case keyUnavailable
    case partitionClosed
    case corruptKeyRecord
    case oversizedRecord
    case invalidCiphertext
    case writeFailed
}

private enum CardFormDraftKeyState {
    case available(SymmetricKey)
    case closed
}

/// A single Keychain item per server/owner/session partition stores either the
/// encryption key or a permanent closed marker. Updating one item avoids the
/// key/tombstone race that separate items would create during logout cleanup.
protocol CardFormDraftKeyVault: Sendable {
    func assertOpen(partition: String) throws
    func key(for partition: String, createIfMissing: Bool) throws -> SymmetricKey
    func close(partition: String) throws
}

struct KeychainCardFormDraftKeyVault: CardFormDraftKeyVault {
    private let service = "com.baldvinsmarason.assistant.mobile.card-form-drafts.v1"

    func assertOpen(partition: String) throws {
        do {
            switch try readState(partition: partition) {
            case .available: return
            case .closed: throw EncryptedCardFormDraftStorageError.partitionClosed
            }
        } catch EncryptedCardFormDraftStorageError.keyUnavailable {
            return
        }
    }

    func key(for partition: String, createIfMissing: Bool) throws -> SymmetricKey {
        do {
            switch try readState(partition: partition) {
            case .available(let key): return key
            case .closed: throw EncryptedCardFormDraftStorageError.partitionClosed
            }
        } catch EncryptedCardFormDraftStorageError.keyUnavailable {
            guard createIfMissing else { throw EncryptedCardFormDraftStorageError.keyUnavailable }
            return try createKey(partition: partition)
        }
    }

    func close(partition: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: partition
        ]
        var status = SecItemUpdate(query as CFDictionary, [
            kSecValueData as String: Data([0])
        ] as CFDictionary)
        if status == errSecItemNotFound {
            let attributes = query.merging([
                kSecValueData as String: Data([0]),
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            ]) { _, new in new }
            status = SecItemAdd(attributes as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(query as CFDictionary, [
                    kSecValueData as String: Data([0])
                ] as CFDictionary)
            }
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    private func readState(partition: String) throws -> CardFormDraftKeyState {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: partition,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            throw EncryptedCardFormDraftStorageError.keyUnavailable
        }
        guard status == errSecSuccess, let data = result as? Data, let marker = data.first else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        if marker == 0 {
            throw EncryptedCardFormDraftStorageError.partitionClosed
        }
        guard marker == 1, data.count == 33 else {
            throw EncryptedCardFormDraftStorageError.corruptKeyRecord
        }
        return .available(SymmetricKey(data: data.dropFirst()))
    }

    private func createKey(partition: String) throws -> SymmetricKey {
        let key = SymmetricKey(size: .bits256)
        let keyData = key.withUnsafeBytes { Data($0) }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: partition
        ]
        let attributes = query.merging([
            kSecValueData as String: Data([1]) + keyData,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]) { _, new in new }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess { return key }
        if status == errSecDuplicateItem {
            return try readExistingAfterCreateRace(partition: partition)
        }
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }

    private func readExistingAfterCreateRace(partition: String) throws -> SymmetricKey {
        switch try readState(partition: partition) {
        case .available(let key): return key
        case .closed: throw EncryptedCardFormDraftStorageError.partitionClosed
        }
    }
}

protocol CardFormDraftFileAccess: Sendable {
    func exists(_ url: URL) -> Bool
    func read(_ url: URL, maximumBytes: Int) throws -> Data
    func writeAtomically(_ data: Data, to url: URL) throws
    func removeFile(_ url: URL) throws
    func removePartition(_ url: URL) throws
}

struct ProtectedCardFormDraftFileAccess: CardFormDraftFileAccess {
    func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func read(_ url: URL, maximumBytes: Int) throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let number = attributes[.size] as? NSNumber,
              number.intValue >= 0,
              number.intValue <= maximumBytes else {
            throw EncryptedCardFormDraftStorageError.oversizedRecord
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while data.count <= maximumBytes {
            let remaining = maximumBytes + 1 - data.count
            let chunk = try handle.read(upToCount: min(8 * 1024, remaining)) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk)
        }
        guard data.count <= maximumBytes else { throw EncryptedCardFormDraftStorageError.oversizedRecord }
        return data
    }

    func writeAtomically(_ data: Data, to url: URL) throws {
        let manager = FileManager.default
        let directory = url.deletingLastPathComponent()
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        #endif
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(directoryValues)

        let temporary = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
        #if os(iOS)
        let fileAttributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
        #else
        let fileAttributes: [FileAttributeKey: Any] = [:]
        #endif
        guard manager.createFile(
            atPath: temporary.path,
            contents: nil,
            attributes: fileAttributes
        ) else {
            throw EncryptedCardFormDraftStorageError.writeFailed
        }
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
            #if os(iOS)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: temporary.path)
            #endif
            let result = temporary.path.withCString { source in
                url.path.withCString { destination in Darwin.rename(source, destination) }
            }
            guard result == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            #if os(iOS)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            #endif
        } catch {
            try? manager.removeItem(at: temporary)
            throw error
        }
    }

    func removeFile(_ url: URL) throws {
        if exists(url) { try FileManager.default.removeItem(at: url) }
    }

    func removePartition(_ url: URL) throws {
        if exists(url) { try FileManager.default.removeItem(at: url) }
    }
}

actor EncryptedCardFormDraftStorage: CardFormDraftStorage {
    static let maximumRecordBytes = 64 * 1024
    private static let maximumEnvelopeBytes = maximumRecordBytes + 64
    private static let magic = Data([0x43, 0x46, 0x44, 0x01])
    private static let indexMagic = Data([0x43, 0x46, 0x49, 0x01])
    private struct ScopeIndex: Codable { var scopes: [CardFormScope] }

    private let serverIdentity: String
    private let applicationSupportRoot: URL
    private let keyVault: any CardFormDraftKeyVault
    private let files: any CardFormDraftFileAccess
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var closedPartitions = Set<String>()

    init(
        serverIdentity: String,
        applicationSupportRoot: URL? = nil,
        keyVault: any CardFormDraftKeyVault = KeychainCardFormDraftKeyVault(),
        files: any CardFormDraftFileAccess = ProtectedCardFormDraftFileAccess()
    ) throws {
        guard let canonicalServer = Self.canonicalServerIdentity(serverIdentity) else {
            throw EncryptedCardFormDraftStorageError.invalidServerIdentity
        }
        self.serverIdentity = canonicalServer
        let supportRoot = try applicationSupportRoot ?? Self.defaultApplicationSupportRoot()
        self.applicationSupportRoot = supportRoot.appendingPathComponent("CardFormDrafts", isDirectory: true)
        self.keyVault = keyVault
        self.files = files
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        self.encoder = encoder
        self.decoder = JSONDecoder()
    }

    func load(scope: CardFormScope) async throws -> CardFormDraft? {
        try validate(scope)
        let partition = partitionId(ownerId: scope.ownerId, sessionId: scope.sessionId)
        guard !closedPartitions.contains(partition) else {
            throw EncryptedCardFormDraftStorageError.partitionClosed
        }
        try keyVault.assertOpen(partition: partition)
        let url = recordURL(scope: scope, partition: partition)
        guard files.exists(url) else { return nil }
        let sealedData = try files.read(url, maximumBytes: Self.maximumEnvelopeBytes)
        guard sealedData.count >= Self.magic.count,
              sealedData.prefix(Self.magic.count) == Self.magic else {
            throw EncryptedCardFormDraftStorageError.invalidCiphertext
        }
        let key = try keyVault.key(for: partition, createIfMissing: false)
        let boxData = Data(sealedData.dropFirst(Self.magic.count))
        let box = try AES.GCM.SealedBox(combined: boxData)
        let plaintext = try AES.GCM.open(box, using: key, authenticating: associatedData(scope: scope, partition: partition))
        guard plaintext.count <= Self.maximumRecordBytes else {
            throw EncryptedCardFormDraftStorageError.oversizedRecord
        }
        let draft = try decoder.decode(CardFormDraft.self, from: plaintext)
        guard draft.scope == scope else { throw EncryptedCardFormDraftStorageError.invalidCiphertext }
        return draft
    }

    func save(_ draft: CardFormDraft) async throws {
        try validate(draft.scope)
        let plaintext = try encoder.encode(draft)
        guard plaintext.count <= Self.maximumRecordBytes else {
            throw EncryptedCardFormDraftStorageError.oversizedRecord
        }
        let partition = partitionId(ownerId: draft.scope.ownerId, sessionId: draft.scope.sessionId)
        guard !closedPartitions.contains(partition) else {
            throw EncryptedCardFormDraftStorageError.partitionClosed
        }
        let key = try keyVault.key(for: partition, createIfMissing: true)
        guard let sealed = try AES.GCM.seal(
            plaintext,
            using: key,
            authenticating: associatedData(scope: draft.scope, partition: partition)
        ).combined else {
            throw EncryptedCardFormDraftStorageError.invalidCiphertext
        }
        try await updateScopeIndex(scope: draft.scope, partition: partition, key: key)
        try files.writeAtomically(Self.magic + sealed, to: recordURL(scope: draft.scope, partition: partition))
    }

    func listScopes(ownerId: String, sessionId: String) async throws -> [CardFormScope] {
        guard !ownerId.isEmpty, ownerId.utf8.count <= 512,
              !sessionId.isEmpty, sessionId.utf8.count <= 256 else {
            throw EncryptedCardFormDraftStorageError.invalidScope
        }
        let partition = partitionId(ownerId: ownerId, sessionId: sessionId)
        guard !closedPartitions.contains(partition) else { throw EncryptedCardFormDraftStorageError.partitionClosed }
        try keyVault.assertOpen(partition: partition)
        let indexURL = partitionURL(partition).appendingPathComponent("scope-index.cfi", isDirectory: false)
        guard files.exists(indexURL) else { return [] }
        let data = try files.read(indexURL, maximumBytes: Self.maximumEnvelopeBytes)
        guard data.count >= Self.indexMagic.count, data.prefix(Self.indexMagic.count) == Self.indexMagic else {
            throw EncryptedCardFormDraftStorageError.invalidCiphertext
        }
        let key = try keyVault.key(for: partition, createIfMissing: false)
        let box = try AES.GCM.SealedBox(combined: Data(data.dropFirst(Self.indexMagic.count)))
        let plaintext = try AES.GCM.open(box, using: key, authenticating: indexAssociatedData(ownerId: ownerId, sessionId: sessionId, partition: partition))
        guard plaintext.count <= Self.maximumRecordBytes else {
            throw EncryptedCardFormDraftStorageError.oversizedRecord
        }
        let index = try decoder.decode(ScopeIndex.self, from: plaintext)
        guard index.scopes.count <= 512,
              Set(index.scopes).count == index.scopes.count,
              index.scopes.allSatisfy({ $0.ownerId == ownerId && $0.sessionId == sessionId }) else {
            throw EncryptedCardFormDraftStorageError.invalidCiphertext
        }
        for scope in index.scopes { try validate(scope) }
        return index.scopes
    }

    private func updateScopeIndex(scope: CardFormScope, partition: String, key: SymmetricKey) async throws {
        let current = try await listScopes(ownerId: scope.ownerId, sessionId: scope.sessionId)
        guard current.contains(scope) || current.count < 512 else {
            throw EncryptedCardFormDraftStorageError.oversizedRecord
        }
        guard !current.contains(scope) else { return }
        let plaintext = try encoder.encode(ScopeIndex(scopes: current + [scope]))
        guard plaintext.count <= Self.maximumRecordBytes else {
            throw EncryptedCardFormDraftStorageError.oversizedRecord
        }
        guard let sealed = try AES.GCM.seal(
            plaintext, using: key,
            authenticating: indexAssociatedData(ownerId: scope.ownerId, sessionId: scope.sessionId, partition: partition)
        ).combined else {
            throw EncryptedCardFormDraftStorageError.invalidCiphertext
        }
        try files.writeAtomically(Self.indexMagic + sealed, to: partitionURL(partition).appendingPathComponent("scope-index.cfi", isDirectory: false))
    }

    func clear(ownerId: String, sessionId: String) async throws {
        guard !ownerId.isEmpty, ownerId.utf8.count <= 512,
              !sessionId.isEmpty, sessionId.utf8.count <= 256 else {
            throw EncryptedCardFormDraftStorageError.invalidScope
        }
        let partition = partitionId(ownerId: ownerId, sessionId: sessionId)
        closedPartitions.insert(partition)
        var firstError: Error?
        do {
            try keyVault.close(partition: partition)
        } catch {
            firstError = error
        }
        do {
            try files.removePartition(partitionURL(partition))
        } catch {
            if firstError == nil { firstError = error }
        }
        if let firstError { throw firstError }
    }

    private func validate(_ scope: CardFormScope) throws {
        guard !scope.ownerId.isEmpty, scope.ownerId.utf8.count <= 512,
              !scope.sessionId.isEmpty, scope.sessionId.utf8.count <= 256,
              !scope.formId.isEmpty, scope.formId.utf8.count <= 40,
              UUID(uuidString: scope.cardId) != nil,
              UUID(uuidString: scope.conversationId) != nil else {
            throw EncryptedCardFormDraftStorageError.invalidScope
        }
    }

    private func partitionId(ownerId: String, sessionId: String) -> String {
        Self.digest(Self.encodeTuple(["card-form-partition-v1", serverIdentity, ownerId, sessionId]))
    }

    private func recordURL(scope: CardFormScope, partition: String) -> URL {
        let recordIdentity = Self.encodeTuple([
            "card-form-record-v1",
            scope.conversationId.lowercased(),
            scope.cardId.lowercased(),
            scope.formId
        ])
        let filename = Self.digest(recordIdentity) + ".cfd"
        return partitionURL(partition).appendingPathComponent(filename, isDirectory: false)
    }

    private func partitionURL(_ partition: String) -> URL {
        applicationSupportRoot.appendingPathComponent(partition, isDirectory: true)
    }

    private func associatedData(scope: CardFormScope, partition: String) -> Data {
        Self.encodeTuple([
            "card-form-draft-v1", partition, scope.ownerId, scope.sessionId,
            scope.conversationId.lowercased(),
            scope.cardId.lowercased(), scope.formId
        ])
    }

    private func indexAssociatedData(ownerId: String, sessionId: String, partition: String) -> Data {
        Self.encodeTuple(["card-form-scope-index-v1", partition, ownerId, sessionId])
    }

    private static func encodeTuple(_ components: [String]) -> Data {
        var encoded = Data()
        for component in components {
            let bytes = Data(component.utf8)
            var length = UInt64(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { encoded.append(contentsOf: $0) }
            encoded.append(bytes)
        }
        return encoded
    }

    private static func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private static func canonicalServerIdentity(_ value: String) -> String? {
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = components.host?.lowercased(),
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else { return nil }
        let normalizedPort = components.port.flatMap { port in
            (scheme == "https" && port == 443) || (scheme == "http" && port == 80) ? nil : port
        }
        let port = normalizedPort.map { ":\($0)" } ?? ""
        let path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(scheme)://\(host)\(port)/\(path)"
    }

    private static func defaultApplicationSupportRoot() throws -> URL {
        try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
    }
}
