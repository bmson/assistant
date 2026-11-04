import CryptoKit
import Foundation
import XCTest
@testable import Assistant

final class NativeMemoryCorrectionRecoveryTests: XCTestCase {
    func testEncryptedRoundTripUsesFullServerPathAndExactOperationTuple() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(files: files, vault: vault, root: root)
        let record = fixture()
        try await store.saveBeforeDispatch(record)

        let reopened = try makeStore(files: files, vault: vault, root: root)
        let recovered = try await reopened.load(serverIdentity: record.serverIdentity,
                                                target: record.target,
                                                operationID: record.operation.operationID)
        XCTAssertEqual(recovered, record)
        let foreignServer = try await reopened.load(serverIdentity: "https://example.test/assistant/other",
                                                    target: record.target,
                                                    operationID: record.operation.operationID)
        XCTAssertNil(foreignServer)
        let bytes = try XCTUnwrap(files.onlyValue)
        XCTAssertNil(bytes.range(of: Data(record.draft.utf8)))
        XCTAssertNil(bytes.range(of: Data(record.authorizationHandle.utf8)))
        XCTAssertNil(bytes.range(of: Data("never-persist-this-bearer".utf8)))
    }

    func testRemovalRequiresExactOperationAndCannotClearNewerDifferentOperation() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let oldA = fixture(operationID: "server-op-A")
        let newerB = fixture(operationID: "server-op-B", draft: "New wording B")
        let otherOwner = fixture(operationID: "server-op-A", draft: "Other owner's wording", ownerID: "owner-2")
        try await store.saveBeforeDispatch(oldA)
        try await store.saveBeforeDispatch(newerB)
        try await store.saveBeforeDispatch(otherOwner)

        try await store.remove(serverIdentity: oldA.serverIdentity, target: oldA.target,
                               operationID: oldA.operation.operationID,
                               disposition: .rejectedNoWrite)
        let removedOldA = try await store.load(serverIdentity: oldA.serverIdentity, target: oldA.target,
                                               operationID: oldA.operation.operationID)
        let recoveredNewerB = try await store.load(serverIdentity: newerB.serverIdentity, target: newerB.target,
                                                   operationID: newerB.operation.operationID)
        let recoveredOtherOwner = try await store.load(serverIdentity: otherOwner.serverIdentity,
                                                       target: otherOwner.target,
                                                       operationID: otherOwner.operation.operationID)
        XCTAssertNil(removedOldA)
        XCTAssertEqual(recoveredNewerB, newerB)
        XCTAssertEqual(recoveredOtherOwner, otherOwner)
    }

    func testSameOperationCannotBeSilentlyChangedOrOverwritten() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let original = fixture()
        try await store.saveBeforeDispatch(original)
        do {
            try await store.saveBeforeDispatch(fixture(draft: "different body for the same operation"))
            XCTFail("A server operation ID cannot acquire a second body")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .operationConflict)
        }
        let recovered = try await store.load(serverIdentity: original.serverIdentity, target: original.target,
                                             operationID: original.operation.operationID)
        XCTAssertEqual(recovered, original)
    }

    func testIndependentStoreActorsCannotReplaceSameOperationConcurrently() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let firstStore = try makeStore(files: files, vault: vault, root: root)
        let secondStore = try makeStore(files: files, vault: vault, root: root)
        let first = fixture(operationID: "shared-server-operation", draft: "First authorized body")
        let second = fixture(operationID: "shared-server-operation", draft: "Second unauthorized body")
        files.armTwoMissingReadBarrier()

        async let firstResult = captureSave(firstStore, first, isFirst: true)
        async let secondResult = captureSave(secondStore, second, isFirst: false)
        let outcomes = await (firstResult, secondResult)
        XCTAssertFalse(files.barrierTimedOut, "Both independent actors should reach the missing-file barrier")
        let exactlyFirstWon = outcomes.0 == .firstStored && outcomes.1 == .secondConflict
        let exactlySecondWon = outcomes.0 == .firstConflict && outcomes.1 == .secondStored
        XCTAssertTrue(exactlyFirstWon || exactlySecondWon)
        let firstWon = exactlyFirstWon
        let winner = firstWon ? first : second
        let loser = firstWon ? second : first
        let recovered = try await secondStore.load(serverIdentity: winner.serverIdentity, target: winner.target,
                                                   operationID: winner.operation.operationID)
        XCTAssertEqual(recovered, winner)
        do {
            try await firstStore.saveBeforeDispatch(loser)
            XCTFail("A later retry must not replace the atomically installed operation")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .operationConflict)
        }
        let stillWinner = try await firstStore.load(serverIdentity: winner.serverIdentity, target: winner.target,
                                                    operationID: winner.operation.operationID)
        XCTAssertEqual(stillWinner, winner)
    }

    func testSameOperationSamePayloadIsIdempotentAcrossStoreActors() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let firstStore = try makeStore(files: files, vault: vault, root: root)
        let secondStore = try makeStore(files: files, vault: vault, root: root)
        let record = fixture(operationID: "idempotent-operation")
        files.armTwoMissingReadBarrier()
        async let firstResult = captureSave(firstStore, record, isFirst: true)
        async let secondResult = captureSave(secondStore, record, isFirst: false)
        let outcomes = await (firstResult, secondResult)
        XCTAssertFalse(files.barrierTimedOut, "Both independent actors should reach the idempotent-write barrier")
        XCTAssertEqual(outcomes.0, .firstStored)
        XCTAssertEqual(outcomes.1, .secondStored)
        XCTAssertEqual(files.values.count, 1)
        let recovered = try await secondStore.load(serverIdentity: record.serverIdentity, target: record.target,
                                                   operationID: record.operation.operationID)
        XCTAssertEqual(recovered, record)
    }

    func testProtectedFileAdapterUsesAtomicNoReplaceOnOwnedTemporaryFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("partition").appendingPathComponent("operation.nmcr")
        let firstAdapter = ProtectedNativeMemoryCorrectionRecoveryFileAccess()
        let secondAdapter = ProtectedNativeMemoryCorrectionRecoveryFileAccess()
        let first = Data(repeating: 0xa1, count: 256 * 1024)
        let second = Data(repeating: 0xb2, count: 256 * 1024)

        async let firstInstalled = Task.detached {
            try firstAdapter.installAtomicallyIfAbsent(first, to: destination)
        }.value
        async let secondInstalled = Task.detached {
            try secondAdapter.installAtomicallyIfAbsent(second, to: destination)
        }.value
        let outcomes = try await (firstInstalled, secondInstalled)
        XCTAssertNotEqual(outcomes.0, outcomes.1)
        let retained = try firstAdapter.read(destination, maximumBytes: 512 * 1024)
        XCTAssertTrue(retained == first || retained == second)
        XCTAssertTrue(FileManager.default.fileExists(atPath: destination.path))
    }

    func testCorruptAndUnknownVersionRecordsFailClosedAndRemainForEvidence() async throws {
        for unknownVersion in [false, true] {
            let files = RecoveryMemoryFiles()
            let store = try makeStore(files: files, vault: RecoveryMemoryVault())
            let record = fixture()
            try await store.saveBeforeDispatch(record)
            let path = try XCTUnwrap(files.onlyPath)
            var bytes = try XCTUnwrap(files.value(at: path))
            if unknownVersion {
                bytes.replaceSubrange(4..<5, with: [0x02])
            } else {
                bytes[bytes.count - 1] ^= 0xff
            }
            files.replace(bytes, at: path)
            do {
                try await store.saveBeforeDispatch(record)
                XCTFail("A corrupt or unknown operation file must never be replaced")
            } catch { }
            XCTAssertEqual(files.value(at: path), bytes)
            do {
                _ = try await store.load(serverIdentity: record.serverIdentity, target: record.target,
                                         operationID: record.operation.operationID)
                XCTFail("Corrupt and unknown formats must not be interpreted as empty")
            } catch let error as NativeMemoryCorrectionRecoveryError {
                XCTAssertEqual(error, unknownVersion ? .unsupportedVersion : .corruptRecord)
            }
            do {
                try await store.remove(serverIdentity: record.serverIdentity, target: record.target,
                                       operationID: record.operation.operationID,
                                       disposition: .savedWithOperationBoundReadback)
                XCTFail("A failed integrity check must preserve the evidence")
            } catch { }
            XCTAssertNotNil(files.value(at: path))
        }
    }

    func testFailedAtomicWriteDoesNotCreateAReadableOperation() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let record = fixture()
        files.failWrites = true
        do {
            try await store.saveBeforeDispatch(record)
            XCTFail("Storage failure must block dispatch")
        } catch { }
        files.failWrites = false
        let recovered = try await store.load(serverIdentity: record.serverIdentity, target: record.target,
                                             operationID: record.operation.operationID)
        XCTAssertNil(recovered)
        XCTAssertTrue(files.values.isEmpty)
    }

    func testRawBearerCannotBeStoredAsAuthorizationHandle() async throws {
        let store = try makeStore(files: RecoveryMemoryFiles(), vault: RecoveryMemoryVault())
        let record = NativeMemoryCorrectionRecoveryRecord(
            serverIdentity: "https://assistant.example/deployment/base",
            target: .init(ownerID: "owner-1", serverID: "production-west", memoryID: "memory-1", sourceIdentity: "source-1"),
            operation: .init(operationID: "server-operation-1", expectedRevision: "revision-1", expectedStoredContentHash: nil),
            snapshot: .init(revision: "revision-1", storedContentHash: nil,
                            content: "Original saved wording", sourceLabel: "Imported note",
                            ownerCorrected: false, readOnlyReason: nil),
            draft: "A reviewed correction draft",
            authorizationHandle: "never-persist-this-bearer"
        )
        do {
            try await store.saveBeforeDispatch(record)
            XCTFail("Only the purpose-bound server authorization handle may be stored")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .invalidRecord)
        }
    }

    func testOwnerServerTargetAndSourceIdentityAreBoundIndependently() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let store = try makeStore(files: files, vault: vault)
        let record = fixture()
        try await store.saveBeforeDispatch(record)
        let variants = [
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: "owner-b", serverID: record.target.serverID,
                memoryID: record.target.memoryID, sourceIdentity: record.target.sourceIdentity),
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: record.target.ownerID, serverID: record.target.serverID,
                memoryID: "memory-b", sourceIdentity: record.target.sourceIdentity),
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: record.target.ownerID, serverID: record.target.serverID,
                memoryID: record.target.memoryID, sourceIdentity: "source-b"),
        ]
        for target in variants {
            let foreign = try await store.load(serverIdentity: record.serverIdentity, target: target,
                                               operationID: record.operation.operationID)
            XCTAssertNil(foreign)
        }
        let recovered = try await store.load(serverIdentity: record.serverIdentity, target: record.target,
                                             operationID: record.operation.operationID)
        XCTAssertEqual(recovered, record)
    }

    private enum ConcurrentSaveResult: Hashable {
        case firstStored
        case secondStored
        case firstConflict
        case secondConflict
        case firstFailure
        case secondFailure
    }

    private func captureSave(
        _ store: NativeMemoryCorrectionRecoveryStore,
        _ record: NativeMemoryCorrectionRecoveryRecord,
        isFirst: Bool
    ) async -> ConcurrentSaveResult {
        do {
            try await store.saveBeforeDispatch(record)
            return isFirst ? .firstStored : .secondStored
        } catch let error as NativeMemoryCorrectionRecoveryError where error == .operationConflict {
            return isFirst ? .firstConflict : .secondConflict
        } catch {
            return isFirst ? .firstFailure : .secondFailure
        }
    }

    private func makeStore(
        files: RecoveryMemoryFiles,
        vault: RecoveryMemoryVault,
        root: URL? = nil
    ) throws -> NativeMemoryCorrectionRecoveryStore {
        try NativeMemoryCorrectionRecoveryStore(
            applicationSupportRoot: root ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString),
            keyVault: vault,
            files: files
        )
    }

    private func fixture(
        operationID: String = "server-issued-operation-1",
        draft: String = "A reviewed correction draft",
        ownerID: String = "owner-1"
    ) -> NativeMemoryCorrectionRecoveryRecord {
        NativeMemoryCorrectionRecoveryRecord(
            serverIdentity: "https://assistant.example/deployment/base",
            target: .init(ownerID: ownerID, serverID: "production-west", memoryID: "memory-1", sourceIdentity: "source-1"),
            operation: .init(operationID: operationID, expectedRevision: "source-revision-7",
                             expectedStoredContentHash: String(repeating: "a", count: 64)),
            snapshot: .init(revision: "source-revision-7", storedContentHash: String(repeating: "a", count: 64),
                            content: "Original saved wording", sourceLabel: "Imported note",
                            ownerCorrected: true, readOnlyReason: nil),
            draft: draft,
            authorizationHandle: "omc1.c2VydmVyLWlzc3VlZC1jbGFpbXM.c2lnbmF0dXJl"
        )
    }
}

