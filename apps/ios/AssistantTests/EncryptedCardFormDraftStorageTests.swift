import CryptoKit
import Foundation
import XCTest
@testable import Assistant

final class EncryptedCardFormDraftStorageTests: XCTestCase {
    func testRoundTripOnDiskDoesNotWriteDraftTextInPlaintext() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = TestCardFormDraftKeyVault()
        let storage = try EncryptedCardFormDraftStorage(
            serverIdentity: "https://assistant.example/api",
            applicationSupportRoot: root,
            keyVault: vault
        )
        let draft = Self.draft()
        let secret = "private form note: 7c66f58e"
        var value = draft
        value.values = ["request": .text(secret)]
        value.frozenRequestBody = Data(secret.utf8)

        try await storage.save(value)
        let url = try XCTUnwrap(try FileManager.default.contentsOfDirectory(
            at: root.appendingPathComponent("CardFormDrafts"),
            includingPropertiesForKeys: nil
        ).flatMap { try FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil) }
            .first(where: { $0.pathExtension == "cfd" }))
        let ciphertext = try Data(contentsOf: url)
        XCTAssertFalse(String(decoding: ciphertext, as: UTF8.self).contains(secret))
        let loaded = try await storage.load(scope: value.scope)
        XCTAssertEqual(loaded, value)
        #if os(iOS) && !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual(attributes[.protectionKey] as? String, FileProtectionType.complete.rawValue)
        #else
        let directoryValues = try url.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(directoryValues.isExcludedFromBackup, true)
        #endif
    }

    func testEncryptedScopeIndexRestoresUnknownDraftScopesAcrossAdapterInstances() async throws {
        let files = MemoryCardFormDraftFiles()
        let vault = TestCardFormDraftKeyVault()
        let first = try Self.storage(files: files, vault: vault)
        let draft = Self.draft()
        try await first.save(draft)

        let restarted = try Self.storage(files: files, vault: vault)
        let scopes = try await restarted.listScopes(ownerId: draft.scope.ownerId, sessionId: draft.scope.sessionId)

        XCTAssertEqual(scopes, [draft.scope])
        XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix(".cfi") }))
        XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix(".cfd") }))
    }

    func testScopeIndexEnvelopeOverheadIsAcceptedNearPlaintextLimit() async throws {
        struct ScopeIndexFixture: Encodable {
            var scopes: [CardFormScope]
        }

        let files = MemoryCardFormDraftFiles()
        let vault = TestCardFormDraftKeyVault()
        let first = try Self.storage(files: files, vault: vault)
        let targetPlaintextBytes = EncryptedCardFormDraftStorage.maximumRecordBytes - 16
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        var targetScopes: [CardFormScope] = []
        for count in 1...512 {
            var scopes = (1...count).map { index in
                CardFormScope(
                    ownerId: "owner-a",
                    sessionId: "session-a",
                    conversationId: String(format: "aaaaaaaa-aaaa-4aaa-8aaa-%012d", index),
                    cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    formId: "f"
                )
            }
            let minimum = try encoder.encode(ScopeIndexFixture(scopes: scopes)).count
            guard minimum <= targetPlaintextBytes else { break }
            var remaining = targetPlaintextBytes - minimum
            for index in scopes.indices where remaining > 0 {
                let increment = min(39, remaining)
                let scope = scopes[index]
                scopes[index] = CardFormScope(
                    ownerId: scope.ownerId,
                    sessionId: scope.sessionId,
                    conversationId: scope.conversationId,
                    cardId: scope.cardId,
                    formId: "f" + String(repeating: "a", count: increment)
                )
                remaining -= increment
            }
            guard remaining == 0 else { continue }
            let actual = try encoder.encode(ScopeIndexFixture(scopes: scopes)).count
            if actual == targetPlaintextBytes {
                targetScopes = scopes
                break
            }
        }
        XCTAssertFalse(targetScopes.isEmpty, "The deterministic fixture must fit a valid plaintext just below the cap")
        XCTAssertEqual(try encoder.encode(ScopeIndexFixture(scopes: targetScopes)).count, targetPlaintextBytes)

        for scope in targetScopes {
            try await first.save(Self.draft(scope: scope))
        }
        let indexPath = try XCTUnwrap(files.paths.first(where: { $0.hasSuffix("scope-index.cfi") }))
        let envelope = try files.read(URL(fileURLWithPath: indexPath), maximumBytes: EncryptedCardFormDraftStorage.maximumRecordBytes + 64)
        XCTAssertGreaterThan(envelope.count, EncryptedCardFormDraftStorage.maximumRecordBytes)
        XCTAssertLessThanOrEqual(envelope.count, EncryptedCardFormDraftStorage.maximumRecordBytes + 64)

        let restarted = try Self.storage(files: files, vault: vault)
        let scopes = try await restarted.listScopes(ownerId: "owner-a", sessionId: "session-a")
        XCTAssertEqual(scopes, targetScopes)
    }

    func testTamperedCiphertextFailsAuthentication() async throws {
        let files = MemoryCardFormDraftFiles()
        let vault = TestCardFormDraftKeyVault()
        let storage = try Self.storage(files: files, vault: vault)
        try await storage.save(Self.draft())
        let recordPath = try XCTUnwrap(files.recordPaths.first)
        files.mutateLastByte(at: recordPath, xor: 0x40)

        do {
            _ = try await storage.load(scope: Self.scope)
            XCTFail("Authenticated encryption must reject modified records")
        } catch {}
    }

    func testServerOwnerAndSessionEachUseSeparateKeyAndDirectoryPartitions() async throws {
        let files = MemoryCardFormDraftFiles()
        let vault = TestCardFormDraftKeyVault()
        let storageA = try Self.storage(files: files, vault: vault, server: "https://one.example")
        let storageB = try Self.storage(files: files, vault: vault, server: "https://two.example")
        let scopeA = Self.scope
        let scopeOtherOwner = Self.makeScope(owner: "owner-b")
        let scopeOtherSession = Self.makeScope(session: "session-b")
        try await storageA.save(Self.draft(scope: scopeA))
        let serverAPartition = try XCTUnwrap(vault.lastPartitionIdentifier)
        try await storageA.save(Self.draft(scope: scopeOtherOwner))
        try await storageA.save(Self.draft(scope: scopeOtherSession))
        try await storageB.save(Self.draft(scope: scopeA))

        XCTAssertEqual(files.recordCount, 4)
        XCTAssertEqual(vault.partitionCount, 4)
        XCTAssertEqual(Set(vault.partitionIdentifiers).count, 4)
        XCTAssertTrue(files.paths.allSatisfy { !$0.contains("owner-a") && !$0.contains("session-a") })
        let fromServerA = try await storageA.load(scope: scopeA)
        let fromServerB = try await storageB.load(scope: scopeA)
        XCTAssertEqual(fromServerA, Self.draft(scope: scopeA))
        XCTAssertEqual(fromServerB, Self.draft(scope: scopeA))
        vault.removeActiveKey(partition: serverAPartition)
        do {
            _ = try await storageA.load(scope: scopeA)
            XCTFail("Removing one server partition key must not be bypassed by another server key")
        } catch EncryptedCardFormDraftStorageError.keyUnavailable {}
        let stillAvailableFromServerB = try await storageB.load(scope: scopeA)
        XCTAssertEqual(stillAvailableFromServerB, Self.draft(scope: scopeA))
    }

    func testNulContainingOwnerAndSessionDoNotCollideInPartitionEncoding() async throws {
        let files = MemoryCardFormDraftFiles()
        let vault = TestCardFormDraftKeyVault()
        let storage = try Self.storage(files: files, vault: vault)
        let first = Self.makeScope(owner: "alice\u{0}bob", session: "c")
        let second = Self.makeScope(owner: "alice", session: "bob\u{0}c")

        try await storage.save(Self.draft(scope: first))
        try await storage.save(Self.draft(scope: second))

        XCTAssertEqual(files.recordCount, 2)
        XCTAssertEqual(vault.partitionIdentifiers.count, 2)
        let firstLoaded = try await storage.load(scope: first)
        let secondLoaded = try await storage.load(scope: second)
        XCTAssertEqual(firstLoaded?.scope, first)
        XCTAssertEqual(secondLoaded?.scope, second)
    }

    func testCiphertextCopiedToAnotherRecordScopeFailsAuthentication() async throws {
        let files = MemoryCardFormDraftFiles()
        let storage = try Self.storage(files: files, vault: TestCardFormDraftKeyVault())
        let first = Self.scope
        let second = CardFormScope(
            ownerId: first.ownerId,
            sessionId: first.sessionId,
            conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            cardId: first.cardId,
            formId: first.formId
        )
        try await storage.save(Self.draft(scope: first))
        let firstPath = try XCTUnwrap(files.recordPaths.first)
        try await storage.save(Self.draft(scope: second))
        let secondPath = try XCTUnwrap(files.recordPaths.first(where: { $0 != firstPath }))
        files.copyRecord(from: firstPath, to: secondPath)

        do {
            _ = try await storage.load(scope: second)
            XCTFail("Ciphertext is authenticated against the complete record scope")
        } catch {}
    }

    func testCiphertextCopiedToDifferentPartitionFailsAuthentication() async throws {
        let files = MemoryCardFormDraftFiles()
        let storage = try Self.storage(files: files, vault: TestCardFormDraftKeyVault())
        let first = Self.scope
        let second = Self.makeScope(owner: "owner-b")
        try await storage.save(Self.draft(scope: first))
        let firstPath = try XCTUnwrap(files.recordPaths.first)
        try await storage.save(Self.draft(scope: second))
        let secondPath = try XCTUnwrap(files.recordPaths.first(where: { $0 != firstPath }))
        files.copyRecord(from: firstPath, to: secondPath)

        do {
            _ = try await storage.load(scope: second)
            XCTFail("Ciphertext cannot be moved into a different owner/session partition")
        } catch {}
    }

    func testExistingCiphertextWithMissingKeyFailsClosed() async throws {
        let files = MemoryCardFormDraftFiles()
        let vault = TestCardFormDraftKeyVault()
        let storage = try Self.storage(files: files, vault: vault)
        try await storage.save(Self.draft())
        vault.removeActiveKey(partition: try XCTUnwrap(vault.lastPartitionIdentifier))

        do {
            _ = try await storage.load(scope: Self.scope)
            XCTFail("An existing ciphertext must not trigger key regeneration or plaintext fallback")
        } catch EncryptedCardFormDraftStorageError.keyUnavailable {}
        XCTAssertEqual(files.recordCount, 1)
    }

    func testSaveFailureDoesNotFallBackToPlaintext() async throws {
        let files = MemoryCardFormDraftFiles()
        files.failWrites = true
        let storage = try Self.storage(files: files, vault: TestCardFormDraftKeyVault())

        do {
            try await storage.save(Self.draft())
            XCTFail("Injected storage failure must be returned to the coordinator")
        } catch {}
        XCTAssertEqual(files.recordCount, 0)
        XCTAssertEqual(files.rawValues, [])
    }

    func testOversizedRecordIsRejectedBeforeDecode() async throws {
        let files = MemoryCardFormDraftFiles()
        let storage = try Self.storage(files: files, vault: TestCardFormDraftKeyVault())
        try await storage.save(Self.draft())
        let recordPath = try XCTUnwrap(files.recordPaths.first)
        files.put(
            Data(repeating: 0x41, count: EncryptedCardFormDraftStorage.maximumRecordBytes + 65),
            at: recordPath
        )

        do {
            _ = try await storage.load(scope: Self.scope)
            XCTFail("Reads must enforce the storage byte ceiling")
        } catch EncryptedCardFormDraftStorageError.oversizedRecord {}
    }

    func testClearTombstonesKeyAndPreventsStaleSessionWrites() async throws {
        let files = MemoryCardFormDraftFiles()
        let vault = TestCardFormDraftKeyVault()
        let storage = try Self.storage(files: files, vault: vault)
        try await storage.save(Self.draft())
        try await storage.clear(ownerId: Self.scope.ownerId, sessionId: Self.scope.sessionId)

        XCTAssertEqual(files.recordCount, 0)
        do {
            try await storage.save(Self.draft())
            XCTFail("A closed session must not recreate its key or draft")
        } catch EncryptedCardFormDraftStorageError.partitionClosed {}
        do {
            _ = try await storage.load(scope: Self.scope)
            XCTFail("A closed session is not readable through a stale coordinator")
        } catch EncryptedCardFormDraftStorageError.partitionClosed {}
        let secondAdapter = try Self.storage(files: files, vault: vault)
        do {
            _ = try await secondAdapter.load(scope: Self.scope)
            XCTFail("A new adapter cannot decrypt a closed session")
        } catch EncryptedCardFormDraftStorageError.partitionClosed {}
        do {
            try await secondAdapter.save(Self.draft())
            XCTFail("The Keychain tombstone must also fence another storage instance")
        } catch EncryptedCardFormDraftStorageError.partitionClosed {}
    }

    private static let scope = CardFormScope(
        ownerId: "owner-a",
        sessionId: "session-a",
        conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        formId: "travel-plan"
    )
    private static func makeScope(owner: String = "owner-a", session: String = "session-a") -> CardFormScope {
        CardFormScope(
            ownerId: owner,
            sessionId: session,
            conversationId: scope.conversationId,
            cardId: scope.cardId,
            formId: scope.formId
        )
    }

    private static func draft(scope requestedScope: CardFormScope? = nil) -> CardFormDraft {
        let scope = requestedScope ?? Self.scope
        return CardFormDraft(
            scope: scope,
            viewedRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            viewedFields: [],
            values: [:],
            pendingReview: nil,
            requiresFreshRevision: false,
            frozenSubmission: nil,
            frozenRequestBody: nil,
            phase: .idle
        )
    }

    private static func storage(
        files: any CardFormDraftFileAccess,
        vault: any CardFormDraftKeyVault,
        server: String = "https://assistant.example/api"
    ) throws -> EncryptedCardFormDraftStorage {
        try EncryptedCardFormDraftStorage(
            serverIdentity: server,
            applicationSupportRoot: URL(fileURLWithPath: "/test-root", isDirectory: true),
            keyVault: vault,
            files: files
        )
    }

    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("card-form-draft-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}

private final class TestCardFormDraftKeyVault: CardFormDraftKeyVault, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: SymmetricKey] = [:]
    private var closed = Set<String>()
    private var lastPartition: String?

    var partitionIdentifiers: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return Set(keys.keys).union(closed)
    }

    var lastPartitionIdentifier: String? {
        lock.lock(); defer { lock.unlock() }
        return lastPartition
    }

    func assertOpen(partition: String) throws {
        lock.lock(); defer { lock.unlock() }
        if closed.contains(partition) { throw EncryptedCardFormDraftStorageError.partitionClosed }
    }

    var partitionCount: Int {
        lock.lock(); defer { lock.unlock() }
        return keys.count + closed.count
    }

    func key(for partition: String, createIfMissing: Bool) throws -> SymmetricKey {
        lock.lock(); defer { lock.unlock() }
        lastPartition = partition
        if closed.contains(partition) { throw EncryptedCardFormDraftStorageError.partitionClosed }
        if let key = keys[partition] { return key }
        guard createIfMissing else { throw EncryptedCardFormDraftStorageError.keyUnavailable }
        let key = SymmetricKey(size: .bits256)
        keys[partition] = key
        return key
    }

    func close(partition: String) throws {
        lock.lock(); defer { lock.unlock() }
        lastPartition = partition
        keys.removeValue(forKey: partition)
        closed.insert(partition)
    }

    func removeActiveKey(partition: String) {
        lock.lock(); defer { lock.unlock() }
        keys.removeValue(forKey: partition)
    }
}

private final class MemoryCardFormDraftFiles: CardFormDraftFileAccess, @unchecked Sendable {
    private let lock = NSLock()
    private var contents: [String: Data] = [:]
    var failWrites = false

    var paths: [String] {
        lock.lock(); defer { lock.unlock() }
        return contents.keys.sorted()
    }

    var recordPaths: [String] {
        lock.lock(); defer { lock.unlock() }
        return contents.keys.filter { $0.hasSuffix(".cfd") }.sorted()
    }

    var recordCount: Int {
        lock.lock(); defer { lock.unlock() }
        return contents.keys.filter { $0.hasSuffix(".cfd") }.count
    }

    var rawValues: [Data] {
        lock.lock(); defer { lock.unlock() }
        return Array(contents.values)
    }

    func exists(_ url: URL) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return contents[url.path] != nil
    }

    func read(_ url: URL, maximumBytes: Int) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        guard let data = contents[url.path] else { throw CocoaError(.fileReadNoSuchFile) }
        guard data.count <= maximumBytes else { throw EncryptedCardFormDraftStorageError.oversizedRecord }
        return data
    }

    func writeAtomically(_ data: Data, to url: URL) throws {
        lock.lock(); defer { lock.unlock() }
        if failWrites { throw EncryptedCardFormDraftStorageError.writeFailed }
        contents[url.path] = data
    }

    func removeFile(_ url: URL) throws {
        lock.lock(); defer { lock.unlock() }
        contents.removeValue(forKey: url.path)
    }

    func removePartition(_ url: URL) throws {
        lock.lock(); defer { lock.unlock() }
        contents = contents.filter { !$0.key.hasPrefix(url.path + "/") }
    }

    func mutateLastByte(at path: String, xor value: UInt8) {
        lock.lock(); defer { lock.unlock() }
        guard var data = contents[path], !data.isEmpty else { return }
        data[data.count - 1] ^= value
        contents[path] = data
    }

    func copyRecord(from sourcePath: String, to destinationPath: String) {
        lock.lock(); defer { lock.unlock() }
        if let data = contents[sourcePath] { contents[destinationPath] = data }
    }

    func put(_ data: Data, at path: String) {
        lock.lock(); defer { lock.unlock() }
        contents[path] = data
    }
}