private final class RecoveryMemoryVault: CardFormDraftKeyVault, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: SymmetricKey] = [:]
    private var closed = Set<String>()

    func assertOpen(partition: String) throws {
        try lock.withLock {
            if closed.contains(partition) { throw EncryptedCardFormDraftStorageError.partitionClosed }
        }
    }

    func key(for partition: String, createIfMissing: Bool) throws -> SymmetricKey {
        try lock.withLock {
            if closed.contains(partition) { throw EncryptedCardFormDraftStorageError.partitionClosed }
            if let key = keys[partition] { return key }
            guard createIfMissing else { throw EncryptedCardFormDraftStorageError.keyUnavailable }
            let key = SymmetricKey(size: .bits256)
            keys[partition] = key
            return key
        }
    }

    func close(partition: String) throws {
        lock.withLock {
            keys.removeValue(forKey: partition)
            closed.insert(partition)
        }
    }
}

private final class RecoveryMemoryFiles: NativeMemoryCorrectionRecoveryFileAccess, @unchecked Sendable {
    private let lock = NSCondition()
    private var storage: [String: Data] = [:]
    var failWrites = false
    private var blockTwoMissingReads = false
    private var missingReadCount = 0
    private var didTimeOutBarrier = false

    var barrierTimedOut: Bool { lock.withLock { didTimeOutBarrier } }

    func armTwoMissingReadBarrier() {
        lock.withLock {
            blockTwoMissingReads = true
            missingReadCount = 0
            didTimeOutBarrier = false
        }
    }

    var values: [Data] { lock.withLock { Array(storage.values) } }
    var onlyValue: Data? { lock.withLock { storage.count == 1 ? storage.values.first : nil } }
    var onlyPath: String? { lock.withLock { storage.count == 1 ? storage.keys.first : nil } }
    func value(at path: String) -> Data? { lock.withLock { storage[path] } }
    func replace(_ data: Data, at path: String) { lock.withLock { storage[path] = data } }
    func exists(_ url: URL) -> Bool {
        lock.lock()
        let missing = storage[url.path] == nil
        if missing && blockTwoMissingReads {
            missingReadCount += 1
            if missingReadCount == 2 {
                blockTwoMissingReads = false
                lock.broadcast()
            } else {
                let deadline = Date(timeIntervalSinceNow: 5)
                while blockTwoMissingReads {
                    if !lock.wait(until: deadline) {
                        didTimeOutBarrier = true
                        blockTwoMissingReads = false
                        lock.broadcast()
                    }
                }
            }
        }
        lock.unlock()
        return !missing
    }

    func read(_ url: URL, maximumBytes: Int) throws -> Data {
        try lock.withLock {
            guard let data = storage[url.path], data.count <= maximumBytes else {
                throw NativeMemoryCorrectionRecoveryError.corruptRecord
            }
            return data
        }
    }

    func writeAtomically(_ data: Data, to url: URL) throws {
        try lock.withLock {
            if failWrites { throw EncryptedCardFormDraftStorageError.writeFailed }
            storage[url.path] = data
        }
    }

    func installAtomicallyIfAbsent(_ data: Data, to url: URL) throws -> Bool {
        try lock.withLock {
            if failWrites { throw EncryptedCardFormDraftStorageError.writeFailed }
            guard storage[url.path] == nil else { return false }
            storage[url.path] = data
            return true
        }
    }

    func removeFile(_ url: URL) throws { _ = lock.withLock { storage.removeValue(forKey: url.path) } }
    func removePartition(_ url: URL) throws {
        lock.withLock { storage = storage.filter { !$0.key.hasPrefix(url.path + "/") } }
    }
}
